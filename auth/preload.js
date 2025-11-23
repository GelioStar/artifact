// preload.js — для renderer (auth + main). Экспортирует window.auth, window.profile, window.bridge, window.i18n
const { contextBridge, ipcRenderer } = require('electron');

const API_BASE = process.env.AUTH_SERVER_URL || 'http://localhost:8000/api';

function handleFetch(res) {
  return res.json().then(j => j).catch(()=>({ success:false, error: 'Invalid JSON response' }));
}

function fetchWithAuth(url, opts = {}, token) {
  const headers = opts.headers ? {...opts.headers} : {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
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

  // getUser поддерживает передачу токена в заголовке Authorization (предпочтительно)
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
        try {
          const j = await res.json();
          return { success: false, status: res.status, error: j && j.error ? j.error : 'failed to fetch icon' };
        } catch (e) {
          return { success: false, status: res.status, error: 'failed to fetch icon' };
        }
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
        try {
          const j = await res.json();
          return { success: false, status: res.status, error: j && j.error ? j.error : 'failed to fetch icon' };
        } catch (e) {
          return { success: false, status: res.status, error: 'failed to fetch icon' };
        }
      }
      const blob = await res.blob();
      return { success: true, blob };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }
});

contextBridge.exposeInMainWorld('bridge', {
  authenticated: (token) => {
    try { ipcRenderer.send('auth:authenticated', token); } catch (e) { console.error(e); }
  },
  logoutNotify: () => {
    try { ipcRenderer.send('auth:logout'); } catch (e) { console.error(e); }
  },
});

contextBridge.exposeInMainWorld('i18n', {
  available: async () => {
    const res = await ipcRenderer.invoke('available-locales');
    return res && res.ok ? res.locales : [];
  },
  load: async (lang) => {
    const res = await ipcRenderer.invoke('load-locale', lang);
    return res && res.ok ? res : { ok: false, error: res && res.error, data: {} };
  },
  getCurrent: async () => {
    const res = await ipcRenderer.invoke('get-current-locale');
    return res && res.ok ? res.locale : null;
  },
  setCurrent: async (lang) => {
    const res = await ipcRenderer.invoke('set-current-locale', lang);
    return res;
  },
  onUpdate: (cb) => {
    const handler = (event, payload) => {
      try { cb(payload); } catch (e) { console.error('i18n.onUpdate callback error', e); }
    };
    ipcRenderer.on('i18n:update', handler);
    return () => { ipcRenderer.removeListener('i18n:update', handler); };
  }
});

// Debug
try { console.log('preload.js loaded — auth, profile, bridge & i18n exposed'); } catch (e) {}
