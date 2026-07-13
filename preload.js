const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widget', {
  onUsage: (cb) => ipcRenderer.on('usage', (_e, data) => cb(data)),
  onTotals: (cb) => ipcRenderer.on('totals', (_e, data) => cb(data)),
  onHover: (cb) => ipcRenderer.on('hover', (_e, data) => cb(data)),
  close: () => ipcRenderer.send('widget-close'),
  refreshUsage: () => ipcRenderer.send('refresh-usage'),
});
