// preload.js
const { contextBridge, ipcRenderer } = require('electron');
const API_BASE = process.env.AUTH_SERVER_URL || 'http://localhost:8000/api';

function handleFetch(res) {
  return res.json().then(j => j).catch(()=>({ success:false, error: 'Invalid JSON response' }));
}

function fetchWithAuth(url, opts = {}, token) {
  const headers = opts.headers ? {...opts.headers} : {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(url, {...opts, headers});
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
    const url = `${API_BASE}/user`;
    const res = await fetchWithAuth(url, { method: 'GET' }, token);
    return handleFetch(res);
  },
  logout: async (token) => {
    const res = await fetch(`${API_BASE}/logout`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token })
    });
    return handleFetch(res);
  },
});

contextBridge.exposeInMainWorld('profile', {
  uploadIcon: async (file, token) => {
    if (!file) return { success: false, error: 'file required' };
    const form = new FormData();
    form.append('file', file);
    const res = await fetchWithAuth(`${API_BASE}/user/icon`, {
      method: 'POST',
      body: form
    }, token);
    return handleFetch(res);
  },

  deleteIcon: async (token) => {
    const res = await fetchWithAuth(`${API_BASE}/user/icon`, {
      method: 'DELETE'
    }, token);
    return handleFetch(res);
  },

  getIconUrl: (userId, token) => {
    if (userId === undefined || userId === null) return null;
    const base = `${API_BASE}/user/icon/${encodeURIComponent(userId)}`;
    if (token) {
      return `${base}?token=${encodeURIComponent(token)}`;
    }
    return base;
  },

  fetchIconDataUrl: async (userId, token) => {
    if (userId === undefined || userId === null) return { success: false, error: 'userId required' };
    if (!token) return { success: false, error: 'token required for fetchIconDataUrl' };
    try {
      const res = await fetchWithAuth(`${API_BASE}/user/icon/${encodeURIComponent(userId)}`, { method: 'GET' }, token);
      if (!res.ok) {
        try { const j = await res.json(); return { success: false, status: res.status, error: j && j.error ? j.error : 'failed to fetch icon' }; }
        catch (e) { return { success: false, status: res.status, error: 'failed to fetch icon' }; }
      }
      const blob = await res.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => { reader.abort(); reject(new Error("Failed to read blob")); };
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
      return { success: true, dataUrl };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },

  fetchIconBlob: async (userId, token) => {
    if (userId === undefined || userId === null) return { success: false, error: 'userId required' };
    if (!token) return { success: false, error: 'token required for fetchIconBlob' };
    try {
      const res = await fetchWithAuth(`${API_BASE}/user/icon/${encodeURIComponent(userId)}`, { method: 'GET' }, token);
      if (!res.ok) {
        try { const j = await res.json(); return { success: false, status: res.status, error: j && j.error ? j.error : 'failed to fetch icon' }; }
        catch (e) { return { success: false, status: res.status, error: 'failed to fetch icon' }; }
      }
      const blob = await res.blob();
      return { success: true, blob };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }
});

// Bridge helper for notifying main process
contextBridge.exposeInMainWorld('bridge', {
  authenticated: async (payload) => {
    try {
      // payload can be token string OR { token, user }
      let token = null, user = null;
      if (!payload) return;
      if (typeof payload === 'string') token = payload;
      else if (typeof payload === 'object') { token = payload.token; user = payload.user; }
      // Save into main process SessionStore
      await ipcRenderer.invoke('session:set', token, user).catch(()=>{});
      // Also send legacy event for compatibility
      ipcRenderer.send('auth:authenticated', payload);
    } catch (e) { console.error(e); }
  },
  logoutNotify: async () => {
    try {
      await ipcRenderer.invoke('session:clear').catch(()=>{});
      ipcRenderer.send('auth:logout');
    } catch (e) { console.error(e); }
  }
});

// session API to let renderer obtain current main-session token/user
contextBridge.exposeInMainWorld('session', {
  get: async () => {
    try {
      const res = await ipcRenderer.invoke('session:get');
      if (res && res.ok !== false) return res;
      return { ok: false, error: res && res.error ? res.error : 'unknown' };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
  set: async (token, user) => {
    try {
      return await ipcRenderer.invoke('session:set', token, user);
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
  clear: async () => {
    try {
      return await ipcRenderer.invoke('session:clear');
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
});
