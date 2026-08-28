// Cloudflare Stream 어댑터.
//
// 필요한 자격증명 (설정 화면에서 입력, data/credentials.json 에 저장 — 저장소에 올라가지 않음)
//   accountId : Cloudflare 계정 ID
//   apiToken  : Stream:Read 권한이 있는 API 토큰
//   creator   : (선택) 이 크리에이터의 영상만 가져온다. 예: hcjoynLive
//               한 계정을 여러 용도로 쓸 때 Live Player 가 다룰 범위를 좁히는 장치다.
//
// ⚠ 아직 실계정으로 검증하지 않았다. 응답 필드는 공개 API 문서 기준으로 매핑했고,
//   자격증명이 준비되면 sync() 를 한 번 돌려 실제 응답과 대조해야 한다.
const API = 'https://api.cloudflare.com/client/v4';

const idOf = uid => 'cf_' + uid;

/** 계정의 영상 목록을 가져와 공통 Item 으로 정규화한다. */
export async function sync({ accountId, apiToken, creator }, { limit = 1000 } = {}) {
  if (!accountId || !apiToken) throw new Error('Cloudflare: accountId 와 apiToken 이 필요합니다');

  const items = [];
  let before = null;

  // 커서 페이지네이션 — 한 번에 최대 1000건.
  while (items.length < limit) {
    const qs = new URLSearchParams({ limit: String(Math.min(1000, limit - items.length)) });
    if (before) qs.set('before', before);
    // creator 를 주면 그 크리에이터의 영상만 목록에 담긴다.
    if (creator) qs.set('creator', creator);

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
        creator: v.creator || null,
        remoteId: v.uid,
        createdAt: v.created || null,
      });
    }

    if (page.length < 1000) break;
    before = page[page.length - 1].created;
  }

  return items;
}

/** 자격증명이 유효한지 확인한다. creator 를 주면 그 범위로 확인한다. */
export async function verify({ accountId, apiToken, creator }) {
  const qs = new URLSearchParams({ limit: '1' });
  if (creator) qs.set('creator', creator);
  const res = await fetch(`${API}/accounts/${accountId}/stream?${qs}`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) {
    // Cloudflare 는 오류 사유를 errors[].message 에 담아 준다. 그대로 보여줘야
    // "토큰이 틀렸는지 권한이 없는지 계정 ID 가 틀렸는지"를 구분할 수 있다.
    const msg = body?.errors?.map(e => `${e.code}: ${e.message}`).join(' · ')
      || `${res.status} ${res.statusText}`;
    return { ok: false, message: msg };
  }
  const n = body.result?.length ?? 0;
  return {
    ok: true,
    message: `연결됨${creator ? ` · creator=${creator}` : ''}` + (n ? '' : ' · 영상 없음'),
  };
}
