// HC LIVE 로컬 서버 — 진실의 원천.
// 라이브러리·런다운을 보관하고, 출력창에 WebSocket 으로 지시를 브로드캐스트한다.
// 출력창은 판단하지 않고 지시받은 것을 재생한다 (기획서 §5.3).
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store, newChannel } from './store.js';
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

/* ── 채널 ────────────────────────────────────────── */
// 라이브러리는 공유, 편성·런다운·출력은 채널마다 독립 (기획서 §3.3).
function channels() { return store.get('channels') || []; }
function ch(id) { return channels().find(c => c.id === id) || null; }
function saveChannels(list) { store.set('channels', list); return list; }

// 단일 런다운 시절의 데이터를 채널 1로 옮긴다.
(function migrate() {
  if (channels().length) return;
  const c = newChannel('c1', '채널 1');
  const legacyBlocks = store.get('blocks');
  const legacyAuto = store.get('autofill');
  const legacyRd = store.get('rundown');
  if (Array.isArray(legacyBlocks) && legacyBlocks.length) c.blocks = legacyBlocks;
  if (legacyAuto) c.autofill = legacyAuto;
  if (legacyRd?.items?.length) c.rundown = legacyRd;
  saveChannels([c]);
  console.log('[server] 단일 런다운 → 채널 1 로 이관');
})();

app.get('/api/channels', (_req, res) => res.json(channels().map(c => ({
  id: c.id, name: c.name, master: c.master,
  blockCount: c.blocks.length,
  rundownItems: c.rundown?.items?.length || 0,
  autofill: c.autofill,
  outputs: c.outputs || [],
  coverage: weekCoverage(c.blocks, todayInfo().dateStr),
}))));

app.post('/api/channels', (req, res) => {
  const name = String(req.body?.name || '').trim() || `채널 ${channels().length + 1}`;
  const id = 'c' + Math.random().toString(36).slice(2, 8);
  const list = [...channels(), newChannel(id, name)];
  saveChannels(list);
  broadcast({ type: 'channels' });
  res.json({ id, name });
});

app.delete('/api/channels/:id', (req, res) => {
  if (channels().length <= 1) return res.status(400).json({ error: '채널은 최소 하나 필요합니다' });
  saveChannels(channels().filter(c => c.id !== req.params.id));
  broadcast({ type: 'channels' });
  res.json({ ok: true });
});

/* ── 출력 (§3.7 · §4.4) ──────────────────────────── */
// 모니터는 전역 자원, 출력은 채널 소유. 모니터 1대에는 출력 1개만 들어간다.
const MAX_MONITOR_OUT = 4;

function allOutputs() {
  return channels().flatMap(c => (c.outputs || []).map(o => ({ o, c })));
}

app.get('/api/outputs', (_req, res) => res.json({
  outputs: allOutputs().map(({ o, c }) => ({ ...o, channelId: c.id, channelName: c.name })),
  monitorUsed: allOutputs().filter(x => x.o.type === 'monitor').length,
  monitorMax: MAX_MONITOR_OUT,
}));

app.post('/api/channels/:id/outputs', (req, res) => {
  const list = channels();
  const c = list.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '없는 채널' });
  const b = req.body || {};

  if (b.type === 'monitor') {
    const used = allOutputs().filter(x => x.o.type === 'monitor');
    const owner = used.find(x => String(x.o.displayId) === String(b.displayId));

    // 소유권 확인이 상한 검사보다 먼저다. 이미 쓰이는 모니터를 가져오는 것은
    // 총 개수를 늘리지 않으므로 상한에 걸려서는 안 된다.
    if (owner && owner.c.id !== c.id) {
      // 다른 채널이 쓰는 모니터는 조용히 뺏지 않는다 (§4.4.2).
      if (!b.takeover) return res.status(409).json({ error: '다른 채널이 사용 중', owner: owner.c.name });
      owner.c.outputs = owner.c.outputs.filter(o => o.id !== owner.o.id);
    } else if (!owner && used.length >= MAX_MONITOR_OUT) {
      return res.status(400).json({ error: `모니터 출력은 최대 ${MAX_MONITOR_OUT}개입니다` });
    }
  }

  const out = {
    id: 'o' + Math.random().toString(36).slice(2, 8),
    type: b.type || 'monitor',
    displayId: b.displayId ?? null,
    w: b.w || 1920, h: b.h || 1080,
    scale: b.scale || 'fit',
    // 채널당 정확히 하나만 소리를 낸다 (§3.4). 첫 출력이 자동으로 담당한다.
    audio: !(c.outputs || []).length,
    device: b.device || '시스템 기본',
    state: 'stopped',
  };
  c.outputs = [...(c.outputs || []), out];
  saveChannels(list);
  broadcast({ type: 'outputs' });
  res.json(out);
});

