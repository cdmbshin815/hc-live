// 무결절 검증용 테스트 클립 생성.
// 각 클립은 고유 색 + 프레임 번호 + 좌우로 쓸고 가는 흰 막대를 가진다.
// 막대가 순간이라도 멈추거나 화면이 검게 되면 녹화본에서 바로 눈에 띈다.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ffmpegPath } from '../server/probe.js';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'media', 'test');

// 길이를 일부러 어긋나게 둔다 — 자투리·공백 계산을 함께 검증하기 위해.
const CLIPS = [
  { name: 'clip-01-red',    color: '0x8C2F2A', hz: 220, dur: 12 },
  { name: 'clip-02-green',  color: '0x2F6B4F', hz: 277, dur: 8 },
  { name: 'clip-03-blue',   color: '0x2A4E8C', hz: 330, dur: 15 },
  { name: 'clip-04-amber',  color: '0x8C6A2A', hz: 392, dur: 6 },
  { name: 'clip-05-purple', color: '0x5B3A8C', hz: 440, dur: 20 },
  { name: 'clip-06-teal',   color: '0x2A7D8C', hz: 494, dur: 9 },
];

const FONTS = [
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
];
const font = FONTS.find(f => existsSync(f));

function filters(label) {
  const bar = "drawbox=x='(iw-220)*mod(t\\,2)/2':y=ih-160:w=220:h=90:color=white@0.92:t=fill";
  if (!font) return bar;
  const esc = font.replace(/:/g, '\\:');
  const big = `drawtext=fontfile='${esc}':text='${label}':fontcolor=white:fontsize=150:x=(w-tw)/2:y=(h-th)/2-90`;
  const num = `drawtext=fontfile='${esc}':text='%{n}':fontcolor=white@0.85:fontsize=90:x=(w-tw)/2:y=(h-th)/2+90`;
  const tc  = `drawtext=fontfile='${esc}':text='%{pts\\:hms}':fontcolor=white@0.6:fontsize=48:x=60:y=60`;
  return [bar, big, num, tc].join(',');
}

async function main() {
  const ff = await ffmpegPath();
  if (!ff) {
    console.error('ffmpeg 를 찾지 못했습니다. PATH 에 추가하거나 FFMPEG_PATH 를 지정하세요.');
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });
  if (!font) console.warn('시스템 폰트를 찾지 못해 프레임 번호 없이 생성합니다.');

  for (const c of CLIPS) {
    const file = path.join(OUT, `${c.name}.mp4`);
    const label = c.name.split('-')[1] + ' ' + c.name.split('-')[2].toUpperCase();
    process.stdout.write(`${c.name} (${c.dur}초) … `);
    await run(ff, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=${c.color}:s=1920x1080:r=30:d=${c.dur}`,
      '-f', 'lavfi', '-i', `sine=frequency=${c.hz}:duration=${c.dur}:sample_rate=48000`,
      '-vf', filters(label),
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
      '-c:a', 'aac', '-b:a', '128k', '-shortest',
      '-movflags', '+faststart',
      file,
    ]);
    console.log('완료');
  }
  console.log(`\n${CLIPS.length}개 클립 → ${OUT}`);

  // HLS 렌디션 — Cloudflare Stream·Bunny Stream 과 같은 재생 경로(hls.js)를 로컬에서 검증한다.
  // 외부 계정 없이 어댑터와 엔진의 HLS 경로를 끝까지 확인할 수 있다.
  const HLS_OUT = path.join(ROOT, 'media', 'hls');
  mkdirSync(HLS_OUT, { recursive: true });
  for (const c of CLIPS.slice(0, 3)) {
    const dir = path.join(HLS_OUT, c.name);
    mkdirSync(dir, { recursive: true });
    process.stdout.write(`HLS ${c.name} … `);
    await run(ff, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', path.join(OUT, `${c.name}.mp4`),
      '-c', 'copy',
      '-f', 'hls',
      '-hls_time', '4',
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(dir, 'seg%03d.ts'),
      path.join(dir, 'index.m3u8'),
    ]);
    console.log('완료');
  }
  console.log(`3개 HLS → ${HLS_OUT}`);
}

main().catch(e => { console.error(e.stderr || e.message); process.exit(1); });
