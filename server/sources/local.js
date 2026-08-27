// 로컬 파일 · 지정 폴더 어댑터.
// media/ 아래의 영상 파일과 HLS 플레이리스트를 훑어 공통 Item 으로 정규화한다.
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { probe } from '../probe.js';

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm']);
const HLS_EXT = '.m3u8';

async function walk(dir, out = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { await walk(full, out); continue; }
    const ext = path.extname(e.name).toLowerCase();
    if (VIDEO_EXT.has(ext) || ext === HLS_EXT) out.push(full);
  }
  return out;
}

const urlOf = rel => '/media/' + rel.split(path.sep).map(encodeURIComponent).join('/');
const idOf  = rel => 'i_' + Buffer.from(rel).toString('base64url').slice(0, 22);

/**
 * @param {string} mediaRoot
 * @param {Array} prevItems  이전 스캔 결과 (변경 없는 파일은 다시 probe 하지 않는다)
 */
export async function scan(mediaRoot, prevItems = []) {
  const files = await walk(mediaRoot);
  const prev = new Map(prevItems.map(i => [i.path, i]));
  const items = [];

  for (const full of files) {
    const rel = path.relative(mediaRoot, full);
    const isHls = path.extname(full).toLowerCase() === HLS_EXT;
    const st = await stat(full);
    const cached = prev.get(rel);

    // 크기·mtime 이 같으면 재탐색을 건너뛴다. HLS 는 세그먼트가 바뀌어도 플레이리스트가
    // 그대로일 수 있으므로 캐시를 믿지 않는다.
    if (cached && !isHls && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
      items.push(cached);
      continue;
    }

    const meta = await probe(full);
    // HLS 는 디렉터리명이 곧 이름인 편이 읽기 좋다 (…/clip-01-red/index.m3u8).
    const title = isHls
      ? path.basename(path.dirname(rel))
      : path.basename(rel, path.extname(rel));

    items.push({
      id: idOf(rel),
      sourceType: isHls ? 'hls' : 'local',
      playbackType: isHls ? 'hls' : 'file',
      title,
      path: rel,
      url: urlOf(rel),
      durationMs: meta?.durationMs ?? 0,
      width: meta?.width ?? 0,
      height: meta?.height ?? 0,
      fps: meta?.fps ?? 0,
      isLocal: true,
      status: meta?.durationMs ? 'ready' : 'error',
      size: st.size,
      mtimeMs: st.mtimeMs,
    });
  }

  items.sort((a, b) => a.title.localeCompare(b.title, 'ko'));
  return items;
}
