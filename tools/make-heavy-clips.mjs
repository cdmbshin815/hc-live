// 부하 실측용 클립 — 디코딩 부하가 실제 콘텐츠에 가깝도록 만든다.
//
// 검증용 단색 클립은 압축이 너무 잘 돼(수백 kbps) 디코딩이 사실상 공짜다.
// 그걸로 잰 채널 수는 실제 운영에서 재현되지 않는다.
// 여기서는 mandelbrot 로 화면 전체가 매 프레임 바뀌는 영상을 만들어
// 실제 1080p 콘텐츠 수준의 비트레이트를 낸다.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ffmpegPath } from '../server/probe.js';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'media', 'heavy');

const CLIPS = [
  { name: 'heavy-01', dur: 12, start: 0.6 },
  { name: 'heavy-02', dur: 8,  start: 1.1 },
  { name: 'heavy-03', dur: 15, start: 1.6 },
  { name: 'heavy-04', dur: 10, start: 2.1 },
];

const ff = await ffmpegPath();
if (!ff) { console.error('ffmpeg 를 찾지 못했습니다'); process.exit(1); }
mkdirSync(OUT, { recursive: true });

for (const c of CLIPS) {
  const file = path.join(OUT, `${c.name}.mp4`);
  process.stdout.write(`${c.name} (${c.dur}초) … `);
  await run(ff, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i',
      `mandelbrot=s=1920x1080:rate=30:maxiter=400:start_scale=${c.start}`,
    '-f', 'lavfi', '-i', `sine=frequency=330:duration=${c.dur}:sample_rate=48000`,
    '-t', String(c.dur),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart',
    file,
  ]);
  const mb = statSync(file).size / 1048576;
  console.log(`완료 · ${mb.toFixed(1)} MB · 약 ${(mb * 8 / c.dur).toFixed(1)} Mbps`);
}
console.log(`\n${CLIPS.length}개 → ${OUT}`);
