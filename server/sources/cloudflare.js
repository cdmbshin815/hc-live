// Cloudflare Stream 어댑터.
//
// 필요한 자격증명 (설정 화면에서 입력, data/credentials.json 에 저장 — 저장소에 올라가지 않음)
//   accountId : Cloudflare 계정 ID
//   apiToken  : Stream:Read 권한이 있는 API 토큰
//
// ⚠ 아직 실계정으로 검증하지 않았다. 응답 필드는 공개 API 문서 기준으로 매핑했고,
//   자격증명이 준비되면 sync() 를 한 번 돌려 실제 응답과 대조해야 한다.
const API = 'https://api.cloudflare.com/client/v4';

const idOf = uid => 'cf_' + uid;

/** 계정의 영상 목록을 가져와 공통 Item 으로 정규화한다. */
export async function sync({ accountId, apiToken }, { limit = 1000 } = {}) {
  if (!accountId || !apiToken) throw new Error('Cloudflare: accountId 와 apiToken 이 필요합니다');

  const items = [];
  let before = null;

  // 커서 페이지네이션 — 한 번에 최대 1000건.
  while (items.length < limit) {
    const qs = new URLSearchParams({ limit: String(Math.min(1000, limit - items.length)) });
    if (before) qs.set('before', before);

    const res = await fetch(`${API}/accounts/${accountId}/stream?${qs}`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    if (!res.ok) throw new Error(`Cloudflare Stream ${res.status}: ${await res.text()}`);
    const body = await res.json();
    if (!body.success) throw new Error('Cloudflare Stream: ' + JSON.stringify(body.errors));

    const page = body.result || [];
    if (!page.length) break;

    for (const v of page) {
      // duration 은 초 단위 실수. 인코딩이 끝나지 않은 영상은 0 이거나 없다.
      const durationMs = Math.round((v.duration || 0) * 1000);
      const ready = v.readyToStream === true && durationMs > 0;
      items.push({
        id: idOf(v.uid),
        sourceType: 'cloudflare',
        playbackType: 'hls',
        title: v.meta?.name || v.uid,
        url: v.playback?.hls || `https://videodelivery.net/${v.uid}/manifest/video.m3u8`,
        thumbnail: v.thumbnail || null,
        durationMs,
        width: v.input?.width ?? 0,
        height: v.input?.height ?? 0,
        fps: 0,                       // Stream 목록 API 는 fps 를 주지 않는다
        isLocal: false,               // 필러 후보가 될 수 없다 (§3.6)
        status: ready ? 'ready' : 'resolving',
        remoteId: v.uid,
        createdAt: v.created || null,
      });
    }

    if (page.length < 1000) break;
    before = page[page.length - 1].created;
  }

  return items;
}

/** 자격증명이 유효한지만 빠르게 확인한다. */
export async function verify({ accountId, apiToken }) {
  const res = await fetch(`${API}/accounts/${accountId}/stream?limit=1`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  if (!res.ok) return { ok: false, message: `${res.status} ${res.statusText}` };
  const body = await res.json();
  return body.success
    ? { ok: true, message: '연결됨' }
    : { ok: false, message: JSON.stringify(body.errors) };
}
