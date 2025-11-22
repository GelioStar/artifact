// preload.js — для main window
const { contextBridge, ipcRenderer } = require('electron');

const API_BASE = process.env.AUTH_SERVER_URL || 'http://localhost:8000/api';

function handleFetch(res) {
  return res.json().then(j => j).catch(()=>({ success:false, error: 'Invalid JSON response' }));
}

// --- auth API (как было) ---
contextBridge.exposeInMainWorld('auth', {
  register: async (data) => {
    const res = await fetch(`${API_BASE}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
    return handleFetch(res);
  },
  login: async (data) => {
    const res = await fetch(`${API_BASE}/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
    return handleFetch(res);
  },
  getUser: async (token) => {
    const url = `${API_BASE}/user` + (token ? `?token=${encodeURIComponent(token)}` : '');
    const res = await fetch(url, { method: 'GET' });
    return handleFetch(res);
  },
  logout: async (token) => {
    const res = await fetch(`${API_BASE}/logout`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token })
    });
    return handleFetch(res);
  },
});

// Bridge для уведомлений main-процессу (как было)
contextBridge.exposeInMainWorld('bridge', {
  authenticated: (token) => {
    try { ipcRenderer.send('auth:authenticated', token); } catch (e) { console.error(e); }
  },
  logoutNotify: () => {
    try { ipcRenderer.send('auth:logout'); } catch (e) { console.error(e); }
  },
});

// --- NEW: i18n API ---
contextBridge.exposeInMainWorld('i18n', {
  // получить список доступных локалей
  available: async () => {
    const res = await ipcRenderer.invoke('available-locales');
    return res && res.ok ? res.locales : [];
  },
  // загрузить контент локали (merged with main.json)
  load: async (lang) => {
    const res = await ipcRenderer.invoke('load-locale', lang);
    return res && res.ok ? res : { ok: false, error: res && res.error, data: {} };
  },
  // получить текущую локаль
  getCurrent: async () => {
    const res = await ipcRenderer.invoke('get-current-locale');
    return res && res.ok ? res.locale : null;
  },
  // установить и распространить текущую локаль (broadcast)
  setCurrent: async (lang) => {
    const res = await ipcRenderer.invoke('set-current-locale', lang);
    return res;
  },
  // слушать обновления локалей (main -> renderers/webviews)
  onUpdate: (cb) => {
    const handler = (event, payload) => {
      try { cb(payload); } catch (e) { console.error('i18n.onUpdate callback error', e); }
    };
    ipcRenderer.on('i18n:update', handler);
    return () => { ipcRenderer.removeListener('i18n:update', handler); };
  }
});

// Для отладки:
try { console.log('preload.js loaded — auth, bridge & i18n exposed'); } catch (e) {}
