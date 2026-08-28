// OBS 창 캡처 실검증 — 기획서 §9 리스크 3.
// 소스를 만들자마자 창을 지정한다. 창 없이 두면 OBS 가 Invalid target window ID 로
// 불안정해진다. 씬 제거도 하지 않는다(제거 시점에 OBS 가 죽는 것을 확인).
import OBSWebSocket from 'obs-websocket-js';
import { readFileSync, writeFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(process.env.HOME +
  '/Library/Application Support/obs-studio/plugin_config/obs-websocket/config.json', 'utf8'));
const obs = new OBSWebSocket();
await obs.connect(`ws://127.0.0.1:${cfg.server_port}`, cfg.server_password);

const SCENE = 'HC-캡처검증', SRC = 'HC-출력창';
const scenes = (await obs.call('GetSceneList')).scenes.map(s => s.sceneName);
if (!scenes.includes(SCENE)) await obs.call('CreateScene', { sceneName: SCENE });

const inputs = (await obs.call('GetInputList')).inputs.map(i => i.inputName);
if (!inputs.includes(SRC)) {
  await obs.call('CreateInput', {
    sceneName: SCENE, inputName: SRC, inputKind: 'screen_capture',
    inputSettings: { type: 1, show_cursor: false, show_empty_names: true },
  });
}

const items = (await obs.call('GetInputPropertiesListPropertyItems',
  { inputName: SRC, propertyName: 'window' })).propertyItems;
const hit = items.filter(w => /Live ?Player|출력/i.test(w.itemName));
console.log(`창 ${items.length}개 · HC Live 관련 ${hit.length}개`);
hit.forEach(w => console.log('   ', w.itemName, '→', w.itemValue));
if (!hit.length) {
  console.log('후보 일부:', items.slice(0, 10).map(w => w.itemName).join(' | '));
  await obs.disconnect(); process.exit(2);
}

await obs.call('SetInputSettings', {
  inputName: SRC, inputSettings: { type: 1, window: hit[0].itemValue, show_cursor: false },
});
await new Promise(r => setTimeout(r, 3000));

const id = (await obs.call('GetSceneItemList', { sceneName: SCENE }))
  .sceneItems.find(x => x.sourceName === SRC).sceneItemId;
const tr = (await obs.call('GetSceneItemTransform', { sceneName: SCENE, sceneItemId: id })).sceneItemTransform;
console.log(`소스 원본 크기: ${tr.sourceWidth}×${tr.sourceHeight}`);

const shot = await obs.call('GetSourceScreenshot',
  { sourceName: SRC, imageFormat: 'png', imageWidth: Math.min(1280, tr.sourceWidth || 1280) });
const buf = Buffer.from(shot.imageData.split(',')[1], 'base64');
writeFileSync('/tmp/obs-capture.png', buf);
console.log(`캡처 PNG ${buf.readUInt32BE(16)}×${buf.readUInt32BE(20)} · ${(buf.length/1024).toFixed(1)} KB → /tmp/obs-capture.png`);

writeFileSync('/tmp/obs-result.json', JSON.stringify({
  window: hit[0].itemName, sourceW: tr.sourceWidth, sourceH: tr.sourceHeight,
  pngW: buf.readUInt32BE(16), pngH: buf.readUInt32BE(20), bytes: buf.length }, null, 2));
await obs.disconnect();
console.log('완료 — 씬 "HC-캡처검증" 은 남겨둡니다 (직접 확인용)');
