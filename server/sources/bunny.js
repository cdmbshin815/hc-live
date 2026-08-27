// Bunny Stream 어댑터.
//
// 필요한 자격증명 (설정 화면에서 입력, data/credentials.json 에 저장 — 저장소에 올라가지 않음)
//   libraryId : Video Library ID
//   apiKey    : 해당 라이브러리의 API 키
//   cdnHost   : 재생용 호스트 (예: vz-xxxxxxxx.b-cdn.net)
//
// 실계정으로 검증했다 (2026-08-28, library 738476). 아래 필드 매핑은 실제 응답과 일치한다.
//
// status 코드: 3=트랜스코딩 중, 4=완료. 4 미만은 HLS 가 403 을 돌려주므로 편성 대상이 아니다.
//
// 핫링크 보호 주의 — Bunny 풀존은 기본적으로 **레퍼러 없는 요청을 차단**한다.
// 브라우저는 레퍼러를 보내므로 재생에는 문제가 없지만, 서버에서 curl 등으로 확인하면
// 403 이 나온다. 서버 쪽에서 접근해야 할 일이 생기면 Referer 를 붙여야 한다.
const API = 'https://video.bunnycdn.com';

const idOf = guid => 'bn_' + guid;

/** 라이브러리의 영상 목록을 가져와 공통 Item 으로 정규화한다. */
export async function sync({ libraryId, apiKey, cdnHost }, { limit = 1000 } = {}) {
  if (!libraryId || !apiKey) throw new Error('Bunny: libraryId 와 apiKey 가 필요합니다');

  const items = [];
  let page = 1;
  const perPage = 100;

  while (items.length < limit) {
    const qs = new URLSearchParams({ page: String(page), itemsPerPage: String(perPage) });
    const res = await fetch(`${API}/library/${libraryId}/videos?${qs}`, {
      headers: { AccessKey: apiKey, accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Bunny Stream ${res.status}: ${await res.text()}`);
    const body = await res.json();

    const rows = body.items || [];
    if (!rows.length) break;

    for (const v of rows) {
      // length 는 초 단위 정수. status 4 = Finished (재생 가능).
      const durationMs = Math.round((v.length || 0) * 1000);
      const ready = v.status === 4 && durationMs > 0;
      const host = cdnHost || `vz-${libraryId}.b-cdn.net`;
      items.push({
        id: idOf(v.guid),
        sourceType: 'bunny',
        playbackType: 'hls',
        title: v.title || v.guid,
        url: `https://${host}/${v.guid}/playlist.m3u8`,
        thumbnail: v.thumbnailFileName ? `https://${host}/${v.guid}/${v.thumbnailFileName}` : null,
        durationMs,
        width: v.width ?? 0,
        height: v.height ?? 0,
        fps: v.framerate ?? 0,
        isLocal: false,               // 필러 후보가 될 수 없다 (§3.6)
        status: ready ? 'ready' : 'resolving',
        remoteId: v.guid,
        createdAt: v.dateUploaded || null,
      });
    }

    if (rows.length < perPage) break;
    page += 1;
  }

  return items;
}

/** 자격증명이 유효한지만 빠르게 확인한다. */
export async function verify({ libraryId, apiKey }) {
  const res = await fetch(`${API}/library/${libraryId}/videos?page=1&itemsPerPage=1`, {
    headers: { AccessKey: apiKey, accept: 'application/json' },
  });
  if (!res.ok) return { ok: false, message: `${res.status} ${res.statusText}` };
  const body = await res.json().catch(() => ({}));
  const total = body.totalItems ?? (body.items || []).length;
  const pending = (body.items || []).filter(v => v.status < 4).length;
  return {
    ok: true,
    message: `연결됨 · 영상 ${total}개` + (pending ? ` (인코딩 중 ${pending}개)` : ''),
  };
}
