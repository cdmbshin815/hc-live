// Cloudflare Stream 어댑터.
//
// 필요한 자격증명 (설정 화면에서 입력, data/credentials.json 에 저장 — 저장소에 올라가지 않음)
//   accountId : Cloudflare 계정 ID
//   apiToken  : Stream:Read 권한이 있는 API 토큰
//   creator   : 이 크리에이터의 영상만 가져온다. Live Player 는 hcjoynLive 를 쓴다.
//   customerSubdomain : (선택) 재생 도메인. 예: customer-xxxxxxxx
//
// 실계정으로 검증했다 (2026-08-28, 계정 98ba71…). 필드 매핑은 실제 응답과 일치한다.
//
// ⚠ creator 는 안전장치다 — 이 Cloudflare 계정은 CDMB CMS 와 공용이며 CMS 영상은
//   creator=cms 로 들어 있다. creator 를 비우면 CMS 의 설명서 영상까지 라이브러리에
//   딸려 들어와 편성에 섞인다. 반드시 지정해서 쓴다.
const API = 'https://api.cloudflare.com/client/v4';

const idOf = uid => 'cf_' + uid;

/** 계정의 영상 목록을 가져와 공통 Item 으로 정규화한다. */
export async function sync({ accountId, apiToken, creator, customerSubdomain }, { limit = 1000 } = {}) {
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
        // 응답의 playback.hls 를 우선 쓴다. 없을 때만 도메인을 조립한다.
        url: v.playback?.hls || (customerSubdomain
          ? `https://${customerSubdomain}.cloudflarestream.com/${v.uid}/manifest/video.m3u8`
          : `https://videodelivery.net/${v.uid}/manifest/video.m3u8`),
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
  if (!creator) {
    return { ok: true, message: `연결됨 · ⚠ creator 미지정 — 계정의 모든 영상이 딸려 옵니다` };
  }
  return {
    ok: true,
    message: `연결됨 · creator=${creator}` + (n ? '' : ' · 해당 영상 없음'),
  };
}
