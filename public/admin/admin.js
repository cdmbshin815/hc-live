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
    return `<div class="row">
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
    fields: [['accountId', '계정 ID'], ['apiToken', 'API 토큰 (Stream:Read)']] },
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

/* ── 탭 · 생성 ───────────────────────────────────── */
function setTab(t) {
  tab = t;
  $('tabGrid').setAttribute('aria-pressed', t==='grid');
  $('tabRd').setAttribute('aria-pressed', t==='rundown');
  $('paneGrid').hidden = t!=='grid';
  $('paneRd').hidden = t!=='rundown';
}
$('tabGrid').onclick = () => setTab('grid');
$('tabRd').onclick = () => setTab('rundown');

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
