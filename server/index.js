// Live Player 로컬 서버 — 진실의 원천.
// 라이브러리·런다운을 보관하고, 출력창에 WebSocket 으로 지시를 브로드캐스트한다.
// 출력창은 판단하지 않고 지시받은 것을 재생한다 (기획서 §5.3).
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from './store.js';
import * as localSource from './sources/local.js';
import * as cloudflare from './sources/cloudflare.js';
import * as bunny from './sources/bunny.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEDIA_ROOT = path.join(ROOT, 'media');
const PORT_BASE = Number(process.env.PORT) || 4200;

const store = new Store(path.join(ROOT, 'data', 'db.json'));
const app = express();
app.use(express.json({ limit: '2mb' }));

/* ── 정적 자원 ───────────────────────────────────── */
app.use('/shared', express.static(path.join(ROOT, 'public', 'shared')));
app.use('/output', express.static(path.join(ROOT, 'public', 'output')));
app.use('/admin',  express.static(path.join(ROOT, 'public', 'admin')));
// hls.js — Cloudflare Stream·Bunny Stream 재생용. 오프라인에서도 동작해야 하므로 CDN 을 쓰지 않는다.
app.use('/vendor', express.static(path.join(ROOT, 'node_modules', 'hls.js', 'dist')));
app.get('/', (_req, res) => res.redirect('/admin/'));

/* ── 미디어 스트리밍 (Range 지원) ────────────────── */
// sendFile 이 Range·ETag·조건부 요청을 처리한다. root 를 고정해 디렉터리 탈출을 막는다.
app.get('/media/*', (req, res) => {
  const rel = decodeURIComponent(req.params[0] || '');
  if (!rel || rel.includes('\0')) return res.status(400).end();
  res.sendFile(rel, { root: MEDIA_ROOT, dotfiles: 'deny' }, err => {
    if (err && !res.headersSent) res.status(err.status || 404).end();
  });
});

/* ── 라이브러리 ──────────────────────────────────── */
// 소스 어댑터 레이어 — 출처가 달라도 편성기와 엔진은 같은 Item 만 본다 (기획서 §3.1).
const creds = new Store(path.join(ROOT, 'data', 'credentials.json'));

async function scanLibrary() {
  const prev = store.get('library');
  const items = await localSource.scan(MEDIA_ROOT, prev.filter(i => i.isLocal));
  // 원격 소스는 sync 로 따로 채운다 — 스캔 때마다 API 를 두드리지 않는다.
  const remote = prev.filter(i => !i.isLocal);
  const all = [...items, ...remote];
  store.set('library', all);
  return all;
}

/** 원격 소스(Cloudflare·Bunny)를 다시 읽어 라이브러리에 반영한다. */
async function syncRemote(kind) {
  const cfg = creds.get(kind);
  if (!cfg) throw new Error(`${kind} 자격증명이 설정되지 않았습니다`);
  const mod = kind === 'cloudflare' ? cloudflare : bunny;
  const fetched = await mod.sync(cfg);
  const keep = store.get('library').filter(i => i.sourceType !== kind);
  const all = [...keep, ...fetched].sort((a, b) => a.title.localeCompare(b.title, 'ko'));
  store.set('library', all);
  return { count: fetched.length, items: all };
}

app.get('/api/library', async (_req, res) => res.json(store.get('library')));
app.post('/api/library/scan', async (_req, res) => {
  const items = await scanLibrary();
  broadcast({ type: 'library', items });
  res.json(items);
});

/* ── 원격 소스 자격증명 · 동기화 ─────────────────── */
// 값은 data/credentials.json 에만 저장한다 (저장소에 올라가지 않음).
// 조회할 때는 설정 여부만 돌려주고 값 자체는 절대 내보내지 않는다.
app.get('/api/sources', (_req, res) => {
  const mask = k => {
    const c = creds.get(k);
    if (!c) return { configured: false };
    return { configured: true, hint: Object.keys(c).join(', ') };
  };
  res.json({ cloudflare: mask('cloudflare'), bunny: mask('bunny') });
});

