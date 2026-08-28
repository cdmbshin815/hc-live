#!/bin/zsh
# 채널 수를 늘려가며 전환 품질을 잰다 (기획서 §6.2 권장 구성표용).
# 각 구간: Electron 재기동 → 텔레메트리 초기화 → 프레임 계측 N건 수집 → 요약.
cd "$(dirname "$0")/.."
IDS=(${(s: :)BENCH_IDS})
NEED=${BENCH_SAMPLES:-30}
MAXWAIT=${BENCH_MAXWAIT:-360}

for n in ${(s:,:)${BENCH_N:-1,2,4,6}}; do
  pkill -f "Electron.app/Contents/MacOS/Electron \." 2>/dev/null
  sleep 3
  list=$(printf "%s," "${IDS[@]:0:$n}" | sed 's/,$//')
  LP_AUTO_OUTPUT="$list" LP_OUTPUT_W=${LP_OUTPUT_W:-460} npm run app > /tmp/bench-$n.log 2>&1 &
  # 서버 기동 대기
  for i in {1..40}; do curl -s -o /dev/null http://127.0.0.1:4200/api/channels && break; sleep 2; done
  sleep 12                                    # 창이 뜨고 재생이 안정될 시간
  curl -s -X POST http://127.0.0.1:4200/api/seams/reset > /dev/null
  echo "=== ${n}채널 계측 시작 ($(date +%H:%M:%S)) ==="
  waited=0
  while [ $waited -lt $MAXWAIT ]; do
    # 전체 전환 수로 기다린다. 프레임 계측은 창이 보일 때만 되므로 조건으로 쓸 수 없다.
    got=$(curl -s http://127.0.0.1:4200/api/seams | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))' 2>/dev/null || echo 0)
    [ "$got" -ge "$NEED" ] && break
    sleep 8; waited=$((waited+8))
  done
  # 창이 실제로 몇 개나 열렸는지 확인한다 — 화면 밖으로 밀렸으면 측정이 무효다
  grep -c "출력창" /tmp/bench-$n.log | xargs echo "  열린 출력창:"
  node tools/bench-channels.mjs report "${n}채널"
done
pkill -f "Electron.app/Contents/MacOS/Electron \." 2>/dev/null
echo "=== 벤치 완료 ==="
