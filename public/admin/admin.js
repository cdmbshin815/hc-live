// 1단계 검증 하네스 — 라이브러리로 런다운을 만들고 전환 품질을 계측한다.
// 최종 관리 UI 는 docs/mockups/편성화면.html 의 설계를 따르며, 이 화면은 엔진 검증 전용이다.

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const ms = m => {
  const s = Math.round(m / 1000);
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
};

let library = [], items = [], seams = [], ws;
let blocks = [], autofill = { enabled:false, poolIds:[], order:'random' }, pools = [], coverage = null;
let chans = [], curCh = localStorage.getItem('lp.ch') || '';
const chUrl = p => `/api/channels/${encodeURIComponent(curCh)}${p}`;
let selBlk = null, tab = 'grid';

const DOW = ['월','화','수','목','금','토','일'];
const TODAY = (new Date().getDay() + 6) % 7;
const HOUR_H = 11;                    // 그리드 1시간 높이(px)
const hm = ms => String(Math.floor(ms/3600000)).padStart(2,'0') + ':' +
                 String(Math.floor(ms/60000)%60).padStart(2,'0');
const parseHm = v => { const p = String(v).split(':').map(Number);
  return (p.length>=2 && p.every(n=>!isNaN(n))) ? (p[0]*3600+p[1]*60)*1000 : null; };
