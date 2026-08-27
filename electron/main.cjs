// Electron 메인 프로세스.
// 로컬 서버를 앱 안에서 띄우고, 관리 창과 출력창을 관리한다.
//
// 출력창은 OBS·vMix 가 깨끗하게 캡처할 수 있는 창이 되는 것이 유일한 목적이다(기획서 §3.7).
//   · 프레임리스, 지정 해상도로 픽셀 고정, 크기 변경 불가
//   · 메뉴·커서·툴팁 없음, 배경은 순수 검정
//   · 지정 모니터로 이동, 필요 시 전체화면
const { app, BrowserWindow, screen, ipcMain, Menu } = require('electron');
const path = require('path');

// 사이니지·방송 앱은 일시적 오류로 죽으면 안 된다. 로그를 남기고 계속한다.
process.on('uncaughtException', e => console.error('[main] uncaughtException:', e?.stack || e));
process.on('unhandledRejection', e => console.error('[main] unhandledRejection:', e?.stack || e));

// 무인 24시간 운영이 목표이므로 출력창은 사람의 클릭 없이 재생을 시작할 수 있어야 한다.
// 브라우저의 자동재생 제한은 이 앱에는 해당되지 않는다 — 우리가 띄우는 우리 창이다.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let port = null;
let adminWin = null;
const outputs = new Map();   // outputId → BrowserWindow

const url = p => `http://127.0.0.1:${port}${p}`;

function createAdmin() {
  adminWin = new BrowserWindow({
    width: 1440, height: 860, minWidth: 1080,
    backgroundColor: '#0E1113',
    title: 'Live Player',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true },
  });
  adminWin.loadURL(url('/admin/'));
  adminWin.on('closed', () => { adminWin = null; });
}

/**
 * 출력창을 연다.
 * @param {{id:string,displayId?:number,width?:number,height?:number,fullscreen?:boolean}} o
 */
function createOutput(o = {}) {
  const id = o.id || 'out1';
  if (outputs.has(id)) { outputs.get(id).focus(); return id; }

  const displays = screen.getAllDisplays();
  const display = displays.find(d => d.id === o.displayId) || screen.getPrimaryDisplay();
  const w = o.width  || 1920;
  const h = o.height || 1080;

  // Electron 의 크기는 논리 포인트지만 OBS 는 **물리 픽셀**을 캡처한다.
  // Retina(scaleFactor 2)에서 1920×1080 을 그대로 주면 캡처가 3840×2160 으로 잡힌다.
  // 의도한 해상도로 캡처되게 하려면 논리 크기를 배율로 나눠야 한다.
  // (OBS 실측으로 확인: 논리 960×540 창 → OBS 소스 크기 1920×1080)
  const sf = display.scaleFactor || 1;
  const logicalW = Math.round(w / sf);
  const logicalH = Math.round(h / sf);

  const win = new BrowserWindow({
    x: display.bounds.x + 40,
    y: display.bounds.y + 40,
    width: logicalW, height: logicalH,
    useContentSize: true,        // 프레임이 아니라 '내용' 픽셀을 고정 — 캡처 해상도가 정확해야 한다
    resizable: false,
    frame: false,
    fullscreenable: true,
    backgroundColor: '#000000',
    title: `Live Player — 출력 ${id}`,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true },
  });

  win.setMenuBarVisibility(false);
  console.log(`[main] 출력창 ${id} — 요청 ${w}×${h} · 배율 ${sf} · 논리 ${logicalW}×${logicalH}`);
  const ch = o.channelId ? `&ch=${encodeURIComponent(o.channelId)}` : '';
  win.loadURL(url(`/output/?id=${encodeURIComponent(id)}${ch}`));

  if (o.fullscreen) {
    win.setBounds(display.bounds);
    win.setFullScreen(true);
  }

  win.on('closed', () => outputs.delete(id));
  outputs.set(id, win);
  return id;
}

/* ── IPC ─────────────────────────────────────────── */
ipcMain.handle('lp:displays', () => screen.getAllDisplays().map((d, i) => ({
  id: d.id,
  index: i + 1,
  label: d.label || `디스플레이 ${i + 1}`,
  width: d.size.width,
  height: d.size.height,
  x: d.bounds.x,
  y: d.bounds.y,
  scaleFactor: d.scaleFactor,
  primary: d.id === screen.getPrimaryDisplay().id,
})));

ipcMain.handle('lp:openOutput', (_e, o) => createOutput(o));
ipcMain.handle('lp:closeOutput', (_e, id) => {
  const w = outputs.get(id);
  if (w) w.close();
  return true;
});
ipcMain.handle('lp:port', () => port);

/* ── 기동 ────────────────────────────────────────── */
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const { startServer } = await import('../server/index.js');
  port = await startServer();
  createAdmin();
  if (process.env.LP_AUTO_OUTPUT) {
    // LP_AUTO_OUTPUT=c1,c2 처럼 채널을 지정하면 채널마다 출력창을 연다.
    const chans = String(process.env.LP_AUTO_OUTPUT).split(',').map(x => x.trim()).filter(Boolean);
    const list = chans.length && chans[0] !== '1' ? chans : ['c1'];
    list.forEach((cid, i) => createOutput({
      id: 'out' + (i + 1), channelId: cid, width: 960, height: 540,
    }));
  }

  app.on('activate', () => { if (!adminWin) createAdmin(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
