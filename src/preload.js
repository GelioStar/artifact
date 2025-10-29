// preload.js (для main window) — обязательный файл, который должен существовать и быть доступен
const { contextBridge, ipcRenderer } = require('electron');

const API_BASE = process.env.AUTH_SERVER_URL || 'http://localhost:8000/api';

function handleFetch(res) {
  // логируем для дебага — закомментируйте в релизе
  // console.log('preload.handleFetch status', res.status);
  return res.json().then(j => j).catch(()=>({ success:false, error: 'Invalid JSON response' }));
}

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

// Bridge для уведомлений main-процессу
contextBridge.exposeInMainWorld('bridge', {
  authenticated: (token) => {
    try { ipcRenderer.send('auth:authenticated', token); } catch (e) { console.error(e); }
  },
  logoutNotify: () => {
    try { ipcRenderer.send('auth:logout'); } catch (e) { console.error(e); }
  },
});

// Для отладки: покажем в DevTools, что preload загрузился
try { console.log('preload.js loaded — auth & bridge exposed'); } catch (e) {}
