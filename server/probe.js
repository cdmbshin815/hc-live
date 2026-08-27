// ffprobe 래퍼 — 길이·해상도를 정확히 얻는다.
// 길이(durationMs)는 자동 편성과 시작 시각 계산의 전제이므로 추정하지 않고 실측한다.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';

const run = promisify(execFile);

const CANDIDATE_DIRS = [
  process.env.FFMPEG_DIR,
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  path.join(process.env.HOME || '', 'Downloads/plugins/.local/ffmpeg/bin'),
].filter(Boolean);

async function resolveBin(name, envVar) {
  if (process.env[envVar]) return process.env[envVar];
  try {
    const { stdout } = await run('which', [name]);
    const p = stdout.trim();
    if (p) return p;
  } catch { /* PATH 에 없음 — 후보 경로를 훑는다 */ }
  for (const dir of CANDIDATE_DIRS) {
    const p = path.join(dir, name);
    try { await access(p, constants.X_OK); return p; } catch { /* 다음 후보 */ }
  }
  return null;
}

let _ffmpeg, _ffprobe;
export async function ffmpegPath()  { return _ffmpeg  ??= await resolveBin('ffmpeg',  'FFMPEG_PATH'); }
export async function ffprobePath() { return _ffprobe ??= await resolveBin('ffprobe', 'FFPROBE_PATH'); }

/**
 * 미디어 파일의 길이·해상도를 읽는다.
 * @returns {Promise<{durationMs:number,width:number,height:number,fps:number}|null>}
 */
export async function probe(file) {
  const bin = await ffprobePath();
  if (!bin) return null;
  try {
    const { stdout } = await run(bin, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate:format=duration',
      '-of', 'json',
      file,
    ]);
    const j = JSON.parse(stdout);
    const s = j.streams?.[0] || {};
    const [num, den] = String(s.r_frame_rate || '0/1').split('/').map(Number);
    return {
      durationMs: Math.round(parseFloat(j.format?.duration || 0) * 1000),
      width: s.width || 0,
      height: s.height || 0,
      fps: den ? +(num / den).toFixed(3) : 0,
    };
  } catch {
    return null;
  }
}
