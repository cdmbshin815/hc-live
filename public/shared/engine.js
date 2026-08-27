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
      Object.assign(v.style, {
        position: 'absolute', inset: '0', width: '100%', height: '100%',
        objectFit: 'contain', background: '#000', opacity: '0',
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

  async start(index = 0) {
    if (!this.items.length) return;
    this.running = true;
    this.index = index;
    await this.#mountInto(this.active, this.items[this.index]);
    this.active.style.opacity = '1';
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
    for (const v of [this.a, this.b]) {
      try { v.pause(); } catch {}
      v.removeAttribute('src');
      v.load();
      v.style.opacity = '0';
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

  /** 요소에 항목을 물리고 첫 프레임까지 디코드시킨다. */
  async #mountInto(el, item) {
    if (!item) return;
    const token = ++this.seq;
    el.muted = true;
    el.src = item.url;
    el.load();
    await this.#once(el, 'loadedmetadata');
    if (token !== this.seq && el === this.standby) return;   // 그 사이 편성이 바뀜
    const at = this.#startOf(item);
    if (at > 0 || el.currentTime !== at) {
      el.currentTime = at;
      await this.#once(el, 'seeked');                        // 이 프레임의 디코드 완료를 뜻한다
    }
    el.dataset.itemId = item.id;
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

    const from = this.current;
    const to = this.next;
    const t0 = performance.now();
    const ready = this.standby.readyState;

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

    // ① 새 레이어를 올리고 ② 옛 레이어를 내린다 — 같은 태스크, 같은 프레임.
    newActive.style.opacity = '1';
    oldActive.style.opacity = '0';
    newActive.muted = false;
    oldActive.muted = true;
    const p = newActive.play();
    if (p && p.catch) p.catch(() => {});

    this.active = newActive;
    this.standby = oldActive;
    this.index = (this.index + 1) % this.items.length;

    // 옛 레이어 정리 — 다음 프리로드에서 다시 쓴다.
    try { oldActive.pause(); } catch {}
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
        standbyReadyState: ready,                    // 2 이상이면 디코드된 프레임 보유 = 검은 화면 아님
        preparedMsAhead: this.standbyReadyAt ? +(t0 - this.standbyReadyAt).toFixed(0) : null,
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
    this.opts.onState?.({
      status,
      index: this.index,
      current: this.current ? { id: this.current.id, title: this.current.title } : null,
      next: this.next ? { id: this.next.id, title: this.next.title } : null,
      currentTime: this.active?.currentTime ?? 0,
      standbyReady: this.standby?.readyState ?? 0,
    });
  }
}
