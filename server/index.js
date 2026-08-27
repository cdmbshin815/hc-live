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
import { derivePools, generateRundown, weekCoverage } from './schedule.js';

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

/* ── 편성 블록 · 자동 채움 · 생성 ────────────────── */
const DOW = ['월', '화', '수', '목', '금', '토', '일'];
const todayInfo = () => {
  const d = new Date();
  const dow = (d.getDay() + 6) % 7;                     // 월=0
  const dateStr = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString().slice(0, 10);
  return { dow, dateStr };
};

app.get('/api/pools', (_req, res) => res.json(
  derivePools(store.get('library')).map(({ items, ...p }) => p)));

app.get('/api/blocks', (_req, res) => res.json({
  blocks: store.get('blocks') || [],
  autofill: store.get('autofill') || { enabled: false, poolIds: [], order: 'random' },
  coverage: weekCoverage(store.get('blocks') || [], todayInfo().dateStr),
}));

app.post('/api/blocks', (req, res) => {
  if (Array.isArray(req.body.blocks)) store.set('blocks', req.body.blocks);
  if (req.body.autofill) store.set('autofill', req.body.autofill);
  const payload = {
    blocks: store.get('blocks') || [],
    autofill: store.get('autofill'),
    coverage: weekCoverage(store.get('blocks') || [], todayInfo().dateStr),
  };
  broadcast({ type: 'blocks', ...payload });
  res.json(payload);
});

app.post('/api/rundown/generate', (req, res) => {
  const { dow, dateStr } = todayInfo();
  const day = Number.isInteger(req.body?.dow) ? req.body.dow : dow;
  const { items, gaps, coverageMs } = generateRundown({
    blocks: store.get('blocks') || [],
    autofill: store.get('autofill') || { enabled: false, poolIds: [] },
    library: store.get('library'),
    playlog: store.get('playlog') || {},
    dow: day,
    dateStr: req.body?.dateStr || dateStr,
  });
  // 짧은 소재로 자동 채움을 돌리면 항목 수가 폭증한다(11초 클립 기준 하루 6천여 개).
  // 기획서 §5.4 의 "하루 150~300개" 가정은 장편 콘텐츠 기준이다. 넘어가면 알린다.
  const warning = items.length > 1000
    ? `항목이 ${items.length}개입니다. 자동 채움 소재가 짧으면 런다운이 커져 화면과 전송이 무거워집니다.`
    : null;

  const rd = { id: 'r1', dow: day, items, gaps, generatedAt: Date.now() };
  store.set('rundown', rd);
  const full = withSchedule(rd);
  const w = pushWindow(true);
  res.json({ ...full, gaps, coverageMs, dowLabel: DOW[day], warning,
             windowItems: w.items.length });
});

/* ── 런다운 ──────────────────────────────────────── */
// 시작 시각은 서버가 계산해 내려준다. 출력창은 계산하지 않는다.
//
// 고정 시각 마커 3종을 여기서 적용한다 (§3.5.4).
//   hard      — 그 시각이 되면 재생 중인 항목을 끊고 시작 (앞 항목이 잘린다)
//   soft      — 앞 항목이 끝나기를 기다렸다가 시작 (밀림을 허용)
//   notBefore — 그 시각 전에는 시작하지 않음 (일찍 끝나면 공백)
function withSchedule(rundown) {
  let cur = 0;
  const items = (rundown.items || []).map(it => {
    const inMs = it.trimInMs ?? 0;
    const outMs = it.trimOutMs ?? it.durationMs;
    const len = Math.max(0, outMs - inMs);

    let start = cur, gapMs = 0, cutMs = 0, pushMs = 0;
    const f = it.fixedAt;
    if (it.timing && it.timing !== 'none' && f != null) {
      if (it.timing === 'hard') {
        if (cur > f) cutMs = cur - f; else if (cur < f) gapMs = f - cur;
        start = f;
      } else if (it.timing === 'soft') {
        if (cur > f) { pushMs = cur - f; start = cur; } else { gapMs = f - cur; start = f; }
      } else {                                   // notBefore
        if (cur < f) { gapMs = f - cur; start = f; } else start = cur;
      }
    }
    cur = start + len;
    return { ...it, startMs: start, endMs: cur, gapMs, cutMs, pushMs };
  });

  // Hard 마커에 잘리는 앞 항목은 실제로 잘라서 내려보낸다.
  // 출력창이 "언제 끊을지"를 다시 판단하게 두면 서버와 답이 갈릴 수 있다.
  for (let i = 1; i < items.length; i++) {
    if (items[i].cutMs > 0) {
      const prev = items[i - 1];
      const inMs = prev.trimInMs ?? 0;
      prev.trimOutMs = Math.max(inMs + 500, (prev.trimOutMs ?? prev.durationMs) - items[i].cutMs);
      prev.endMs = items[i].startMs;
      prev.trimmedByHard = items[i].cutMs;
    }
  }

  const totalMs = items.length ? items[items.length - 1].endMs : 0;
  const issues = items.reduce((n, x) => n + (x.gapMs > 500 ? 1 : 0) + (x.cutMs > 500 ? 1 : 0), 0);
  return { ...rundown, items, totalMs, issues };
}

