// 편성 파이프라인 — 기획서 §3.5.
//
//   1. 편성 블록   어느 소스 그룹을 → 기간 × 요일(복수) × 시간대(복수)에
//   2. 자동 채움   블록이 없는 나머지 모든 시간
//   3. 런다운      위 둘을 특정 날짜에 적용해 만든 실행 가능한 재생 목록
//
// 생성은 서버가 한다. 브라우저가 계산하면 출력창·관리 화면·재생성이 서로 다른 답을 낼 수 있다.

const DAY_MS = 24 * 3600 * 1000;

/* ── 소스 그룹(풀) ────────────────────────────────── */

/**
 * 라이브러리에서 소스 그룹을 유도한다.
 * 폴더 하나가 그룹 하나, 원격 소스가 그룹 하나. 운영자가 따로 만들 필요가 없다.
 */
export function derivePools(library) {
  const map = new Map();
  const put = (id, name, kind, item) => {
    if (!map.has(id)) map.set(id, { id, name, kind, items: [] });
    map.get(id).items.push(item);
  };

  for (const it of library) {
    if (it.status !== 'ready') continue;
    if (it.isLocal) {
      const top = String(it.path || '').split('/')[0] || '(루트)';
      put(`folder:${top}`, top, 'folder', it);
    } else {
      const name = it.sourceType === 'cloudflare' ? 'Cloudflare Stream' : 'Bunny Stream';
      put(`source:${it.sourceType}`, name, 'source', it);
    }
  }

  return [...map.values()].map(p => ({
    ...p,
    count: p.items.length,
    totalMs: p.items.reduce((a, b) => a + b.durationMs, 0),
  }));
}

/* ── 순서 ─────────────────────────────────────────── */

