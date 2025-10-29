// webview-preload.js
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('electronAPI', {
  loadMainJson: () => ipcRenderer.invoke('load-main-json'),
  translate: (key) => ipcRenderer.invoke('translate', key),
  printText: (text) => ipcRenderer.send("print-text", text),
});