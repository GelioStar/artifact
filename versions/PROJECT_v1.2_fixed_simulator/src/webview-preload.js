// webview-preload.js
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('electronAPI', {
  loadMainJson: () => ipcRenderer.invoke('load-main-json'),
  translate: (key) => ipcRenderer.invoke('translate', key),
  printText: (text) => ipcRenderer.send("print-text", text),
  createSession: (opts) => ipcRenderer.invoke('create-session', opts),
  savePassage: (data) => ipcRenderer.invoke('save-passage', data),
  recordKeystroke: (data) => ipcRenderer.invoke('record-keystroke', data),
  finalizeResults: (data) => ipcRenderer.invoke('finalize-results', data),
  generatePassage: (opts) => ipcRenderer.invoke('generate-passage', opts),
  getKeystrokes: (token) => ipcRenderer.invoke('get-keystrokes', token),
  getResults: (limit) => ipcRenderer.invoke('get-results', limit)
});