// 같은 날짜·같은 블록이면 같은 순서가 나와야 한다. 재생성할 때마다 편성이 달라지면
// 운영자가 확인한 편성과 실제 나가는 편성이 달라진다.
function seeded(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function ordered(items, mode, seed, playlog = {}) {
  const arr = items.slice();
  if (mode === 'random') {
    const rnd = seeded(seed);
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  } else if (mode === 'unaired') {
    // 오래 안 나간 것부터. 한 번도 안 나간 항목이 가장 앞이다.
    arr.sort((a, b) => (playlog[a.id] || 0) - (playlog[b.id] || 0));
  }
  return arr;
}

/* ── 슬롯 채우기 ──────────────────────────────────── */

const hmsToMs = t => {
  const [h = 0, m = 0, s = 0] = String(t).split(':').map(Number);
  return ((h * 3600) + (m * 60) + s) * 1000;
};

function mkItem(src, blockName, extra = {}) {
  return {
    id: src.id,
    key: 'k' + Math.random().toString(36).slice(2, 9),
    sourceType: src.sourceType,
    playbackType: src.playbackType,
    title: src.title,
    url: src.url,
    durationMs: src.durationMs,
    fps: src.fps,
    isLocal: src.isLocal,
    block: blockName || null,
    timing: 'none',
    fixedAt: null,
    ...extra,
  };
}

// 폭주 방지 상한. 처음에 2000 으로 뒀다가 9시간을 14초 클립으로 채울 때 조용히 잘려
// 타임라인에 2.5시간짜리 구멍이 생겼다. 상한에 걸리면 반드시 알린다 — 조용한 절단은
// "다 채웠다"로 보이면서 실제로는 방송사고가 된다.
const HARD_LIMIT = 50_000;

/**
 * [a, z) 구간을 풀에서 채운다.
 * @returns {{items:Array, filledTo:number, truncated:boolean}}
 */
function fillSlot(pool, a, z, { order, fit, seed, blockName, playlog, fillers }) {
  const out = [];
  const seq = ordered(pool, order, seed, playlog);
  if (!seq.length) return { items: out, filledTo: a, truncated: false };

  let t = a, i = 0, guard = 0;
  while (t < z && guard++ < HARD_LIMIT) {
    const src = seq[i % seq.length];
    const left = z - t;

    if (src.durationMs <= left) {
      out.push(mkItem(src, blockName));
      t += src.durationMs;
      i += 1;
      // '필러' 만 한 바퀴에서 멈춘다. '반복'과 '잘라내기'는 계속 돌며 끝을 맞춘다.
      if (fit === 'filler' && i >= seq.length) break;
      continue;
    }

    if (fit === 'trim') {
      // 끝에 걸치는 항목을 잘라 정확히 맞춘다.
      out.push(mkItem(src, blockName, { trimOutMs: left, trimmed: true }));
      t = z;
      break;
    }
    if (fit === 'filler') {
      const f = fillers.filter(x => x.durationMs <= left).sort((p, q) => q.durationMs - p.durationMs)[0];
      if (!f || left < 3000) break;
      out.push(mkItem(f, blockName, { filler: true }));
      t += f.durationMs;
      continue;
    }
    break;   // loop: 남는 자투리는 그대로 둔다 (다음 블록의 Hard 마커가 정리한다)
  }

  return { items: out, filledTo: t, truncated: guard >= HARD_LIMIT && t < z };
}

/* ── 런다운 생성 ──────────────────────────────────── */

/** 해당 날짜에 유효한 블록의 시간대를 시작 시각 순으로 펼친다. */
export function daySlots(blocks, dow, dateStr) {
  const out = [];
  for (const b of blocks) {
    if (!b.days?.includes(dow)) continue;
    if (b.dateFrom && dateStr < b.dateFrom) continue;
    if (b.dateTo && dateStr > b.dateTo) continue;
    for (const [a, z] of b.slots || []) out.push({ a, z, block: b });
  }
  return out.sort((p, q) => p.a - q.a);
}

/**
 * 블록 + 자동 채움 → 하루치 런다운.
 * @returns {{items:Array, gaps:Array, coverageMs:number}}
 */
export function generateRundown({ blocks, autofill, library, playlog = {}, dow, dateStr }) {
  const pools = new Map(derivePools(library).map(p => [p.id, p.items]));
  // 필러 후보는 로컬 항목으로 한정한다 — 필러가 필요한 상황은 대개 네트워크 장애다(§3.6).
  const fillers = library.filter(i => i.isLocal && i.status === 'ready' && i.durationMs <= 5 * 60_000);
  const autoPool = (autofill?.poolIds || []).flatMap(id => pools.get(id) || []);

  const slots = daySlots(blocks, dow, dateStr);
  const items = [];
  const gaps = [];
  let cur = 0, seed = 1;
  let coverageMs = 0;

  const fillGap = (from, to) => {
    if (to - from < 1000) return;
    if (!autofill?.enabled || !autoPool.length) { gaps.push({ fromMs: from, toMs: to }); return; }
    const r = fillSlot(autoPool, from, to, {
      order: autofill.order || 'random', fit: 'loop',
      seed: seed++ * 7919, blockName: '자동 채움', playlog, fillers,
    });
    items.push(...r.items);
    // 자동 채움이 끝까지 못 갔으면 남은 구간은 공백이다. 여기서 안 잡으면
    // "자동 채움 켰으니 다 채워졌겠지"라는 착각이 그대로 방송에 나간다.
    if (r.filledTo < to - 1000) {
      gaps.push({ fromMs: r.filledTo, toMs: to, reason: r.truncated ? '상한 초과' : '소재 부족' });
    }
  };

  for (const s of slots) {
    if (s.a > cur) fillGap(cur, s.a);
    if (s.z <= cur) continue;                      // 앞 블록에 완전히 먹힌 시간대

    const pool = pools.get(s.block.poolId) || [];
    const before = items.length;
    const from = Math.max(s.a, cur);
    const r = fillSlot(pool, from, s.z, {
      order: s.block.order || 'seq',
      fit: s.block.fit || 'loop',
      seed: (seed++ * 104729) ^ hashStr(s.block.id + dateStr),
      blockName: s.block.name,
      playlog, fillers,
    });
    items.push(...r.items);

    // 블록의 첫 항목은 정시에 시작해야 한다 — "10시 특강"이 10:00:00 에 시작하지
    // 않으면 블록의 의미가 없다 (§3.5.4).
    if (items[before]) {
      items[before].timing = 'hard';
      items[before].fixedAt = s.a;
    }
    // 슬롯을 다 못 채웠으면 남은 부분은 공백이다. 채운 데까지만 커버리지로 센다 —
    // 슬롯 길이를 그대로 더하면 실제로는 비어 있는 시간이 채워진 것처럼 보인다.
    coverageMs += Math.max(0, r.filledTo - from);
    cur = Math.max(cur, r.filledTo);
  }

  if (cur < DAY_MS) fillGap(cur, DAY_MS);

  return { items, gaps, coverageMs };
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** 주간 커버리지 — 100% 가 되어야 24시간 편성이 완성된 것이다. */
export function weekCoverage(blocks, dateStr) {
  let booked = 0;
  for (let d = 0; d < 7; d++) {
    let cur = 0;
    for (const s of daySlots(blocks, d, dateStr)) {
      if (s.z <= cur) continue;
      booked += s.z - Math.max(s.a, cur);
      cur = Math.max(cur, s.z);
    }
  }
  return { bookedMs: booked, totalMs: 7 * DAY_MS };
}
