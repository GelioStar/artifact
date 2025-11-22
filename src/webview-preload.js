// webview-preload.js
const { contextBridge, ipcRenderer } = require('electron');

// Existing API surface (keep your previous handlers)
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

// --- i18n: receive updates from main and expose small API to guest page ---
ipcRenderer.on('i18n:update', (event, payload) => {
  try {
    // payload: { locale, data }
    window.dispatchEvent(new CustomEvent('i18n:update', { detail: payload }));
  } catch (e) { /* ignore */ }
});

// notify host that guest is ready to receive translations
window.addEventListener('DOMContentLoaded', () => {
  try {
    ipcRenderer.sendToHost('guest-ready');
  } catch (e) { /* ignore */ }
});

// Expose helper API for guest page scripts
contextBridge.exposeInMainWorld('i18n', {
  // guest page can listen for updates via window.addEventListener('i18n:update', ...)
  // but we also provide a helper to request the current locale immediately
  getCurrent: async () => {
    try {
      const res = await ipcRenderer.invoke('get-current-locale');
      return res && res.ok ? res.locale : null;
    } catch (e) {
      return null;
    }
  },
  loadLocale: async (lang) => {
    try {
      const res = await ipcRenderer.invoke('load-locale', lang);
      return res && res.ok ? res : { ok: false };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
});