app.get('/api/rundown', (_req, res) => res.json(withSchedule(store.get('rundown'))));
app.post('/api/rundown', (req, res) => {
  const rd = { id: req.body.id || 'r1', items: Array.isArray(req.body.items) ? req.body.items : [] };
  store.set('rundown', rd);
  const full = withSchedule(rd);
  pushWindow(true);
  res.json(full);
});

/* ── 롤링 윈도우 ─────────────────────────────────── */
// 하루치 런다운은 서버가 통째로 들고 있되(생성 29ms, 결정적), 출력창에는 지금 필요한
// 구간만 보낸다. 24시간 채널의 출력창에 필요한 것은 앞으로의 몇십 분뿐이고,
// 6천 항목·2.2MB 를 매번 실어 나를 이유가 없다 (기획서 §5.4 실측).
//
// 슬라이스를 쓰고 구간별로 새로 생성하지 않는 이유: 블록 안의 재생 순서는 블록 시작부터
// 누적되므로, 중간부터 생성하면 하루치로 생성했을 때와 다른 편성이 나온다.
const WINDOW_BACK_MS = 60_000;          // 이미 지난 항목도 조금 남긴다 (재접속 대비)
const WINDOW_AHEAD_MS = 20 * 60_000;    // 앞으로 20분
const WINDOW_TICK_MS = 20_000;

function nowMsOfDay(d = new Date()) {
  return ((d.getHours() * 60 + d.getMinutes()) * 60 + d.getSeconds()) * 1000 + d.getMilliseconds();
}

function currentWindow() {
  const full = withSchedule(store.get('rundown'));
  const t = nowMsOfDay();
  const from = t - WINDOW_BACK_MS, to = t + WINDOW_AHEAD_MS;
  const items = full.items.filter(i => i.endMs > from && i.startMs < to);
  return {
    ...full, items,
    nowMs: t, windowFrom: from, windowTo: to,
    totalItems: full.items.length,
  };
}

let lastWindowKey = '';
function pushWindow(force = false) {
  const w = currentWindow();
  const key = w.items.map(i => i.key || i.id).join('|');
  if (!force && key === lastWindowKey) return w;
  lastWindowKey = key;
  broadcast({ type: 'rundown', rundown: w });
  return w;
}
setInterval(() => { if (store.get('rundown')?.items?.length) pushWindow(); }, WINDOW_TICK_MS);

app.get('/api/window', (_req, res) => res.json(currentWindow()));

/* ── 텔레메트리 (전환 품질 기록) ─────────────────── */
// 2단계 완료 기준이 "검은 프레임 0" 이므로, 전환마다 실측값을 남긴다.
const seams = [];
const heap = [];
app.get('/api/heap', (_req, res) => res.json(heap));
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
    rundown: currentWindow(),
    library: store.get('library'),
    seams,
  }));

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'seam') {
      seams.unshift({ ...m.seam, at: Date.now() });
      if (seams.length > 200) seams.pop();
      broadcast({ type: 'seam', seam: seams[0] });
    } else if (m.type === 'play') {
      // '미방영 우선' 순서를 계산하려면 무엇이 언제 나갔는지 알아야 한다.
      const log = store.get('playlog') || {};
      if (m.itemId) { log[m.itemId] = Date.now(); store.set('playlog', log); }
    } else if (m.type === 'state') {
      // 장시간 운영에서 메모리가 새는지 보려면 추이를 남겨야 한다 (§9 리스크 4).
      if (m.state?.heapMB != null) {
        heap.push({ at: Date.now(), mb: m.state.heapMB, items: m.state.total ?? 0 });
        if (heap.length > 2000) heap.shift();
      }
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