app.patch('/api/channels/:id/outputs/:oid', (req, res) => {
  const list = channels();
  const c = list.find(x => x.id === req.params.id);
  const o = c?.outputs?.find(x => x.id === req.params.oid);
  if (!o) return res.status(404).json({ error: '없는 출력' });
  for (const k of ['w', 'h', 'scale', 'device', 'displayId']) if (k in req.body) o[k] = req.body[k];
  // 오디오는 라디오 버튼처럼 동작한다 — 켜면 같은 채널의 나머지는 자동 음소거.
  if (req.body.audio === true) c.outputs.forEach(x => (x.audio = x.id === o.id));
  saveChannels(list);
  broadcast({ type: 'outputs' });
  res.json(o);
});

app.delete('/api/channels/:id/outputs/:oid', (req, res) => {
  const list = channels();
  const c = list.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '없는 채널' });
  const gone = c.outputs.find(x => x.id === req.params.oid);
  c.outputs = c.outputs.filter(x => x.id !== req.params.oid);
  // 오디오 담당이 사라지면 다음 출력이 승계한다 (§3.4).
  if (gone?.audio && c.outputs.length) c.outputs[0].audio = true;
  saveChannels(list);
  broadcast({ type: 'outputs' });
  res.json({ ok: true });
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

app.get('/api/channels/:id/blocks', (req, res) => {
  const c = ch(req.params.id);
  if (!c) return res.status(404).json({ error: '없는 채널' });
  res.json({ blocks: c.blocks, autofill: c.autofill,
             coverage: weekCoverage(c.blocks, todayInfo().dateStr) });
});

app.post('/api/channels/:id/blocks', (req, res) => {
  const list = channels();
  const c = list.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '없는 채널' });
  if (Array.isArray(req.body.blocks)) c.blocks = req.body.blocks;
  if (req.body.autofill) c.autofill = req.body.autofill;
  saveChannels(list);
  const payload = { channelId: c.id, blocks: c.blocks, autofill: c.autofill,
                    coverage: weekCoverage(c.blocks, todayInfo().dateStr) };
  broadcast({ type: 'blocks', ...payload });
  res.json(payload);
});

app.post('/api/channels/:id/rundown/generate', (req, res) => {
  const list = channels();
  const c = list.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '없는 채널' });
  const { dow, dateStr } = todayInfo();
  const day = Number.isInteger(req.body?.dow) ? req.body.dow : dow;
  const { items, gaps, coverageMs } = generateRundown({
    blocks: c.blocks,
    autofill: c.autofill || { enabled: false, poolIds: [] },
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

  c.rundown = { id: 'rd_' + c.id, dow: day, items, gaps, generatedAt: Date.now() };
  saveChannels(list);
  const full = withSchedule(c.rundown);
  const w = pushWindow(c.id, true);
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

app.get('/api/channels/:id/rundown', (req, res) => {
  const c = ch(req.params.id);
  if (!c) return res.status(404).json({ error: '없는 채널' });
  res.json(withSchedule(c.rundown || { items: [] }));
});

/**
 * 항목 하나를 옮긴다.
 *
 * 재정렬 때마다 하루치 전체를 올리면 안 된다 — 7,680 항목이면 2.2MB 라
 * 본문 한계를 넘어 413 이 나고, 화면만 바뀐 채 서버에는 반영되지 않는다.
 * 옮긴 사실만 보내고 계산은 서버가 한다.
 */
app.post('/api/channels/:id/rundown/move', (req, res) => {
  const list = channels();
  const c = list.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '없는 채널' });
  const arr = c.rundown?.items || [];
  const from = arr.findIndex(x => (x.key ?? x.id) === req.body?.fromKey);
  let to = Number(req.body?.toIndex);
  if (from < 0 || !Number.isInteger(to)) return res.status(400).json({ error: '잘못된 이동' });
  to = Math.max(0, Math.min(arr.length - 1, to > from ? to - 1 : to));
  if (to === from) return res.json(withSchedule(c.rundown));
  arr.splice(to, 0, arr.splice(from, 1)[0]);
  saveChannels(list);
  const full = withSchedule(c.rundown);
  pushWindow(c.id, true);
  res.json(full);
});

app.post('/api/channels/:id/rundown', (req, res) => {
  const list = channels();
  const c = list.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '없는 채널' });
  c.rundown = { id: 'rd_' + c.id, items: Array.isArray(req.body.items) ? req.body.items : [] };
  saveChannels(list);
  const full = withSchedule(c.rundown);
  pushWindow(c.id, true);
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

