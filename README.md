# Live Player

편성 플레이아웃 도구. 여러 소스를 하나의 편성표로 묶어 무결절로 재생하고,
그 결과를 **OBS·vMix** 또는 **모니터**로 내보낸다.

기획서: [docs/기획서.md](docs/기획서.md) · UI 목업: [docs/mockups/편성화면.html](docs/mockups/편성화면.html)

## 현재 상태 — 2단계(MVP) 진행 중

증명하려는 것 하나: **"편성한 게 검은 화면 없이 1080p로 나간다."**

- [x] A/B 무결절 재생 엔진
- [x] 로컬 서버 (라이브러리 스캔 · Range 스트리밍 · WebSocket 브로드캐스트)
- [x] 출력창 (프레임리스 · 로고 대기 화면 · 디버그 오버레이)
- [x] Electron 셸 (모니터 지정 출력창 · 무인 자동 시작)
- [x] 전환 품질 계측
- [ ] 소스 어댑터 — Cloudflare Stream · Bunny Stream
- [ ] 편성 화면 (목업을 실제 데이터에 연결)
- [ ] 장시간·다채널 실측

## 실행

```bash
npm install
npm run clips     # 검증용 테스트 클립 6개 생성 (ffmpeg 필요)
npm run app       # Electron 앱
```

브라우저만으로 확인하려면 `npm start` 후 <http://127.0.0.1:4200/admin/>.

| 스크립트 | 하는 일 |
|---|---|
| `npm run app` | Electron 앱 (서버 내장) |
| `npm start` | 서버만 (브라우저에서 접속) |
| `npm run clips` | 무결절 검증용 테스트 클립 생성 |

환경 변수: `PORT`(기본 4200) · `LP_AUTO_OUTPUT=1`(기동 시 출력창 자동 개방) ·
`FFMPEG_PATH` / `FFPROBE_PATH`

## 구조

```
electron/main.cjs        앱 셸 — 서버 기동, 관리 창·출력창 관리
server/index.js          진실의 원천 — 라이브러리·런다운·WS 브로드캐스트
server/probe.js          ffprobe 래퍼 (길이·해상도 실측)
server/store.js          JSON 스토어
public/shared/engine.js  A/B 무결절 재생 엔진 ← 이 제품의 심장
public/output/           출력창 (캡처 대상 / 모니터 직출력)
public/admin/            1단계 검증 하네스
tools/make-test-clips.mjs
```

서버가 판단하고 출력창은 재생만 한다. 미리보기와 출력창이 같은 엔진을 쓰므로
보이는 화면이 곧 나가는 화면이다 (기획서 §5.3).
