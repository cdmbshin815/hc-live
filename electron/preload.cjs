// 렌더러에 최소한의 창 제어만 노출한다. contextIsolation 아래에서만 쓴다.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lp', {
  isElectron: true,
  displays:    ()   => ipcRenderer.invoke('lp:displays'),
  openOutput:  (o)  => ipcRenderer.invoke('lp:openOutput', o),
  closeOutput: (id) => ipcRenderer.invoke('lp:closeOutput', id),
  port:        ()   => ipcRenderer.invoke('lp:port'),
});
