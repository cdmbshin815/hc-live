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
- [x] 전환 품질 계측 — 전환 간극 평균 11.7ms · 의심 0건
- [x] 소스 어댑터 레이어 (로컬 · 폴더 · HLS) + HLS 재생 (hls.js)
- [x] Bunny Stream 어댑터 — **실계정 검증 완료** (등록 · 동기화 · HLS 재생)
- [x] Cloudflare Stream 어댑터 *(실계정 미검증)*
- [x] 편성 파이프라인 — 블록 · 자동 채움 · 런다운 생성 (서버)
- [x] 주간 편성 화면 (블록 배치 · 커버리지 · 생성)
- [x] 롤링 윈도우 — 하루치 대신 앞으로 20분만 전송 (2.2MB → 39KB)
- [x] 다채널 — 채널별 독립 편성 · 출력창 · 계측
- [x] 출력 관리 — 모니터 배치도 · 4대 상한 · 오디오 단일화 · 채널 간 이동
- [ ] 장시간 실측 (1시간 운전 진행 중)
- [~] OBS 창 캡처 — 창 인식·해상도 확인 완료, **픽셀 내용은 미확인** (아래)
- [ ] Cloudflare Stream 실계정 검증 *(자격증명 필요)*

## 실행

```bash
npm install
npm run clips     # 검증용 클립 6개 + HLS 렌디션 3개 생성 (ffmpeg 필요)
npm run app       # Electron 앱
```

브라우저만으로 확인하려면 `npm start` 후 <http://127.0.0.1:4200/admin/>.

| 스크립트 | 하는 일 |
|---|---|
| `npm run app` | Electron 앱 (서버 내장) |
| `npm start` | 서버만 (브라우저에서 접속) |
| `npm run clips` | 무결절 검증용 테스트 클립 생성 |

환경 변수: `PORT`(기본 4200) · `LP_AUTO_OUTPUT=c1,c2`(기동 시 채널별 출력창 자동 개방) ·
`FFMPEG_PATH` / `FFPROBE_PATH`

## 채널

라이브러리는 전 채널이 공유하고, **편성·런다운·출력창은 채널마다 독립**이다 (기획서 §3.3).
출력창은 `/output/?ch=<채널ID>` 로 붙고, 서버는 그 채널의 편성만 보낸다.

## 구조

```
electron/main.cjs        앱 셸 — 서버 기동, 관리 창·출력창 관리
server/index.js          진실의 원천 — 라이브러리·런다운·WS 브로드캐스트
server/schedule.js       편성 파이프라인 — 블록 → 자동 채움 → 런다운
server/sources/          소스 어댑터 — local · cloudflare · bunny
server/probe.js          ffprobe 래퍼 (길이·해상도 실측)
server/store.js          JSON 스토어
public/shared/engine.js  A/B 무결절 재생 엔진 ← 이 제품의 심장
public/output/           출력창 (캡처 대상 / 모니터 직출력)
public/admin/            1단계 검증 하네스
tools/make-test-clips.mjs
```

## OBS 창 캡처

`tools/obs-capture-test.mjs` 로 obs-websocket 을 통해 검증한다 (OBS 28+ 에서
Tools → WebSocket Server Settings 를 켜야 한다).

확인된 것 — **OBS 는 물리 픽셀을 캡처한다.** 논리 960×540 창이 OBS 에서 1920×1080
소스로 잡혔다. 그래서 출력창은 요청 해상도를 화면 배율로 나눠 만든다.
이 처리가 없으면 Retina 에서 1920 요청이 3840 캡처가 된다.

미확인 — 캡처된 **픽셀 내용**. 이 기기(macOS Tahoe 26.5.1)에서는 우리 창뿐 아니라
다른 앱 창도 모두 검게 잡혔다. OBS 로그는 `Permission for screen capture granted` 지만
실제 프레임이 오지 않는다. 앱 문제가 아니라 시스템 쪽 사안으로 보이며,
OBS 미리보기를 사람이 직접 봐야 판정할 수 있다.

## 원격 소스 연결

Cloudflare Stream · Bunny Stream 은 관리 화면의 **소스 연결**에서 자격증명을 넣고
`동기화` 를 누르면 라이브러리에 들어온다. 값은 `data/credentials.json` 에만 저장되며
저장소에 올라가지 않고, 서버는 설정 여부만 돌려주고 값 자체는 내보내지 않는다.

Bunny 는 실계정으로 검증했다 — 필드 매핑이 응답과 일치하고, 동기화된 항목이
엔진에서 HLS 로 재생되며 로컬 파일과 양방향 전환도 된다.
Cloudflare 는 아직 실계정 검증 전이다.

**Bunny 핫링크 보호 주의** — 풀존이 기본적으로 레퍼러 없는 요청을 차단한다.
브라우저는 레퍼러를 보내므로 재생에는 문제가 없지만, 서버에서 `curl` 로 확인하면
403 이 나온다. 이것을 재생 불가로 오인하지 말 것.

서버가 판단하고 출력창은 재생만 한다. 미리보기와 출력창이 같은 엔진을 쓰므로
보이는 화면이 곧 나가는 화면이다 (기획서 §5.3).
