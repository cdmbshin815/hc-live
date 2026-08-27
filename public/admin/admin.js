// 1단계 검증 하네스 — 라이브러리로 런다운을 만들고 전환 품질을 계측한다.
// 최종 관리 UI 는 docs/mockups/편성화면.html 의 설계를 따르며, 이 화면은 엔진 검증 전용이다.

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const ms = m => {
  const s = Math.round(m / 1000);
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
};

let library = [], items = [], seams = [], ws;

/* ── 서버 연결 ───────────────────────────────────── */
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => { $('conn').textContent = '연결됨'; $('conn').style.color = 'var(--ok)'; };
  ws.onclose = () => {
    $('conn').textContent = '끊김 — 재연결 중';
    $('conn').style.color = 'var(--err)';
    setTimeout(connect, 1000);
  };
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.type === 'hello') {
      library = m.library || [];
      items = m.rundown?.items || [];
      seams = m.seams || [];
      renderAll();
    }
    if (m.type === 'library') { library = m.items; renderLib(); }
    if (m.type === 'seam')    { seams.unshift(m.seam); renderSeams(); }
    if (m.type === 'seams')   { seams = m.seams; renderSeams(); }
  };
}

/* ── 라이브러리 ──────────────────────────────────── */
function renderLib() {
  const el = $('lib');
  if (!library.length) {
    el.innerHTML = '<div class="empty">영상이 없습니다.<br><br>' +
      '<code>npm run clips</code> 로 검증용 클립을 만든 뒤 스캔하세요.</div>';
    return;
  }
  el.innerHTML = library.map(i =>
    `<div class="row" data-add="${i.id}">
       <span class="t">${esc(i.title)}</span>
       ${i.status === 'error' ? '<span class="err">길이 없음</span>' : ''}
       <span class="d">${i.width}×${i.height}</span>
       <span class="d">${ms(i.durationMs)}</span>
     </div>`).join('');
  el.querySelectorAll('[data-add]').forEach(r => r.onclick = () => {
    const src = library.find(x => x.id === r.dataset.add);
    if (src) { items.push({ ...src, key: 'k' + Math.random().toString(36).slice(2, 8) }); renderRd(); }
  });
}

/* ── 런다운 ──────────────────────────────────────── */
function renderRd() {
  const el = $('rd');
  const total = items.reduce((a, b) => a + b.durationMs, 0);
  $('rdMeta').textContent = items.length ? `${items.length}개 · ${ms(total)}` : '';
  if (!items.length) { el.innerHTML = '<div class="empty">왼쪽에서 영상을 클릭해 추가하세요.</div>'; return; }
  let acc = 0;
  el.innerHTML = items.map((i, n) => {
    const at = acc; acc += i.durationMs;
    return `<div class="row">
      <span class="n">${n + 1}</span>
      <span class="d">${ms(at)}</span>
      <span class="t">${esc(i.title)}</span>
      <span class="d">${ms(i.durationMs)}</span>
      <button class="x" data-del="${i.key}">×</button>
    </div>`;
  }).join('');
  el.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    items = items.filter(x => x.key !== b.dataset.del); renderRd();
  });
}

/* ── 전환 계측 ───────────────────────────────────── */
function renderSeams() {
  // 간극은 rVFC(프레임 콜백)로 잰 것만 유효하다. 타이머 폴백값(250ms)은 계측 실패이지
  // 실제 간극이 아니므로 통계에서 제외한다 — 섞으면 숫자가 거짓말을 한다.
  const measured = seams.filter(s => s.measuredBy === 'frame');
  const gaps = measured.map(s => s.presentGapMs);
  const sus = measured.filter(s => s.suspect).length;

  $('sCount').textContent = seams.length;
  $('sSus').textContent = measured.length ? sus : '—';
  $('sSusBox').className = 'stat ' + (measured.length ? (sus ? 'bad' : 'good') : '');
  $('sAvg').textContent = gaps.length ? (gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1) : '—';
  $('sMax').textContent = gaps.length ? Math.max(...gaps).toFixed(1) : '—';
  $('sNote').textContent = seams.length && !measured.length
    ? '이 환경에서는 프레임 콜백이 스로틀되어 간극을 잴 수 없습니다. Electron 출력창에서 확인하세요.'
    : measured.length < seams.length
    ? `${seams.length}건 중 ${measured.length}건만 프레임 단위로 계측됐습니다.`
    : '';

  $('seams').innerHTML = seams.slice(0, 80).map(s => {
    const t = new Date(s.at || Date.now());
    const hh = [t.getHours(), t.getMinutes(), t.getSeconds()]
      .map(n => String(n).padStart(2, '0')).join(':');
    const framed = s.measuredBy === 'frame';
    return `<tr class="${s.suspect ? 'bad' : ''}">
      <td>${hh}</td>
      <td class="name">${esc(s.from)} → ${esc(s.to)}</td>
      <td>${framed ? s.presentGapMs + 'ms' : '<span style="color:var(--faint)">계측 불가</span>'}</td>
      <td>${esc(s.reason)}</td>
      <td><span class="pill ${framed ? (s.suspect ? 'bad' : 'ok') : ''}"
        ${framed ? '' : 'style="color:var(--faint)"'}>${framed ? (s.suspect ? '의심' : '정상') : '—'}</span></td>
    </tr>`;
  }).join('');
}

const renderAll = () => { renderLib(); renderRd(); renderSeams(); };

/* ── 조작 ────────────────────────────────────────── */
$('scan').onclick = async () => {
  $('scan').textContent = '스캔 중…';
  library = await (await fetch('/api/library/scan', { method: 'POST' })).json();
  $('scan').textContent = '라이브러리 스캔';
  renderLib();
};
$('addAll').onclick = () => {
  library.filter(i => i.status === 'ready')
    .forEach(i => items.push({ ...i, key: 'k' + Math.random().toString(36).slice(2, 8) }));
  renderRd();
};
$('clear').onclick = () => { items = []; renderRd(); };
$('save').onclick = async () => {
  await fetch('/api/rundown', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'r1', items }),
  });
  $('save').textContent = '적용됨';
  setTimeout(() => ($('save').textContent = '출력창에 적용'), 1200);
};
/* ── 출력창 (Electron 이면 실제 창, 아니면 브라우저 탭) ── */
const inElectron = !!window.lp?.isElectron;

$('open').onclick = async () => {
  if (!inElectron) { window.open('/output/', 'lp-output', 'width=960,height=560'); return; }
  const sel = $('display');
  await window.lp.openOutput({
    id: 'out1',
    displayId: sel?.value ? Number(sel.value) : undefined,
    width: 1920, height: 1080,
  });
};

async function initElectron() {
  if (!inElectron) { $('elBar').hidden = true; return; }
  $('elBar').hidden = false;
  const ds = await window.lp.displays();
  $('display').innerHTML = ds.map(d =>
    `<option value="${d.id}">${d.index}. ${esc(d.label)} — ${d.width}×${d.height}` +
    `${d.primary ? ' (주)' : ''}</option>`).join('');
  $('elInfo').textContent = `${ds.length}대 감지 · 출력창은 1920×1080 프레임리스로 열립니다`;
}
initElectron();
$('resetSeams').onclick = async () => {
  seams = await (await fetch('/api/seams/reset', { method: 'POST' })).json();
  renderSeams();
};

connect();
