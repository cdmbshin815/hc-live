// A/B 무결절 재생 엔진 — 이 제품의 심장.
// 출력창과 미리보기가 이 파일 하나를 공유하므로, 보이는 화면이 곧 나가는 화면이다.
//
// 원리
//   1. 비디오 레이어를 두 개(A/B) 두고 한쪽만 보이게 한다.
//   2. 현재 A가 재생 중이면 다음 항목을 B에 미리 로드하고 첫 프레임까지 디코드해 둔다.
//      seeked 이벤트는 해당 프레임의 디코드가 끝나야 발생하므로, 이 시점에 B는
//      "보이지 않지만 첫 프레임을 들고 있는" 상태다.
//   3. A의 종료 지점에서 같은 태스크 안에서 B를 띄우고 A를 내린다.
//      화면은 A의 마지막 프레임 → B의 첫 프레임으로 바뀐다. 검은 프레임이 낄 자리가 없다.
//
// 전환 시점 판정에 timeupdate(250ms 간격)는 쓰지 않는다. 타이머(보장)와
// requestVideoFrameCallback(정밀) 두 경로를 함께 쓴다 — #watch 주석 참조.

const EPS_MS = 12;          // 반 프레임(60fps 기준) 여유

// 프리롤 — 전환 직전에 대기 레이어를 아주 느린 속도로 미리 돌려 파이프라인을 깨워 둔다.
//
// 정지 상태의 요소에 play() 를 걸면 첫 프레임이 나오기까지 재개 지연이 붙는다(실측 약 40ms,
// 프레임을 합쳐 73ms). z-index/opacity 를 바꿔봐도 같았으므로 합성 비용이 아니라 재생
// 파이프라인 기동 비용이다.
//
// 그래서 "정지된 것을 재생시키는" 대신 "이미 재생 중인 것의 속도를 되돌리는" 방식으로 바꾼다.
// 배속은 Chromium 의 하한인 0.0625 를 쓴다. 그 아래로 내리면 재생이 걸리지 않는다
// (0.02 로 시도했다가 프리롤이 통째로 무산됐다 — 스킵 사유를 기록해서 잡았다).
// 실측: 프리롤 약 270ms 에서 전환 간극이 73.5ms → 11.7ms(0.35프레임분)로 줄었다.
// 대가로 각 클립의 앞부분 약 100ms(3프레임)를 건너뛴다 — 눈에 보이는 정지를 없애는 값으로는
// 싸다. 앞부분을 한 프레임도 못 버리는 편성이 생기면 PREROLL_MS 를 낮춰 조절한다.
const PREROLL_MS = 200;
const PREROLL_RATE = 0.0625;

// hls.js 는 HLS 소스를 처음 물릴 때만 불러온다(로컬 파일만 쓰는 채널에는 필요 없다).
let _Hls = null;
async function loadHls() {
  if (!_Hls) _Hls = (await import('/vendor/hls.min.mjs')).default;
  return _Hls;
}
const nativeHls = el => !!el.canPlayType('application/vnd.apple.mpegurl');
const DEFAULT_LEAD = { local: 10_000, folder: 10_000, cloudflare: 20_000, bunny: 20_000, youtube: 30_000 };

export class SeamlessEngine {
  /**
   * @param {HTMLElement} mount  두 레이어를 담을 컨테이너
   * @param {{onSeam?:Function,onState?:Function,loop?:boolean}} opts
   */
  constructor(mount, opts = {}) {
    this.mount = mount;
    this.opts = opts;
    this.items = [];
    this.index = -1;
    this.running = false;
    this.seq = 0;                  // 프리로드 경합 방지용 토큰

    const mk = () => {
      const v = document.createElement('video');
      v.playsInline = true;
      v.preload = 'auto';
      v.muted = true;
      // 두 레이어를 모두 불투명하게 두고 z-index 로만 앞뒤를 바꾼다.
      // opacity:0 으로 숨기면 합성에서 빠졌다가 다시 올라올 때 레이어 승격 비용이 붙는다.
      // 뒤에 있는 레이어는 앞 레이어가 완전히 가리므로 보이지 않으면서도 계속 합성된다.
      Object.assign(v.style, {
        position: 'absolute', inset: '0', width: '100%', height: '100%',
        objectFit: 'contain', background: '#000', zIndex: '1',
      });
      mount.appendChild(v);
      return v;
    };
    this.a = mk();
    this.b = mk();
    this.active = this.a;
    this.standby = this.b;

    // 전환 계측 — 2단계 완료 기준이 "검은 프레임 0" 이라 실측값을 남긴다.
    this.lastPresentAt = 0;
    this.pendingSeam = null;
  }

