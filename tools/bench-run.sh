#!/bin/zsh
# 채널 수를 늘려가며 전환 품질을 잰다 (기획서 §6.2 권장 구성표용).
# 각 구간: Electron 재기동 → 텔레메트리 초기화 → 프레임 계측 N건 수집 → 요약.
cd "$(dirname "$0")/.."
IDS=(c1 cirr2bn c2rcdjm cpagn3q)
NEED=${BENCH_SAMPLES:-14}
MAXWAIT=${BENCH_MAXWAIT:-420}

for n in 1 2 3 4; do
  pkill -f "Electron.app/Contents/MacOS/Electron \." 2>/dev/null
  sleep 3
  list=$(printf "%s," "${IDS[@]:0:$n}" | sed 's/,$//')
  LP_AUTO_OUTPUT="$list" npm run app > /tmp/bench-$n.log 2>&1 &
  # 서버 기동 대기
  for i in {1..40}; do curl -s -o /dev/null http://127.0.0.1:4200/api/channels && break; sleep 2; done
  sleep 12                                    # 창이 뜨고 재생이 안정될 시간
  curl -s -X POST http://127.0.0.1:4200/api/seams/reset > /dev/null
  echo "=== ${n}채널 계측 시작 ($(date +%H:%M:%S)) ==="
  waited=0
  while [ $waited -lt $MAXWAIT ]; do
    got=$(curl -s http://127.0.0.1:4200/api/seams | python3 -c 'import json,sys;print(sum(1 for s in json.load(sys.stdin) if s.get("measuredBy")=="frame"))' 2>/dev/null || echo 0)
    [ "$got" -ge "$NEED" ] && break
    sleep 8; waited=$((waited+8))
  done
  node tools/bench-channels.mjs report "${n}채널"
done
pkill -f "Electron.app/Contents/MacOS/Electron \." 2>/dev/null
echo "=== 벤치 완료 ==="
