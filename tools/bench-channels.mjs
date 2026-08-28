// 하드웨어 한계 실측 보조 — 기획서 §6.2 권장 구성표용.
//
//   node tools/bench-channels.mjs prep 4 [poolId]   벤치 채널을 같은 편성으로 준비하고 ID 출력
//   node tools/bench-channels.mjs report 2채널   현재 텔레메트리를 요약
//
// 채널 수를 늘려가며 재는 것이 목적이므로 편성은 모두 같게 둔다.
// 창이 가려지면 프레임 콜백이 멈추므로 출력창은 타일로 배치되어야 한다.
const BASE = 'http://127.0.0.1:4200';
const j = (p, m = 'GET', b) => fetch(BASE + p, {
  method: m, headers: { 'content-type': 'application/json' },
  body: b ? JSON.stringify(b) : undefined,
}).then(r => r.json());
const H = (h, m = 0) => (h * 3600 + m * 60) * 1000;

const [cmd, arg] = process.argv.slice(2);

if (cmd === 'prep') {
  const want = Number(arg || 2);
  const pools = await j('/api/pools');
  // 벤치는 로컬 짧은 클립으로 한다. 원격 소스는 네트워크가 변수로 끼고,
  // 긴 영상은 전환이 드물어 표본이 안 모인다.
  const poolId = process.argv[4]
    || pools.find(p => p.kind === 'folder' && p.count >= 4)?.id
    || pools[0]?.id;
  if (!poolId) { console.error('소스 그룹이 없습니다'); process.exit(1); }
  console.error('벤치 소스 그룹:', poolId);
  let list = await j('/api/channels');
  while (list.length < want) {
    await j('/api/channels', 'POST', { name: `벤치 ${list.length + 1}` });
    list = await j('/api/channels');
  }
  const ids = list.slice(0, want).map(c => c.id);
  for (const id of ids) {
    await j(`/api/channels/${id}/blocks`, 'POST', {
      blocks: [{ id: 'bench', name: '벤치 종일', poolId,
        days: [0, 1, 2, 3, 4, 5, 6], slots: [[H(0), H(24)]],
        dateFrom: '2026-01-01', dateTo: '2026-12-31', order: 'seq', fit: 'loop' }],
      autofill: { enabled: false, poolIds: [], order: 'seq' },
    });
    await j(`/api/channels/${id}/rundown/generate`, 'POST', {});
  }
  console.log(ids.join(','));
} else if (cmd === 'report') {
  const [seams, heap] = await Promise.all([j('/api/seams'), j('/api/heap')]);
  const num = a => a.filter(x => typeof x === 'number').sort((p, q) => p - q);
  const at = (g, p) => g.length ? g[Math.min(g.length - 1, Math.floor(g.length * p))] : null;

  // 프레임 간극(rVFC)은 창이 보일 때만 잴 수 있다. 창이 가려지면 표본이 끊긴다.
  // 그래서 부하 판정은 **가시성과 무관한 지표**로 한다.
  //
  //   preparedMsAhead  다음 항목이 전환보다 얼마나 미리 준비됐나 = 여유(headroom).
  //                    디코더가 부족해지면 이 값이 먼저 줄고, 음수가 되면 지각이다.
  //   reason=retry     대기 레이어가 준비 안 돼 전환이 보류된 횟수
  //   readyState<4     전환 시점에 버퍼가 덜 찬 횟수
  const ahead = num(seams.map(s => s.preparedMsAhead));
  const late = seams.filter(s => (s.preparedMsAhead ?? 0) < 0).length;
  const retry = seams.filter(s => s.reason === 'retry').length;
  const notFull = seams.filter(s => (s.standbyReadyState ?? 4) < 4).length;
  const skips = seams.filter(s => s.prerollSkip).length;

  const f = seams.filter(s => s.measuredBy === 'frame');
  const g = num(f.map(s => s.presentGapMs));
  const mb = heap.map(h => h.mb);
  const byCh = {};
  for (const s of seams) byCh[s.channelId] = (byCh[s.channelId] || 0) + 1;

  console.log(JSON.stringify({
    구간: arg || '?',
    전환: seams.length, 채널별: byCh,
    여유_중앙값ms: at(ahead, 0.5), 여유_최소ms: ahead[0] ?? null, 지각: late,
    전환보류: retry, 버퍼미달: notFull, 프리롤실패: skips,
    프레임계측: f.length,
    간극_중앙값ms: at(g, 0.5), 간극_p90ms: at(g, 0.9), 의심: f.filter(s => s.suspect).length,
    힙MB: mb.length ? `${Math.min(...mb)}~${Math.max(...mb)}` : null,
  }));
} else {
  console.log('사용법: prep <채널수> | report <라벨>');
}
