// 출력창 — 서버 지시를 받아 재생만 한다. 판단하지 않는다(기획서 §5.3).
import { SeamlessEngine } from '/shared/engine.js';

const stage   = document.getElementById('stage');
const standby = document.getElementById('standby');
const gate    = document.getElementById('gate');
const dbg     = document.getElementById('dbg');

let ws, rundown = { items: [] }, started = false, lastSeam = null, lastState = null;

// 앱 안(Electron)에서는 자동재생 제한이 없으므로 클릭 없이 바로 시작한다.
// 무인 운영에서 사람이 버튼을 눌러줘야 한다면 그건 무인이 아니다.
const AUTO = !!window.hc?.isElectron || new URLSearchParams(location.search).has('autostart');
// 이 출력창이 담당하는 채널. 서버는 이 채널의 편성만 보낸다 (기획서 §3.3).
const CHANNEL = new URLSearchParams(location.search).get('ch') || '';

const engine = new SeamlessEngine(stage, {
  onSeam(seam) {
    lastSeam = seam;
    send({ type: 'seam', seam });
    if (seam.suspect) console.warn('[output] 전환 간극 의심:', seam);
  },
  onState(state) {
    lastState = state;
    standby.classList.toggle('hide', state.status === 'playing');
    // 캡처가 제대로 되려면 출력창의 실제 픽셀 수가 의도한 해상도와 같아야 한다.
    // 논리 크기만 맞고 devicePixelRatio 가 1이 아니면 캡처 해상도가 어긋난다 (§9 리스크 3).
    send({ type: 'state', role: 'output', channel: CHANNEL, state: { ...state,
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio,
                  px: Math.round(innerWidth * devicePixelRatio) + '×' +
                      Math.round(innerHeight * devicePixelRatio) } } });
  },
});

/* ── 서버 연결 ───────────────────────────────────── */
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws${CHANNEL ? '?ch=' + encodeURIComponent(CHANNEL) : ''}`);
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.type === 'hello' || m.type === 'rundown') applyRundown(m.rundown);
  };
  ws.onclose = () => setTimeout(connect, 1000);   // 서버가 잠깐 꺼져도 스스로 복귀
  ws.onerror = () => { try { ws.close(); } catch {} };
}
function send(msg) { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); }

function applyRundown(rd) {
  if (!rd) return;
  rundown = rd;

  if (started) {
    // 롤링 윈도우는 20초마다 목록을 갈아끼운다. 재생을 끊지 않고 목록만 교체한다.
    engine.update(rd.items || []);
    if (!rd.items?.length) { engine.stop(); standby.classList.remove('hide'); }
    return;
  }

  engine.load(rd.items || []);
  if (AUTO && rd.items?.length) {
    started = true;
    gate.classList.add('gone');
    // 24시간 채널은 지금 나가야 할 지점부터 나간다.
    if (rd.nowMs != null) engine.startAt(rd.nowMs); else engine.start(0);
  }
}

/* ── 조작 ────────────────────────────────────────── */
document.getElementById('startBtn').onclick = async () => {
  gate.classList.add('gone');
  started = true;
  if (rundown.items?.length) {
    if (rundown.nowMs != null) await engine.startAt(rundown.nowMs);
    else await engine.start(0);
  }
};

addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if (k === 'd') dbg.hidden = !dbg.hidden;
  if (k === 'f') {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  }
  if (k === 'n') engine.skip();
});

/* ── 디버그 오버레이 ─────────────────────────────── */
const fmt = s => {
  s = Math.max(0, s);
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(Math.floor(s % 60)).padStart(2, '0');
};
setInterval(() => {
  if (dbg.hidden) return;
  const cur = engine.current, v = engine.active;
  const endS = cur ? (cur.trimOutMs ?? cur.durationMs) / 1000 : 0;
  dbg.innerHTML =
    `<b>ON AIR</b>  ${cur ? cur.title : '대기 화면 (로고)'}\n` +
    `시간      ${fmt(v?.currentTime || 0)} / ${fmt(endS)}   남음 ${fmt(endS - (v?.currentTime || 0))}\n` +
    `다음      ${engine.next?.title ?? '—'}\n` +
    `대기레이어 readyState=${engine.standby?.readyState ?? 0}` +
      `${engine.standby?.readyState >= 2 ? ' (준비됨)' : ' <span class="warn">(준비 안 됨)</span>'}\n` +
    `항목      ${engine.index + 1} / ${engine.items.length}\n` +
    (lastSeam
      ? `마지막 전환 ${lastSeam.from} → ${lastSeam.to}\n` +
        `          간극 ${lastSeam.presentGapMs}ms` +
        `${lastSeam.suspect ? ' <span class="warn">의심</span>' : ' 정상'}`
      : '전환      아직 없음');
}, 250);

connect();