  /* ── 공개 API ─────────────────────────────────── */

  load(items) {
    this.items = items || [];
    return this;
  }

  /**
   * 재생 중에 편성 목록을 갈아끼운다 (롤링 윈도우).
   * 목록이 20초마다 바뀐다고 매번 처음부터 다시 틀면 24시간 채널이 성립하지 않는다.
   * 지금 나가는 항목을 key 로 다시 찾아 인덱스만 맞추고, 재생은 건드리지 않는다.
   */
  update(items) {
    const curKey = this.#keyOf(this.current);
    this.items = items || [];
    if (curKey != null) {
      const i = this.items.findIndex(x => this.#keyOf(x) === curKey);
      // 현재 항목이 윈도우에서 빠졌으면 인덱스를 -1 로 둔다 — 재생은 그대로 두고
      // 다음 전환에서 새 목록의 첫 항목으로 넘어간다.
      this.index = i >= 0 ? i : -1;
    }
    this.rollFor = null;              // 다음 항목이 바뀌었을 수 있으니 프리롤을 다시 잡는다
    this.#prepareNext();
    return this;
  }

  /**
   * 하루 중 지정 시각으로 합류한다.
   * 24시간 채널은 언제 시작하든 "지금 나가야 할 지점"부터 나가야 한다.
   */
  async startAt(timeOfDayMs) {
    const i = this.items.findIndex(x =>
      x.startMs != null && x.startMs <= timeOfDayMs && timeOfDayMs < x.endMs);
    if (i < 0) return this.start(0);
    const offset = timeOfDayMs - this.items[i].startMs;
    return this.start(i, offset);
  }

  async start(index = 0, offsetMs = 0) {
    if (!this.items.length) return;
    this.running = true;
    this.index = index;
    await this.#mountInto(this.active, this.items[this.index], offsetMs);
    this.active.style.zIndex = '2';
    this.standby.style.zIndex = '1';
    this.active.muted = false;
    await this.#safePlay(this.active);
    this.active.addEventListener('ended', this.#onEnded, { once: true });
    this.#watch();
    this.#emitState('playing');
    this.#prepareNext();
  }

  stop() {
    this.running = false;
    clearTimeout(this.endTimer);
    clearTimeout(this.preTimer);
    clearTimeout(this.rollTimer);
    this.rollFor = null;
    for (const v of [this.a, this.b]) {
      try { v.pause(); } catch {}
      this.#detach(v);
      v.removeAttribute('src');
      v.load();
      v.style.zIndex = '1';
    }
    this.#emitState('stopped');
  }

  /** 현재 항목을 끊고 다음으로 (운영자 개입) */
  skip() { if (this.running) this.#handoff('skip'); }

  get current() { return this.items[this.index] || null; }
  get next() { return this.items[(this.index + 1) % this.items.length] || null; }

  /* ── 내부 ─────────────────────────────────────── */

  #endOf(item) {
    const outMs = item.trimOutMs ?? item.durationMs;
    return outMs / 1000;
  }
  #startOf(item) { return (item.trimInMs ?? 0) / 1000; }

  #leadMs(item) { return DEFAULT_LEAD[item.sourceType] ?? DEFAULT_LEAD.local; }

  /** 붙어 있던 HLS 인스턴스를 떼어낸다. 24시간 운영에서 이걸 빠뜨리면 메모리가 샌다. */
  #detach(el) {
    if (el._hls) { try { el._hls.destroy(); } catch {} el._hls = null; }
  }

  /**
   * readyState 가 기준에 이를 때까지 기다린다.
   * 전환이 안전한 조건은 "디코드된 프레임을 들고 있는가"(readyState>=2)이지
   * "메타데이터를 읽었는가"가 아니다. 시간이 흐르면 알아서 채워지겠거니 하고
   * 넘기면, 느린 소스에서 전환이 보류되거나 밀린다.
   */
  #untilReady(el, min = 2, timeoutMs = 20000) {
    if (el.readyState >= min) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const check = () => { if (el.readyState >= min) { cleanup(); resolve(); } };
      const fail = () => { cleanup(); reject(new Error(`준비 시간 초과 (readyState=${el.readyState})`)); };
      const timer = setTimeout(fail, timeoutMs);
      const iv = setInterval(check, 50);
      const cleanup = () => {
        clearTimeout(timer); clearInterval(iv);
        el.removeEventListener('loadeddata', check);
        el.removeEventListener('canplay', check);
      };
      el.addEventListener('loadeddata', check);
      el.addEventListener('canplay', check);
    });
  }

  /** 요소에 항목을 물리고 첫 프레임까지 디코드시킨다. */
  #keyOf(it) { return it ? (it.key ?? it.id) : null; }

  async #mountInto(el, item, offsetMs = 0) {
    if (!item) return;
    const token = ++this.seq;
    this.#detach(el);
    el.muted = true;

    if (item.playbackType === 'hls' && !nativeHls(el)) {
      // Chromium 은 HLS 를 기본 지원하지 않는다. Safari 는 src 로 바로 된다.
      const Hls = await loadHls();
      if (!Hls.isSupported()) throw new Error('이 환경은 HLS 를 재생할 수 없습니다');
      const hls = new Hls({ enableWorker: true, maxBufferLength: 30, backBufferLength: 10 });
      el._hls = hls;
      hls.attachMedia(el);
      hls.loadSource(item.url);
      await new Promise((resolve, reject) => {
        hls.once(Hls.Events.MANIFEST_PARSED, resolve);
        hls.on(Hls.Events.ERROR, (_e, d) => { if (d?.fatal) reject(new Error('HLS: ' + d.details)); });
      });
    } else {
      el.src = item.url;
      el.load();
      await this.#once(el, 'loadedmetadata');
    }

    if (token !== this.seq && el === this.standby) { this.#detach(el); return; }  // 그 사이 편성이 바뀜
    const at = this.#startOf(item) + (offsetMs || 0) / 1000;
    if (at > 0) {
      el.currentTime = at;
      await this.#once(el, 'seeked');                        // 이 프레임의 디코드 완료를 뜻한다
    }
    await this.#untilReady(el, 2);
    el.playbackRate = 1;
    el.dataset.itemId = item.id;
    delete el.dataset.prerolled;
    delete el.dataset.prerollAt;
  }

  /** 전환 직전, 대기 레이어를 아주 느리게 돌려 파이프라인을 깨운다. */
  #preroll() {
    const el = this.standby, nxt = this.next;
    this.prerollSkip = null;
    if (!nxt) { this.prerollSkip = 'no-next'; return; }
    if (el.dataset.itemId !== nxt.id) {
      this.prerollSkip = `item-mismatch(${el.dataset.itemId || 'none'})`; return;
    }
    if (el.dataset.prerolled) { this.prerollSkip = 'already'; return; }
    if (el.readyState < 2) { this.prerollSkip = `readyState=${el.readyState}`; return; }
    el.dataset.prerolled = '1';
    el.dataset.prerollAt = String(performance.now());
    this.prerollFired = true;
    el.muted = true;
    el.playbackRate = PREROLL_RATE;
    const p = el.play();
    if (p && p.catch) p.catch(err => {
      delete el.dataset.prerolled;
      this.prerollSkip = 'play-rejected:' + (err?.name || 'unknown');
    });
  }

  /** 다음 항목을 대기 레이어에 미리 실어 둔다. */
  async #prepareNext() {
    const nxt = this.next;
    if (!nxt) return;
    if (this.standby.dataset.itemId === nxt.id && this.standby.readyState >= 2) return;
    try {
      await this.#mountInto(this.standby, nxt);
      this.standbyReadyAt = performance.now();
    } catch (e) {
      console.warn('[engine] 프리로드 실패:', nxt.title, e?.message);
      this.standby.dataset.failed = '1';
    }
  }

  /**
   * 종료 지점 감시 — 두 경로를 함께 쓴다.
   *
   *   ① 타이머   남은 시간에 맞춰 예약. **반드시** 발화하는 보장 경로.
   *   ② rVFC     매 표시 프레임마다 확인. 프레임 단위로 정확하지만 탭이 가려지거나
   *              합성이 멈추면 발화가 지연·중단된다. 정밀도만 담당한다.
   *
   * 초기 구현은 ②만 썼는데, 렌더링이 스로틀되는 환경에서 전환이 30초까지 밀렸다.
   * 정밀도를 위한 장치가 정확성의 단일 실패점이 되어서는 안 된다.
   */
  #watch() {
    this.#arm();
    const el = this.active;
    if (!el.requestVideoFrameCallback) return;
    const tick = (now) => {
      if (!this.running || el !== this.active || this.switching) return;
      this.lastPresentAt = now;
      const item = this.current;
      if (!item) return;
      const remainMs = (this.#endOf(item) - el.currentTime) * 1000;
      if (remainMs <= EPS_MS) { this.#handoff('frame'); return; }
      el.requestVideoFrameCallback(tick);
    };
    el.requestVideoFrameCallback(tick);
  }

  /** 남은 시간을 계산해 프리로드와 전환을 예약한다. */
  #arm() {
    clearTimeout(this.endTimer);
    clearTimeout(this.preTimer);
    if (!this.running || this.switching) return;
    const item = this.current;
    if (!item) return;

    const rate = this.active.playbackRate || 1;
    const remainMs = ((this.#endOf(item) - this.active.currentTime) * 1000) / rate;
    if (remainMs <= EPS_MS) { this.#handoff('timer'); return; }

    const leadIn = remainMs - this.#leadMs(item);
    if (leadIn <= 0) this.#prepareNext();
    else this.preTimer = setTimeout(() => this.#prepareNext(), leadIn);

    // 프리롤은 항목당 한 번만 예약한다.
    // #arm() 은 1초마다 다시 도는데, 그때마다 타이머를 다시 걸면 매번 취소되어
    // 끝내 실행되지 않는다(첫 구현의 실제 버그였다).
    if (this.rollFor !== item.id) {
      this.rollFor = item.id;
      this.prerollFired = false;
      this.prerollSkip = null;
      clearTimeout(this.rollTimer);
      this.rollTimer = setTimeout(() => this.#preroll(), Math.max(0, remainMs - PREROLL_MS));
    }

    // 재생이 멈추거나(버퍼링) 시각이 어긋날 수 있으므로 주기적으로 다시 계산한다.
    const wait = Math.min(remainMs, 1000);
    this.endTimer = setTimeout(() => this.#arm(), Math.max(8, wait - 4));
  }

  #onEnded = () => { if (this.running) this.#handoff('ended'); };

  /**
   * 전환. 같은 태스크 안에서 레이어를 맞바꿔 중간에 아무것도 끼지 않게 한다.
   */
  #handoff(reason) {
    if (!this.running || this.switching) return;
    this.switching = true;
    clearTimeout(this.endTimer);
    clearTimeout(this.preTimer);
    clearTimeout(this.rollTimer);
    this.rollFor = null;

    const from = this.current;
    const to = this.next;
    const t0 = performance.now();
    const ready = this.standby.readyState;
    // 지금 전환에 쓰이는 레이어가 '언제 준비됐는지'를 여기서 붙잡아 둔다.
    // 아래에서 #prepareNext() 가 다음 항목을 준비하며 standbyReadyAt 을 덮어쓰므로,
    // 보고 시점에 읽으면 다음 항목의 값이 잡힌다 (실제로 항상 -20ms 가 나왔다).
    const readyAt = this.standbyReadyAt;

    // 대기 레이어가 준비되지 않았다면 전환하지 않는다.
    // 화면이 끊기느니 현재 항목을 조금 더 재생하는 편이 낫다.
    if (!to || ready < 2 || this.standby.dataset.itemId !== to.id) {
      console.warn('[engine] 대기 레이어 미준비 → 전환 보류', { ready, want: to?.id });
      this.switching = false;
      this.#prepareNext();
      this.endTimer = setTimeout(() => { if (this.running) this.#handoff('retry'); }, 120);
      return;
    }

    const oldActive = this.active;
    const newActive = this.standby;

    // ① 새 레이어를 앞으로, ② 옛 레이어를 뒤로 — 같은 태스크, 같은 프레임.
    newActive.style.zIndex = '2';
    oldActive.style.zIndex = '1';
    newActive.muted = false;
    oldActive.muted = true;
    // 프리롤이 걸려 있으면 이미 재생 중이므로 속도만 되돌린다(재개 지연 없음).
    const prerolled = newActive.dataset.prerolled === '1' && !newActive.paused;
    const prerollMs = prerolled && newActive.dataset.prerollAt
      ? +(t0 - Number(newActive.dataset.prerollAt)).toFixed(0) : null;
    newActive.playbackRate = 1;
    if (!prerolled) { const p = newActive.play(); if (p && p.catch) p.catch(() => {}); }

    this.active = newActive;
    this.standby = oldActive;
    this.index = (this.index + 1) % this.items.length;

    // 옛 레이어 정리 — 다음 프리로드에서 다시 쓴다.
    try { oldActive.pause(); } catch {}
    this.#detach(oldActive);
    oldActive.removeAttribute('src');
    delete oldActive.dataset.itemId;
    oldActive.load();
    newActive.addEventListener('ended', this.#onEnded, { once: true });

    // 계측이 늦어져도 재생은 계속되어야 한다 — 감시·프리로드를 먼저 재무장한다.
    this.switching = false;
    this.#watch();
    this.#prepareNext();
    this.#emitState('playing');

    // 새 레이어의 첫 표시 프레임을 계측한다.
    //
    // 여기서 재는 "간극"은 화면이 비어 있던 시간이 아니다. 검은 프레임은 구조적으로 생기지
    // 않는다 — 위에서 readyState<2 이면 전환 자체를 거부하므로, opacity 를 바꾸는 순간
    // 새 레이어는 이미 디코드된 첫 프레임을 들고 있다.
    // 실제로 재는 것은 **재생 파이프라인이 다음 프레임을 내놓기까지의 지연**이다.
    // 이 값이 크면 새 클립의 첫 프레임이 오래 붙들려 순간 정지처럼 보인다.
    //
    // 판정 기준은 소스 프레임레이트에 맞춘다. 30fps 소스의 한 프레임은 33.3ms 이므로
    // 60fps 기준의 고정 임계값(34ms)을 쓰면 정상 전환도 의심으로 잡힌다.
    const frameMs = 1000 / (to.fps || from?.fps || 30);
    let done = false;
    const report = (measuredBy, meta) => {
      if (done) return;
      done = true;
      const gap = +(performance.now() - t0).toFixed(1);
      this.opts.onSeam?.({
        from: from?.title ?? '—',
        to: to.title,
        reason,
        presentGapMs: gap,
        measuredBy,
        frameMs: +frameMs.toFixed(1),
        heldFrames: +(gap / frameMs).toFixed(2),     // 첫 프레임이 몇 프레임분 붙들렸나
        firstMediaTime: meta ? +meta.mediaTime.toFixed(3) : null,
        prerolled,                                   // 프리롤로 파이프라인이 깨어 있었나
        prerollMs,                                   // 프리롤이 실제로 돈 시간
        prerollSkip: prerolled ? null
          : (this.prerollSkip || (this.prerollFired ? 'play-not-started' : 'not-fired')),
        standbyReadyState: ready,                    // 2 이상이면 디코드된 프레임 보유 = 검은 화면 아님
        // 다음 항목이 전환보다 얼마나 미리 준비됐나 = 여유(headroom).
        // 디코더가 부족해지면 이 값이 먼저 줄어든다.
        preparedMsAhead: readyAt ? +(t0 - readyAt).toFixed(0) : null,
        suspect: measuredBy === 'frame' && gap > frameMs * 2.5,
      });
    };
    if (newActive.requestVideoFrameCallback) {
      newActive.requestVideoFrameCallback((_now, meta) => report('frame', meta));
    }
    setTimeout(() => report('timeout'), 250);   // rVFC 가 죽어도 계측은 남긴다
  }

  async #safePlay(el) {
    try { await el.play(); }
    catch (e) { console.warn('[engine] play 거부(사용자 제스처 필요):', e.message); }
  }

  #once(el, ev) {
    return new Promise((resolve, reject) => {
      const ok = () => { cleanup(); resolve(); };
      const ng = () => { cleanup(); reject(new Error(ev + ' 실패: ' + (el.error?.message || 'unknown'))); };
      const cleanup = () => { el.removeEventListener(ev, ok); el.removeEventListener('error', ng); };
      el.addEventListener(ev, ok, { once: true });
      el.addEventListener('error', ng, { once: true });
    });
  }

  #emitState(status) {
    // 장시간 운영에서 메모리가 새는지 보려면 추이가 필요하다 (§9 리스크 4).
    const heap = performance?.memory?.usedJSHeapSize;
    this.opts.onState?.({
      status,
      heapMB: heap ? +(heap / 1048576).toFixed(1) : null,
      total: this.items.length,
      index: this.index,
      current: this.current ? { id: this.current.id, title: this.current.title } : null,
      next: this.next ? { id: this.next.id, title: this.next.title } : null,
      currentTime: this.active?.currentTime ?? 0,
      standbyReady: this.standby?.readyState ?? 0,
    });
  }
}
