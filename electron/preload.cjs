// 렌더러에 최소한의 창 제어만 노출한다. contextIsolation 아래에서만 쓴다.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hc', {
  isElectron: true,
  displays:    ()   => ipcRenderer.invoke('hc:displays'),
  openOutput:  (o)  => ipcRenderer.invoke('hc:openOutput', o),
  closeOutput: (id) => ipcRenderer.invoke('hc:closeOutput', id),
  port:        ()   => ipcRenderer.invoke('hc:port'),
});