function currentWindow(channelId) {
  const c = ch(channelId);
  const full = withSchedule(c?.rundown || { items: [] });
  const t = nowMsOfDay();
  const from = t - WINDOW_BACK_MS, to = t + WINDOW_AHEAD_MS;
  const items = full.items.filter(i => i.endMs > from && i.startMs < to);
  return {
    ...full, items, channelId,
    nowMs: t, windowFrom: from, windowTo: to,
    totalItems: full.items.length,
  };
}

const lastWindowKey = new Map();
function pushWindow(channelId, force = false) {
  const w = currentWindow(channelId);
  const key = w.items.map(i => i.key || i.id).join('|');
  if (!force && key === lastWindowKey.get(channelId)) return w;
  lastWindowKey.set(channelId, key);
  broadcast({ type: 'rundown', channelId, rundown: w }, channelId);
  return w;
}
setInterval(() => {
  for (const c of channels()) if (c.rundown?.items?.length) pushWindow(c.id);
}, WINDOW_TICK_MS);

app.get('/api/channels/:id/window', (req, res) => res.json(currentWindow(req.params.id)));

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

// channelId 를 주면 그 채널의 출력창과 관리 화면(채널 미지정 클라이언트)에만 보낸다.
// 채널 2의 편성이 채널 1 출력창에 흘러가면 안 된다.
function broadcast(msg, channelId = null) {
  const s = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState !== 1) continue;
    if (channelId && ws.channelId && ws.channelId !== channelId) continue;
    ws.send(s);
  }
}

wss.on('connection', (ws, req) => {
  // 출력창은 /ws?ch=c1 로 붙는다. 관리 화면은 채널을 지정하지 않고 전체를 받는다.
  let cid = null;
  try { cid = new URL(req.url, 'http://x').searchParams.get('ch'); } catch {}
  ws.channelId = cid;
  clients.add(ws);
  ws.send(JSON.stringify({
    type: 'hello',
    channelId: cid,
    rundown: currentWindow(cid || channels()[0]?.id),
    channels: channels().map(c => ({ id: c.id, name: c.name })),
    library: store.get('library'),
    seams,
  }));

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'seam') {
      seams.unshift({ ...m.seam, channelId: ws.channelId || null, at: Date.now() });
      if (seams.length > 200) seams.pop();
      broadcast({ type: 'seam', seam: seams[0] });
    } else if (m.type === 'play') {
      // '미방영 우선' 순서를 계산하려면 무엇이 언제 나갔는지 알아야 한다.
      const log = store.get('playlog') || {};
      if (m.itemId) { log[m.itemId] = Date.now(); store.set('playlog', log); }
    } else if (m.type === 'state') {
      // 장시간 운영에서 메모리가 새는지 보려면 추이를 남겨야 한다 (§9 리스크 4).
      if (m.state?.heapMB != null) {
        heap.push({ at: Date.now(), mb: m.state.heapMB, items: m.state.total ?? 0,
                    channelId: ws.channelId || null, viewport: m.state.viewport?.px || null });
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
/**
 * 비어 있는 포트를 찾는다.
 *
 * listen() 의 실패에 기대지 않는 이유: Node 는 이 경로에서 EADDRINUSE 를
 * **비동기 콜백 안에서 동기 throw** 한다. 그래서 server.on('error') 로도,
 * Promise executor 의 try/catch 로도 잡히지 않고 uncaughtException 으로 튄다.
 * 실제로 Electron 이 이 때문에 창을 하나도 못 열고 로그 한 줄만 남긴 적이 있다.
 *
 * 대신 접속을 시도해 본다 — 연결되면 누가 듣고 있는 것이고, 거절되면 비어 있다.
 */
function portInUse(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const sock = net.connect({ port, host });
    const done = v => { sock.destroy(); resolve(v); };
    sock.setTimeout(500);
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.once('timeout', () => done(false));
  });
}

export async function startServer(portBase = PORT_BASE, tries = 12) {
  let port = portBase;
  for (let i = 0; i < tries; i++) {
    if (!(await portInUse(port))) break;
    console.log(`[server] 포트 ${port} 사용 중 → ${port + 1} 시도`);
    port += 1;
    if (i === tries - 1) throw new Error(`빈 포트를 찾지 못했습니다 (${portBase}~${port})`);
  }

  await new Promise((resolve, reject) => {
    const onError = err => { server.off('listening', onListening); reject(err); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });

  console.log(`\n  HC LIVE  http://127.0.0.1:${port}`);
  console.log(`  관리        http://127.0.0.1:${port}/admin/`);
  console.log(`  출력창      http://127.0.0.1:${port}/output/\n`);
  const items = await scanLibrary();
  console.log(`  라이브러리 ${items.length}개 스캔 완료`);
  broadcast({ type: 'library', items });
  return port;
}

// 직접 실행했을 때만 스스로 기동한다 (Electron 은 startServer 를 직접 부른다).
const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) startServer().catch(e => { console.error('[server]', e); process.exit(1); });
