const { contextBridge, ipcRenderer } = require('electron');

console.log('Simulator preload starting');

contextBridge.exposeInMainWorld('api', {
  createSession: (opts) => ipcRenderer.invoke('create-session', opts),
  savePassage: (data) => ipcRenderer.invoke('save-passage', data),
  recordKeystroke: (data) => ipcRenderer.invoke('record-keystroke', data),
  finalizeResults: (data) => ipcRenderer.invoke('finalize-results', data),
  generatePassage: (opts) => ipcRenderer.invoke('generate-passage', opts),
  getKeystrokes: (token) => ipcRenderer.invoke('get-keystrokes', token),
  getResults: (limit) => ipcRenderer.invoke('get-results', limit)
});

console.log('Simulator preload loaded');