const POOL_COLOR = ['#C9A15A','#E0873A','#B85A52','#9B7BC4','#4FB3C9','#5BC98C'];
const poolColor = id => POOL_COLOR[Math.abs([...String(id)].reduce((a,c)=>a+c.charCodeAt(0),0)) % POOL_COLOR.length];

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
    if (m.type === 'outputs' && tab === 'output') loadOutputs();
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
  const SRC = { local:'로컬', hls:'HLS', cloudflare:'CF', bunny:'Bunny', folder:'폴더' };
  el.innerHTML = library.map(i =>
    `<div class="row" data-add="${i.id}">
       <span class="badge2">${SRC[i.sourceType] || i.sourceType}</span>
       <span class="t">${esc(i.title)}</span>
       ${i.status === 'error' ? '<span class="err">길이 없음</span>'
         : i.status === 'resolving' ? '<span class="err" style="color:var(--warn)">준비 중</span>' : ''}
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
  if (!items.length) { el.innerHTML = '<div class="empty">주간 편성에서 블록을 만들고 <b>런다운 생성</b>을 누르세요.</div>'; return; }
  let acc = 0;
  // 항목이 많으면 앞부분만 그린다 — 6천 개를 모두 DOM 에 올릴 이유가 없다.
  const view = items.slice(0, 300);
  el.innerHTML = (items.length > view.length
    ? `<div class="note" style="margin:0 0 6px">전체 ${items.length}개 중 300개만 표시합니다.</div>` : '') +
    view.map((i, n) => {
    const at = acc; acc += i.durationMs;
    const mk = i.timing && i.timing !== 'none'
      ? `<span class="badge2" style="color:#FF8478">${i.timing.toUpperCase()}</span>` : '';
    const len = (i.trimOutMs ?? i.durationMs) - (i.trimInMs ?? 0);
    // 온에어 항목과 다음 1개는 드래그를 막는다 — 실수로 방송을 끊는 사고를 방지 (§4.3.7)
    const locked = n <= onAirIndex() + 1 && onAirIndex() >= 0;
    return `<div class="row ${locked ? 'lock' : ''}" data-i="${n}">
      <span class="grip">${locked ? '🔒' : '⣿'}</span>
      <span class="n">${n + 1}</span>
      <span class="d">${i.startMs != null ? ms(i.startMs) : ms(at)}</span>
      <span class="t">${esc(i.title)}</span>
      ${i.block ? `<span class="badge2">${esc(i.block)}</span>` : ''}${mk}
      <span class="d">${ms(len)}</span>
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

/* ── 소스 연결 (Cloudflare · Bunny) ─────────────── */
const SOURCES = [
  { kind: 'cloudflare', name: 'Cloudflare Stream',
    fields: [['accountId', '계정 ID'], ['apiToken', 'API 토큰 (Stream:Read)'],
             ['creator', 'creator — Live Player 는 hcjoynLive'],
             ['customerSubdomain', '재생 도메인 (선택 · customer-xxxx)']] },
  { kind: 'bunny', name: 'Bunny Stream',
    fields: [['libraryId', '라이브러리 ID'], ['apiKey', 'API 키'],
             ['cdnHost', '재생 호스트 (예: vz-xxxx.b-cdn.net)']] },
];

async function renderSources() {
  const state = await (await fetch('/api/sources')).json();
  $('srcBox').innerHTML = SOURCES.map(s => `
    <div class="src-card ${state[s.kind]?.configured ? 'on' : ''}" data-kind="${s.kind}">
      <h3><span class="dot2"></span>${s.name}
        <span class="tag" style="margin-left:auto">${state[s.kind]?.configured ? '설정됨' : '미설정'}</span></h3>
      ${s.fields.map(([k, ph]) =>
        `<input data-f="${k}" placeholder="${ph}" autocomplete="off" spellcheck="false">`).join('')}
      <div class="acts">
        <button class="btn" data-save>저장·확인</button>
        <button class="btn pri" data-sync>동기화</button>
      </div>
      <div class="msg"></div>
    </div>`).join('');

  $('srcBox').querySelectorAll('.src-card').forEach(card => {
    const kind = card.dataset.kind;
    const msg = card.querySelector('.msg');
    const values = () => Object.fromEntries(
      [...card.querySelectorAll('[data-f]')].map(i => [i.dataset.f, i.value.trim()]).filter(([, v]) => v));

    card.querySelector('[data-save]').onclick = async () => {
      msg.textContent = '확인 중…';
      const r = await (await fetch(`/api/sources/${kind}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(values()),
      })).json();
      msg.textContent = r.ok ? '✓ ' + r.message : '✗ ' + r.message;
      msg.style.color = r.ok ? 'var(--ok)' : 'var(--err)';
      // 입력값은 화면에 남기지 않는다 — 저장은 서버 쪽 파일에만 이뤄진다.
      if (r.ok) card.querySelectorAll('[data-f]').forEach(i => (i.value = ''));
      renderSources();
    };

    card.querySelector('[data-sync]').onclick = async () => {
      msg.textContent = '동기화 중…';
      const r = await (await fetch(`/api/sources/${kind}/sync`, { method: 'POST' })).json();
      msg.textContent = r.ok ? `✓ ${r.count}건 가져옴` : '✗ ' + r.message;
      msg.style.color = r.ok ? 'var(--ok)' : 'var(--err)';
    };
  });
}

/* ── 주간 편성 그리드 ────────────────────────────── */
async function loadChannels() {
  chans = await (await fetch('/api/channels')).json();
  if (!chans.find(c => c.id === curCh)) curCh = chans[0]?.id || '';
  localStorage.setItem('lp.ch', curCh);
  $('chSel').innerHTML = chans.map(c =>
    `<option value="${c.id}" ${c.id===curCh?'selected':''}>${esc(c.name)} · ${c.blockCount}블록 · ` +
    `${c.rundownItems}항목</option>`).join('');
}

async function loadBlocks() {
  if (!curCh) return;
  const r = await (await fetch(chUrl('/blocks'))).json();
  blocks = r.blocks; autofill = r.autofill; coverage = r.coverage;
  pools = await (await fetch('/api/pools')).json();
  renderGrid();
}

async function saveBlocks() {
  const r = await (await fetch(chUrl('/blocks'), {
    method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ blocks, autofill }),
  })).json();
  coverage = r.coverage; renderGrid();
}

function renderGrid() {
  $('gdays').innerHTML = '<div></div>' +
    DOW.map((d,i)=>`<div class="${i===TODAY?'td':''}">${d}</div>`).join('');

  let h = `<div class="hrs">${Array.from({length:24},(_,i)=>
    `<div class="hr" style="height:${HOUR_H}px">${i%3===0?String(i).padStart(2,'0'):''}</div>`).join('')}</div>`;

  for (let d=0; d<7; d++) {
    h += `<div class="dcol" data-day="${d}">`;
    for (let i=1;i<24;i++) h += `<div class="ln ${i%6===0?'mj':''}" style="top:${i*HOUR_H}px"></div>`;
    for (const b of blocks) {
      if (!b.days?.includes(d)) continue;
      for (const [a,z] of b.slots||[]) {
        const c = poolColor(b.poolId);
        h += `<div class="blk ${selBlk===b.id?'sel':''}" data-blk="${b.id}"
          style="top:${a/3600000*HOUR_H}px;height:${Math.max(7,(z-a)/3600000*HOUR_H)}px;
          background:${c}22;border-color:${c}66;color:${c}"><b>${esc(b.name)}</b></div>`;
      }
    }
    if (autofill.enabled) for (const [a,z] of gapsOf(d)) {
      if (z-a < 1800000) continue;
      h += `<div class="blk auto" style="top:${a/3600000*HOUR_H}px;
        height:${Math.max(7,(z-a)/3600000*HOUR_H)}px"><b>자동</b></div>`;
    }
    h += '</div>';
  }
  $('grid').innerHTML = h;
  $('grid').querySelectorAll('[data-blk]').forEach(el =>
    el.addEventListener('pointerdown', e => { e.stopPropagation();
      selBlk = el.dataset.blk; renderGrid(); }));

  const booked = coverage ? coverage.bookedMs : 0;
  const total = coverage ? coverage.totalMs : 1;
  const pct = autofill.enabled ? 100 : booked/total*100;
  $('covFill').style.width = pct + '%';
  $('covTxt').textContent = `블록 ${(booked/3600000).toFixed(1)}시간` +
    (autofill.enabled ? ` · 자동 채움 ${((total-booked)/3600000).toFixed(1)}시간` : '');
  $('covPct').textContent = Math.round(pct) + '% 편성';
  $('autoBtn').textContent = autofill.enabled ? '자동 채움 해제' : '나머지 시간 자동 채움';
  $('autoBtn').className = 'btn' + (autofill.enabled ? '' : ' pri');
  renderBlkInsp();
}

function gapsOf(day) {
  const s = blocks.filter(b=>b.days?.includes(day)).flatMap(b=>(b.slots||[]).map(([a,z])=>({a,z})))
    .sort((p,q)=>p.a-q.a);
  const g=[]; let cur=0;
  for (const x of s) { if (x.a>cur) g.push([cur,x.a]); cur=Math.max(cur,x.z); }
  if (cur<86400000) g.push([cur,86400000]);
  return g;
}

/* 빈 시간 드래그 → 블록 생성 */
let gd = null;
document.addEventListener('pointerdown', e => {
  const col = e.target.closest('.dcol');
  if (!col || tab!=='grid' || e.target.closest('.blk')) return;
  const r = col.getBoundingClientRect();
  gd = { day:+col.dataset.day, col, y0:e.clientY-r.top, y1:e.clientY-r.top, el:null };
});
document.addEventListener('pointermove', e => {
  if (!gd) return;
  const r = gd.col.getBoundingClientRect();
  gd.y1 = Math.max(0, Math.min(24*HOUR_H, e.clientY-r.top));
  if (!gd.el && Math.abs(gd.y1-gd.y0) > 4) {
    gd.el = document.createElement('div');
    gd.el.className = 'blk';
    gd.el.style.cssText = 'background:var(--ghost);border-color:var(--accent-dim);color:var(--accent)';
    gd.col.appendChild(gd.el);
  }
  if (gd.el) {
    const t = Math.min(gd.y0,gd.y1), hh = Math.abs(gd.y1-gd.y0);
    gd.el.style.top = t+'px'; gd.el.style.height = hh+'px';
    gd.el.innerHTML = `<b>${hm(snapT(t))}–${hm(snapT(t+hh))}</b>`;
  }
});
document.addEventListener('pointerup', async () => {
  if (!gd) return; const g = gd; gd = null;
  if (!g.el) return;
  const a = snapT(Math.min(g.y0,g.y1)), z = snapT(Math.max(g.y0,g.y1));
  g.el.remove();
  if (z-a < 900000) return;                       // 15분 미만은 무시
  const nb = { id:'b'+Math.random().toString(36).slice(2,8), name:'새 편성 블록',
    poolId: pools[0]?.id || '', days:[g.day], slots:[[a,z]],
    dateFrom:'2026-01-01', dateTo:'2026-12-31', order:'seq', fit:'loop' };
  blocks.push(nb); selBlk = nb.id; await saveBlocks();
});
const snapT = px => Math.round(px/HOUR_H*4)/4*3600000;   // 15분 스냅

/* 블록 인스펙터 */
function renderBlkInsp() {
  const b = blocks.find(x=>x.id===selBlk);
  if (!b) { $('blkInsp').innerHTML = ''; return; }
  $('blkInsp').innerHTML = `<div class="bi">
    <label>블록 이름</label><input id="bName" value="${esc(b.name)}">
    <label>소스 그룹</label><select id="bPool">${pools.map(p=>
      `<option value="${p.id}" ${p.id===b.poolId?'selected':''}>${esc(p.name)} (${p.count}편)</option>`).join('')}</select>
    <label>기간</label><div class="row2">
      <input id="bFrom" value="${b.dateFrom||''}"><input id="bTo" value="${b.dateTo||''}"></div>
    <label>요일 · 복수 선택</label><div class="dow" id="bDow">${DOW.map((d,i)=>
      `<button data-d="${i}" aria-pressed="${b.days.includes(i)}">${d}</button>`).join('')}</div>
    <label>시간대 · 복수 가능</label><div id="bSlots">${(b.slots||[]).map(([a,z],i)=>
      `<div class="slotrow"><input data-s="${i}" data-e="a" value="${hm(a)}">
       <span class="tag">–</span><input data-s="${i}" data-e="z" value="${hm(z)}">
       <button class="btn" data-del="${i}">×</button></div>`).join('')}</div>
    <button class="btn" id="bAdd" style="width:100%;margin-top:4px">+ 시간대 추가</button>
    <div class="row2" style="margin-top:8px">
      <div style="flex:1"><label>재생 순서</label><select id="bOrder">
        ${[['seq','순차'],['random','랜덤'],['unaired','미방영 우선']].map(([v,l])=>
          `<option value="${v}" ${b.order===v?'selected':''}>${l}</option>`).join('')}</select></div>
      <div style="flex:1"><label>시간 맞춤</label><select id="bFit">
        ${[['loop','반복'],['filler','필러'],['trim','잘라내기']].map(([v,l])=>
          `<option value="${v}" ${b.fit===v?'selected':''}>${l}</option>`).join('')}</select></div>
    </div>
    <button class="btn" id="bDel" style="width:100%;margin-top:9px;color:var(--err);
      border-color:rgba(255,107,90,.35)">블록 삭제</button>
  </div>`;

  const set = (id, fn) => { const el=$(id); if (el) el.onchange = async e => { fn(e.target.value); await saveBlocks(); }; };
  set('bName', v => b.name = v || '이름 없음');
  set('bPool', v => b.poolId = v);
  set('bFrom', v => b.dateFrom = v);
  set('bTo',   v => b.dateTo = v);
  set('bOrder',v => b.order = v);
  set('bFit',  v => b.fit = v);
  document.querySelectorAll('#bDow button').forEach(x => x.onclick = async () => {
    const d = +x.dataset.d;
    b.days = b.days.includes(d) ? b.days.filter(y=>y!==d) : [...b.days,d].sort();
    if (!b.days.length) b.days = [d];
    await saveBlocks();
  });
  document.querySelectorAll('#bSlots input').forEach(inp => inp.onchange = async () => {
    const v = parseHm(inp.value); if (v==null) return renderGrid();
    const i = +inp.dataset.s;
    if (inp.dataset.e==='a') b.slots[i][0]=v; else b.slots[i][1]= v===0 ? 86400000 : v;
    if (b.slots[i][1] <= b.slots[i][0]) b.slots[i][1] = b.slots[i][0] + 1800000;
    await saveBlocks();
  });
  document.querySelectorAll('#bSlots [data-del]').forEach(x => x.onclick = async () => {
    if (b.slots.length < 2) return;
    b.slots.splice(+x.dataset.del,1); await saveBlocks();
  });
  $('bAdd').onclick = async () => {
    const last = b.slots[b.slots.length-1][1];
    const a = Math.min(last+3600000, 82800000);
    b.slots.push([a, Math.min(a+3600000, 86400000)]); await saveBlocks();
  };
  $('bDel').onclick = async () => {
    blocks = blocks.filter(x=>x.id!==b.id); selBlk=null; await saveBlocks();
  };
}

/* ── 출력 관리 (§4.4) ────────────────────────────── */
let displays = [], outs = { outputs: [], monitorUsed: 0, monitorMax: 4 }, selOut = null;
const OTYPE = { monitor:['🖥','모니터 직출력'], capture_window:['⬚','창 캡처'], ndi:['◈','NDI'] };
const SCALES = [['none','1:1'],['fit','여백맞춤'],['fill','꽉채움'],['stretch','늘림']];
const SBOX = { none:'left:8px;top:4px;width:18px;height:12px',
               fit:'left:2px;top:4px;width:29px;height:12px',
               fill:'left:2px;top:-2px;width:29px;height:24px',
               stretch:'left:2px;top:2px;width:29px;height:16px' };
const scaleNote = m => ({
  none:'스케일 없이 원본 픽셀 그대로. 해상도가 정확히 일치할 때만 무왜곡입니다.',
  fit:'비율을 유지하고 남는 곳은 검은 여백. 기본값이며 왜곡이 없습니다.',
  fill:'비율을 유지하되 넘치는 부분이 잘립니다.',
  stretch:'비율을 무시하고 늘립니다. 왜곡이 생깁니다.' }[m]);

async function loadOutputs() {
  outs = await (await fetch('/api/outputs')).json();
  if (inElectron && !displays.length) displays = await window.lp.displays();
  renderOutputs();
}

function renderOutputs() {
  // 모니터 배치도 — OS 디스플레이 설정과 같은 상대 위치·비율 (§4.4.1)
  const box = $('monMap');
  if (!displays.length) {
    box.innerHTML = '<div class="empty">브라우저에서는 모니터를 감지할 수 없습니다. ' +
      'Electron 앱(<code>npm run app</code>)에서 확인하세요.</div>';
    box.style.height = 'auto';
  } else {
    const bw = Math.max(...displays.map(d=>d.x+d.width));
    const bh = Math.max(...displays.map(d=>d.y+d.height));
    const k = Math.min(((box.clientWidth||460)-40)/bw, 150/bh);
    box.style.height = (bh*k+24)+'px';
    box.innerHTML = displays.map((d,i) => {
      const own = outs.outputs.find(o => o.type==='monitor' && String(o.displayId)===String(d.id));
      const mine = own && own.channelId === curCh;
      const cls = mine ? 'mine' : own ? 'other' : 'free';
      const label = mine ? '● 이 채널' : own ? esc(own.channelName) : '비어 있음';
      return `<div class="mon ${cls} ${own && own.id===selOut ? 'sel':''}" data-disp="${d.id}"
        style="left:${d.x*k+12}px;top:${d.y*k+12}px;width:${d.width*k}px;height:${d.height*k}px">
        <span class="n">${i+1}</span><span class="r">${d.width}×${d.height}</span>
        <span class="o">${label}</span></div>`;
    }).join('');
    box.querySelectorAll('[data-disp]').forEach(el => el.onclick = () => clickMonitor(el.dataset.disp));
  }

  const mine = outs.outputs.filter(o => o.channelId === curCh);
  $('outList').innerHTML = mine.length ? mine.map(o => {
    const d = displays.find(x => String(x.id)===String(o.displayId));
    const [ic,name] = OTYPE[o.type] || ['?',o.type];
    return `<div class="orow ${o.id===selOut?'sel':''}" data-out="${o.id}">
      <span>${ic}</span>
      <span class="t">${name}${d?` <span class="tag">· ${esc(d.label)}</span>`:''}</span>
      <span class="mono">${o.w}×${o.h}</span>
      <span class="mono">${(SCALES.find(s=>s[0]===o.scale)||['','—'])[1]}</span>
      <span class="au ${o.audio?'on':'off'}" data-au="${o.id}" title="이 출력에서 소리">${o.audio?'🔊':'🔇'}</span>
      <button class="x" data-delout="${o.id}">×</button></div>`;
  }).join('') : '<div class="empty">출력이 없습니다. 배치도에서 빈 모니터를 클릭하거나 아래에서 추가하세요.</div>';

  $('outList').querySelectorAll('[data-out]').forEach(el => el.onclick = e => {
    if (e.target.dataset.au || e.target.dataset.delout) return;
    selOut = el.dataset.out; renderOutputs();
  });
  $('outList').querySelectorAll('[data-au]').forEach(el => el.onclick = async e => {
    e.stopPropagation();
    await fetch(`/api/channels/${curCh}/outputs/${el.dataset.au}`, {
      method:'PATCH', headers:{'content-type':'application/json'},
      body: JSON.stringify({ audio:true }) });
    loadOutputs();
  });
  $('outList').querySelectorAll('[data-delout]').forEach(el => el.onclick = async e => {
    e.stopPropagation();
    await fetch(`/api/channels/${curCh}/outputs/${el.dataset.delout}`, { method:'DELETE' });
    if (selOut === el.dataset.delout) selOut = null;
    loadOutputs();
  });

  const used = outs.outputs.length, cap = 4;
  $('loadTxt').textContent = `디코더 ${used} / 권장 ${cap} · 모니터 ${outs.monitorUsed}/${outs.monitorMax}`;
  $('loadFill').style.width = Math.min(100, used/cap*100) + '%';
  $('loadFill').style.background = used > cap ? 'var(--warn)' : 'var(--accent-dim)';
  $('addMon').disabled = outs.monitorUsed >= outs.monitorMax;
  $('outTip').innerHTML = mine.length >= 3
    ? '<div class="warnbox">출력이 3개 이상입니다. 여러 모니터에 <b>같은 화면</b>을 띄우는 것이 ' +
      '목적이라면 앱 미러 대신 <b>OS 디스플레이 미러링</b>을 쓰십시오 — 디코딩이 1회로 줄어듭니다.</div>' : '';
  renderOutInsp();
}

function renderOutInsp() {
  const o = outs.outputs.find(x => x.id === selOut && x.channelId === curCh);
  if (!o) { $('outInsp').innerHTML = ''; return; }
  const d = displays.find(x => String(x.id)===String(o.displayId));
  $('outInsp').innerHTML = `<div class="bi">
    <label>유형</label><div class="v">${(OTYPE[o.type]||[])[1] || o.type}</div>
    <p class="note">생성 후 변경할 수 없습니다. 바꾸려면 삭제하고 다시 만드세요.</p>
    <label>해상도</label><div class="row2">
      <input id="oW" value="${o.w}"><input id="oH" value="${o.h}"></div>
    ${d ? `<p class="note">모니터 감지값 ${d.width}×${d.height}${(d.width!==o.w||d.height!==o.h)?' — 다르게 지정됨':' (자동 적용)'}</p>`:''}
    <label>스케일 모드</label><div class="scale-opts" id="oScale">${SCALES.map(([v,l])=>
      `<button class="scale-opt" data-s="${v}" aria-pressed="${o.scale===v}">
       <span class="sbox"><i style="${SBOX[v]}"></i></span><span>${l}</span></button>`).join('')}</div>
    <p class="note">${scaleNote(o.scale)}</p>
    <label>오디오</label>
    <button class="btn ${o.audio?'pri':''}" id="oAu" style="width:100%">${o.audio
      ? '🔊 이 출력에서 소리 남' : '🔇 음소거 — 눌러서 이 출력으로'}</button>
    <p class="note">채널당 하나의 출력만 소리를 냅니다.</p>
  </div>`;
  const save = b => fetch(`/api/channels/${curCh}/outputs/${o.id}`, {
    method:'PATCH', headers:{'content-type':'application/json'}, body: JSON.stringify(b) })
    .then(loadOutputs);
  $('oW').onchange = e => save({ w:+e.target.value });
  $('oH').onchange = e => save({ h:+e.target.value });
  document.querySelectorAll('#oScale button').forEach(b => b.onclick = () => save({ scale:b.dataset.s }));
  $('oAu').onclick = () => save({ audio:true });
}

async function addOutput(body) {
  const r = await fetch(`/api/channels/${curCh}/outputs`, {
    method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) {
    if (j.owner && confirm(`${j.owner} 에서 이 모니터를 가져올까요?`)) return addOutput({ ...body, takeover:true });
    return alert(j.error);
  }
  selOut = j.id; loadOutputs();
}

function clickMonitor(displayId) {
  const own = outs.outputs.find(o => o.type==='monitor' && String(o.displayId)===String(displayId));
  if (own && own.channelId === curCh) { selOut = own.id; return renderOutputs(); }
  const d = displays.find(x => String(x.id)===String(displayId));
  addOutput({ type:'monitor', displayId, w:d?.width || 1920, h:d?.height || 1080 });
}

$('addMon').onclick = () => {
  const free = displays.find(d => !outs.outputs.some(o => o.type==='monitor' && String(o.displayId)===String(d.id)));
  if (!free) return alert('배정할 수 있는 빈 모니터가 없습니다');
  clickMonitor(free.id);
};
$('addCap').onclick = () => addOutput({ type:'capture_window',
  displayId: displays[0]?.id ?? null, w:1920, h:1080 });

/* ── 탭 · 생성 ───────────────────────────────────── */
function setTab(t) {
  tab = t;
  for (const [id,v] of [['tabGrid','grid'],['tabRd','rundown'],['tabOut','output']])
    $(id).setAttribute('aria-pressed', t===v);
  $('paneGrid').hidden = t!=='grid';
  $('paneRd').hidden = t!=='rundown';
  $('paneOut').hidden = t!=='output';
  if (t==='output') loadOutputs();
}
$('tabGrid').onclick = () => setTab('grid');
$('tabRd').onclick = () => setTab('rundown');
$('tabOut').onclick = () => setTab('output');

$('autoBtn').onclick = async () => {
  autofill = { ...autofill, enabled: !autofill.enabled,
    poolIds: autofill.poolIds?.length ? autofill.poolIds : pools.map(p=>p.id) };
  await saveBlocks();
};

$('genBtn').onclick = async () => {
  $('genBtn').textContent = '생성 중…';
  const r = await (await fetch(chUrl('/rundown/generate'), {
    method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ dow: TODAY }),
  })).json();
  $('genBtn').textContent = '런다운 생성';
  items = r.items;
  $('genWarn').hidden = !r.warning;
  if (r.warning) $('genWarn').textContent = '⚠ ' + r.warning;
  setTab('rundown'); renderRd();
};

/* ── 런다운 드래그 재정렬 (§4.3.4) ───────────────── */
// 지금 나가는 지점을 안다는 전제로 온에어·다음 항목을 잠근다.
function nowMsOfDay() {
  const d = new Date();
  return ((d.getHours() * 60 + d.getMinutes()) * 60 + d.getSeconds()) * 1000;
}
function onAirIndex() {
  const t = nowMsOfDay();
  return items.findIndex(i => i.startMs != null && i.startMs <= t && t < i.endMs);
}

const dline = document.createElement('div'); dline.className = 'drop-line'; dline.hidden = true;
const dtip  = document.createElement('div'); dtip.className  = 'drop-tip';  dtip.hidden  = true;
document.body.append(dline, dtip);
let rdDrag = null;

document.addEventListener('pointerdown', e => {
  if (tab !== 'rundown') return;
  const row = e.target.closest('#rd .row');
  if (!row || row.classList.contains('lock') || e.target.dataset.del) return;
  rdDrag = { from: +row.dataset.i, y: e.clientY, live: false, row };
});

document.addEventListener('pointermove', e => {
  if (!rdDrag) return;
  if (!rdDrag.live) {
    if (Math.abs(e.clientY - rdDrag.y) < 5) return;
    rdDrag.live = true; rdDrag.row.classList.add('drag');
  }
  const rows = [...document.querySelectorAll('#rd .row')];
  let idx = rows.length, top = 0;
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k].getBoundingClientRect();
    if (e.clientY < r.top + r.height / 2) { idx = +rows[k].dataset.i; top = r.top; break; }
    top = r.bottom;
  }
  rdDrag.to = idx;
  const box = $('rd').getBoundingClientRect();
  dline.hidden = dtip.hidden = false;
  dline.style.left = box.left + 'px'; dline.style.width = box.width + 'px'; dline.style.top = top + 'px';
  // 놓았을 때 그 자리의 예상 시작 시각 — 자기 행동의 결과를 보여주는 유일한 피드백이다
  const at = items[Math.min(idx, items.length - 1)]?.startMs ?? 0;
  dtip.textContent = ms(at);
  dtip.style.left = (box.right - 70) + 'px'; dtip.style.top = top + 'px';
});