app.post('/api/sources/:kind', async (req, res) => {
  const kind = req.params.kind;
  if (kind !== 'cloudflare' && kind !== 'bunny') return res.status(400).json({ error: '알 수 없는 소스' });
  creds.set(kind, req.body || {});
  const mod = kind === 'cloudflare' ? cloudflare : bunny;
  try {
    const v = await mod.verify(creds.get(kind));
    res.json(v);
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

app.post('/api/sources/:kind/sync', async (req, res) => {
  try {
    const { count, items } = await syncRemote(req.params.kind);
    broadcast({ type: 'library', items });
    res.json({ ok: true, count });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message });
  }
});

/* ── 런다운 ──────────────────────────────────────── */
// 시작 시각은 서버가 계산해 내려준다. 출력창은 계산하지 않는다.
function withSchedule(rundown) {
  let cur = 0;
  const items = rundown.items.map(it => {
    const dur = it.trimOutMs ?? it.durationMs;
    const inMs = it.trimInMs ?? 0;
    const row = { ...it, startMs: cur, endMs: cur + (dur - inMs) };
    cur = row.endMs;
    return row;
  });
  return { ...rundown, items, totalMs: cur };
}

app.get('/api/rundown', (_req, res) => res.json(withSchedule(store.get('rundown'))));
app.post('/api/rundown', (req, res) => {
  const rd = { id: req.body.id || 'r1', items: Array.isArray(req.body.items) ? req.body.items : [] };
  store.set('rundown', rd);
  const full = withSchedule(rd);
  broadcast({ type: 'rundown', rundown: full });
  res.json(full);
});

/* ── 텔레메트리 (전환 품질 기록) ─────────────────── */
// 2단계 완료 기준이 "검은 프레임 0" 이므로, 전환마다 실측값을 남긴다.
const seams = [];
app.get('/api/seams', (_req, res) => res.json(seams));
app.post('/api/seams/reset', (_req, res) => { seams.length = 0; broadcast({ type: 'seams', seams }); res.json([]); });

/* ── WebSocket ───────────────────────────────────── */
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set();

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const ws of clients) { if (ws.readyState === 1) ws.send(s); }
}

wss.on('connection', ws => {
  clients.add(ws);
  ws.send(JSON.stringify({
    type: 'hello',
    rundown: withSchedule(store.get('rundown')),
    library: store.get('library'),
    seams,
  }));

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'seam') {
      seams.unshift({ ...m.seam, at: Date.now() });
      if (seams.length > 200) seams.pop();
      broadcast({ type: 'seam', seam: seams[0] });
    } else if (m.type === 'state') {
      broadcast({ type: 'outputState', from: m.role || 'output', state: m.state });
    }
  });

  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

/* ── 기동 (포트 사용 중이면 다음 포트로) ─────────── */
// Electron 메인 프로세스에서도 불러 쓰므로, 실제 사용한 포트를 돌려준다.
export function startServer(portBase = PORT_BASE) {
  return new Promise((resolve, reject) => {
    let tries = 12;
    const onError = err => {
      if (err.code === 'EADDRINUSE' && tries-- > 0) {
        console.log(`[server] 포트 ${portBase} 사용 중 → ${portBase + 1} 시도`);
        portBase += 1;
        server.listen(portBase, '127.0.0.1');
      } else {
        server.off('error', onError);
        reject(err);
      }
    };
    server.on('error', onError);
    server.listen(portBase, '127.0.0.1', async () => {
      server.off('error', onError);
      console.log(`\n  Live Player  http://127.0.0.1:${portBase}`);
      console.log(`  관리        http://127.0.0.1:${portBase}/admin/`);
      console.log(`  출력창      http://127.0.0.1:${portBase}/output/\n`);
      const items = await scanLibrary();
      console.log(`  라이브러리 ${items.length}개 스캔 완료`);
      broadcast({ type: 'library', items });
      resolve(portBase);
    });
  });
}

// 직접 실행했을 때만 스스로 기동한다 (Electron 은 startServer 를 직접 부른다).
const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) startServer().catch(e => { console.error('[server]', e); process.exit(1); });
