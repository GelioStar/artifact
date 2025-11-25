// auth/preload.js — for auth window (session sends + auth APIs)
const { contextBridge, ipcRenderer } = require('electron');
const API_BASE = process.env.AUTH_SERVER_URL || 'http://localhost:8000/api';

function handleFetch(res) { return res.json().then(j => j).catch(()=>({ success:false, error: 'Invalid JSON response' })); }
function fetchWithAuth(url, opts = {}, token) {
  const headers = opts.headers ? {...opts.headers} : {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(url, {...opts, headers});
}

contextBridge.exposeInMainWorld('auth', {
  register: async (data) => {
    const res = await fetch(`${API_BASE}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return handleFetch(res);
  },
  login: async (data) => {
    const res = await fetch(`${API_BASE}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return handleFetch(res);
  },
  getUser: async (token) => {
    const url = `${API_BASE}/user`;
    const res = await fetchWithAuth(url, { method: 'GET' }, token);
    return handleFetch(res);
  },
  logout: async (token) => {
    const res = await fetch(`${API_BASE}/logout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    return handleFetch(res);
  },
});

contextBridge.exposeInMainWorld('bridge', {
  authenticated: async (payload) => {
    try {
      let token = null, user = null;
      if (!payload) return;
      if (typeof payload === 'string') token = payload;
      else if (typeof payload === 'object') { token = payload.token; user = payload.user; }
      try { ipcRenderer.send('session:set', token, user); } catch(e){ console.warn('session:set send failed', e); }
      ipcRenderer.send('auth:authenticated', payload);
    } catch (e) { console.error(e); }
  },
  logoutNotify: async () => {
    try {
      try { ipcRenderer.send('session:clear'); } catch(e){ console.warn('session:clear send failed', e); }
      ipcRenderer.send('auth:logout');
    } catch (e) { console.error(e); }
  }
});