document.addEventListener('pointerup', async () => {
  if (!rdDrag) return;
  const d = rdDrag; rdDrag = null;
  dline.hidden = dtip.hidden = true;
  d.row.classList.remove('drag');
  if (!d.live || d.to == null) return;
  let to = d.to; if (to > d.from) to--;
  if (to === d.from) return;
  items.splice(to, 0, items.splice(d.from, 1)[0]);
  renderRd();                                   // 즉시 반영
  const r = await (await fetch(chUrl('/rundown'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items }),
  })).json();
  items = r.items;                              // 서버가 다시 계산한 시작 시각으로 갱신
  renderRd();
  document.querySelectorAll('#rd .row .d').forEach(el => {
    el.animate([{ color: 'var(--accent)' }, { color: '' }], { duration: 550 });
  });
});

const renderAll = async () => {
  await loadChannels();
  renderLib(); renderRd(); renderSeams(); renderSources(); loadBlocks();
};

$('chSel').onchange = async e => {
  curCh = e.target.value; localStorage.setItem('lp.ch', curCh);
  selBlk = null; items = [];
  await loadChannels(); await loadBlocks(); renderRd();
};
$('chAdd').onclick = async () => {
  const name = prompt('채널 이름', `채널 ${chans.length + 1}`);
  if (!name) return;
  const r = await (await fetch('/api/channels', {
    method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ name }),
  })).json();
  curCh = r.id; localStorage.setItem('lp.ch', curCh);
  selBlk = null; items = [];
  await loadChannels(); await loadBlocks(); renderRd();
};

/* ── 조작 ────────────────────────────────────────── */
$('scan').onclick = async () => {
  $('scan').textContent = '스캔 중…';
  library = await (await fetch('/api/library/scan', { method: 'POST' })).json();
  $('scan').textContent = '라이브러리 스캔';
  renderLib();
};
$('clear').onclick = () => { items = []; renderRd(); };
$('save').onclick = async () => {
  await fetch(chUrl('/rundown'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items }),
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
    id: 'out_' + curCh,
    channelId: curCh,
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
