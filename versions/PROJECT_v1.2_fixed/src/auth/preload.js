// preload.js (для main window)
const { contextBridge, ipcRenderer } = require('electron');

const API_BASE = process.env.AUTH_SERVER_URL || 'http://localhost:8000/api';

function handleFetch(res) {
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

// bridge для уведомления main-процесса
contextBridge.exposeInMainWorld('bridge', {
  authenticated: (token) => {
    try { ipcRenderer.send('auth:authenticated', token); }
    catch (e) { console.error('bridge.authenticated error', e); }
  },
  logoutNotify: () => {
    try { ipcRenderer.send('auth:logout'); }
    catch (e) { console.error('bridge.logoutNotify error', e); }
  }
});
