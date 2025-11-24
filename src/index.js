// main.js — main process (Electron)
const { app, BrowserWindow, shell, ipcMain, webContents } = require('electron');
const path = require('node:path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const { pathToFileURL } = require('url');
const oboe = require('oboe');

const BASE_DIR = __dirname;
let MAIN_JSON_PATH = path.join(__dirname, '..', 'locales', 'main.json');
const LOCALES_DIR = path.join(__dirname, '..', 'locales');

let currentLocale = 'en'; // default
let cachedLocales = Object.create(null);

// --- helper: глубокое слияние (fallback keys) ---
function deepMerge(a, b) {
  if (!a || typeof a !== 'object') return b;
  if (!b || typeof b !== 'object') return a;
  const out = Array.isArray(a) ? [...a] : { ...a };
  for (const k of Object.keys(b)) {
    if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && out[k]) {
      out[k] = deepMerge(out[k], b[k]);
    } else {
      out[k] = b[k];
    }
  }
  return out;
}

// --- simulator loader (unchanged) ---
try {
  const simPath = path.join(__dirname, 'scripts', 'renderer', 'views', 'simulator', 'main.js');
  if (fs.existsSync(simPath)) {
    require(simPath);
    console.log('Simulator IPC handlers loaded from', simPath);
  } else {
    console.warn('Simulator IPC handlers not found at', simPath);
  }
} catch (err) {
  console.error('Failed to load simulator IPC handlers', err);
}

// --- main.json streaming handler (unchanged) ---
ipcMain.handle('load-main-json', async () => {
  try {
    await fsPromises.access(MAIN_JSON_PATH, fs.constants.R_OK);
    return await new Promise((resolve) => {
      const map = Object.create(null);
      const stream = fs.createReadStream(MAIN_JSON_PATH, { encoding: 'utf8' });
      oboe(stream)
        .node('!.*', function(node, pathArr) {
          try {
            const key = Array.isArray(pathArr) && pathArr.length ? pathArr[pathArr.length - 1] : undefined;
            if (key !== undefined && key !== null) {
              map[key] = node;
            }
          } catch (err) {
            console.error('oboe.node handler error:', err);
          }
        })
        .done(() => {
          resolve({ ok: true, data: map });
        })
        .fail((err) => {
          console.error('Oboe parsing failed:', err);
          resolve({ ok: false, error: String(err), data: {} });
        });
    });
  } catch (err) {
    console.error('Failed to access main.json:', err);
    return { ok: false, error: String(err), data: {} };
  }
});

// --- locales handlers (unchanged) ---
async function readJsonSafe(filePath) {
  try {
    const text = await fsPromises.readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

async function loadLocaleData(lang) {
  const key = String(lang || '').toLowerCase();
  if (cachedLocales[key]) return cachedLocales[key];

  const base = (await readJsonSafe(MAIN_JSON_PATH)) || {};
  const fileCandidate = path.join(LOCALES_DIR, `${key}.json`);
  const specific = (await readJsonSafe(fileCandidate)) || {};
  const merged = deepMerge(base, specific);
  cachedLocales[key] = merged;
  return merged;
}

ipcMain.handle('available-locales', async () => {
  try {
    const names = (await fsPromises.readdir(LOCALES_DIR)).filter(f => /\.json$/i.test(f));
    const out = names.map(n => n.replace(/\.json$/i, '')).filter(n => n !== 'main');
    return { ok: true, locales: out };
  } catch (err) {
    console.error('available-locales error', err);
    return { ok: false, error: String(err), locales: [] };
  }
});

ipcMain.handle('load-locale', async (event, lang) => {
  try {
    const data = await loadLocaleData(lang || currentLocale);
    return { ok: true, locale: lang || currentLocale, data };
  } catch (err) {
    console.error('load-locale error', err);
    return { ok: false, error: String(err), data: {} };
  }
});

ipcMain.handle('get-current-locale', async () => {
  return { ok: true, locale: currentLocale };
});

ipcMain.handle('set-current-locale', async (event, lang) => {
  try {
    if (!lang || typeof lang !== 'string') throw new Error('Invalid lang');
    currentLocale = String(lang);
    const data = await loadLocaleData(currentLocale);

    try {
      BrowserWindow.getAllWindows().forEach(win => {
        try { win.webContents.send('i18n:update', { locale: currentLocale, data }); }
        catch (e) { /* ignore */ }
      });
      webContents.getAllWebContents().forEach(wc => {
        try { wc.send && wc.send('i18n:update', { locale: currentLocale, data }); }
        catch (e) { /* ignore */ }
      });
    } catch (e) {
      console.error('Broadcast i18n:update failed', e);
    }

    return { ok: true, locale: currentLocale, data };
  } catch (err) {
    console.error('set-current-locale error', err);
    return { ok: false, error: String(err) };
  }
});

// --- SessionStore IPC: set/get/clear (для renderer / webview) ---
ipcMain.handle('session:set', async (event, token, user) => {
  try {
    SessionStore.set(token, user);
    return { ok: true };
  } catch (err) {
    console.error('session:set error', err);
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('session:get', async () => {
  try {
    return { ok: true, ...SessionStore.get() };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('session:clear', async () => {
  try {
    SessionStore.clear();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// --- rest of your existing main.js (window creation, auth flow, etc.) ---
ipcMain.handle('webview-create-window', (event, opts = {}) => {
  try {
    const width  = Math.min(Math.max(Number(opts.width) || 800, 300), 2000);
    const height = Math.min(Math.max(Number(opts.height) || 600, 200), 2000);
    const url    = String(opts.url || 'about:blank');
    const ownerWindow = BrowserWindow.fromWebContents(event.sender) || undefined;
    const child = new BrowserWindow({
      width, height,
      parent: ownerWindow,
      modal: !!opts.modal,
      show: true,
      webPreferences: {
        preload: pathToFileURL(path.join(__dirname, 'preload.js')).href,
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    child.loadURL(url).catch(err => console.error('loadURL failed', err));
    return { success: true, id: child.id };
  } catch (err) {
    console.error('Error creating window from webview:', err);
    return { success: false, error: String(err) };
  }
});

if (require('electron-squirrel-startup')) { app.quit(); }

let authWindow = null;
let mainWindow = null;

function createAuthWindow () {
  authWindow = new BrowserWindow({
    width: 320,
    height: 380,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    autoHideMenuBar: true,
    resizable: false,
    icon: path.join(__dirname, 'img', 'logo.png'),
  });
  
  // authWindow.webContents.openDevTools({ mode: 'detach' }); // отключите в продакшне
  authWindow.removeMenu?.();
  authWindow.loadFile(path.join(__dirname, '..', 'auth', 'src', 'index.html'));
  authWindow.on('closed', () => { authWindow = null; });
  return authWindow;
}

const createWindow = () => {
  if (mainWindow) {
    try { mainWindow.focus(); } catch (e) {}
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 1366, height: 768,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
    icon: path.join(__dirname, 'img', 'logo.png'),
    show: false,
    autoHideMenuBar: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('ready-to-show', async () => {
    try {
      const data = await loadLocaleData(currentLocale);
      mainWindow.show();
      try { mainWindow.webContents.send('i18n:update', { locale: currentLocale, data }); } catch (e) {}
    } catch (e) { console.error(e); }
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    try {
      const parsedUrl = new URL(navigationUrl);
      if (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') {
        event.preventDefault();
        shell.openExternal(navigationUrl).catch(console.error);
      }
    } catch (err) { /* ignore */ }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        shell.openExternal(url).catch(console.error);
        return { action: 'deny' };
      }
    } catch (err) {}
    return { action: 'allow' };
  });

  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    try {
      const webviewPreloadPath = path.join(__dirname, 'webview-preload.js');
      webPreferences.preloadURL = pathToFileURL(webviewPreloadPath).href;
      webPreferences.contextIsolation = true;
      webPreferences.nodeIntegration = false;
    } catch (err) {
      console.error('Error setting webview preload:', err);
    }
  });

  return mainWindow;
};

// Receive authentication from auth renderer: token + user object (or token string)
// We support both calling conventions for backwards compatibility.
ipcMain.on('auth:authenticated', async (event, payload) => {
  try {
    let token = null, user = null;
    if (!payload) {
      // nothing
    } else if (typeof payload === 'string') {
      token = payload;
    } else if (typeof payload === 'object') {
      token = payload.token || null;
      user = payload.user || null;
    }
    if (token) {
      SessionStore.set(token, user);
    }
    console.log('Main: auth:authenticated received. user=', user && user.username ? user.username : '[no user obj]');

    if (authWindow) {
      try { authWindow.close(); } catch (e) { console.error(e); }
      authWindow = null;
    }
    const win = createWindow();
    win.webContents.once('did-finish-load', () => {
      try {
        // отправляем user info (если есть) — рендереры ожидают 'user:info'
        win.webContents.send('user:info', { token, user });
      } catch (err) { console.error('Failed to send user:info', err); }
    });
  } catch (err) {
    console.error('Error handling auth:authenticated', err);
  }
});

// handle logout notification from renderer(s)
ipcMain.on('auth:logout', () => {
  try {
    console.log('Main: auth:logout received');
    SessionStore.clear();
    if (mainWindow) {
      try { mainWindow.close(); } catch (e) { console.error(e); }
      mainWindow = null;
    }
    createAuthWindow();
  } catch (err) {
    console.error('Error handling auth:logout', err);
  }
});

app.whenReady().then(() => {
  createAuthWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createAuthWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

const USERDATA_DIR = app.getPath ? app.getPath('userData') : path.join(__dirname, '..', 'userdata');
const AVATARS_DIR = path.join(USERDATA_DIR, 'avatars');
const AVATARS_META = path.join(AVATARS_DIR, 'meta.json');

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 минут по умолчанию

// Ensure avatars dir exists
(async function ensureDirs(){
  try {
    await fsPromises.mkdir(AVATARS_DIR, { recursive: true });
  } catch (e) { /* ignore */ }
})();

// --- Simple in-memory session store for main process ---
const SessionStore = {
  _token: null,
  _user: null,
  _avatarMeta: null, // lazy load from disk
  set(token, user) {
    this._token = token || null;
    this._user = user || null;
    return true;
  },
  get() {
    return { token: this._token, user: this._user };
  },
  clear() {
    this._token = null;
    this._user = null;
    return true;
  },

  // Avatar meta helpers (persistent metadata on disk)
  async _loadAvatarMeta() {
    if (this._avatarMeta) return this._avatarMeta;
    try {
      const txt = await fsPromises.readFile(AVATARS_META, 'utf8');
      this._avatarMeta = JSON.parse(txt || "{}");
    } catch (e) {
      this._avatarMeta = {};
    }
    return this._avatarMeta;
  },

  async _saveAvatarMeta() {
    try {
      await fsPromises.writeFile(AVATARS_META, JSON.stringify(this._avatarMeta || {}, null, 2), 'utf8');
    } catch (e) { console.error('Failed to write avatar meta', e); }
  },

  // get meta for userId
  async getAvatarMeta(userId) {
    if (!userId) return null;
    const meta = await this._loadAvatarMeta();
    return meta[userId] || null;
  },

  async setAvatarMeta(userId, m) {
    if (!userId) return;
    const meta = await this._loadAvatarMeta();
    meta[userId] = m;
    this._avatarMeta = meta;
    await this._saveAvatarMeta();
  },

  async deleteAvatarMeta(userId) {
    if (!userId) return;
    const meta = await this._loadAvatarMeta();
    delete meta[userId];
    this._avatarMeta = meta;
    await this._saveAvatarMeta();
  }
};

// Helper: broadcast avatar changed to renderers/webviews
function broadcastAvatarChanged(payload) {
  try {
    BrowserWindow.getAllWindows().forEach(win => {
      try { win.webContents.send('avatar:changed', payload); } catch (e) {}
    });
    webContents.getAllWebContents().forEach(wc => {
      try { wc.send && wc.send('avatar:changed', payload); } catch (e) {}
    });
  } catch (e) { console.error('broadcastAvatarChanged error', e); }
}

// Utility: buffer -> dataUrl
function bufferToDataUrl(buf, mime='application/octet-stream') {
  const base = buf.toString('base64');
  return `data:${mime};base64,${base}`;
}

// Ensure fetch exists (Node 18+). If not, try node-fetch as fallback.
let _fetch = global.fetch;
if (typeof _fetch !== 'function') {
  try {
    _fetch = require('node-fetch');
  } catch (e) {
    console.warn('No global fetch and node-fetch not installed; avatar refresh will fail without fetch.');
    _fetch = null;
  }
}

// Download avatar from server (returns { ok, dataUrl, mime, buffer })
async function downloadAvatarFromServer(userId, token, apiBase='http://localhost:8000/api') {
  if (!_fetch) return { ok: false, error: 'fetch-unavailable' };
  if (!userId) return { ok: false, error: 'userId-required' };
  try {
    const url = `${apiBase.replace(/\/+$/,'')}/user/icon/${encodeURIComponent(userId)}`;
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
    const resp = await _fetch(url, { method: 'GET', headers });
    if (!resp.ok) {
      return { ok: false, status: resp.status, error: `http ${resp.status}` };
    }
    const arr = await resp.arrayBuffer();
    const buf = Buffer.from(arr);
    const mime = resp.headers && (resp.headers.get ? resp.headers.get('content-type') : resp.headers['content-type']) || 'application/octet-stream';
    const dataUrl = bufferToDataUrl(buf, mime);
    return { ok: true, dataUrl, mime, buffer: buf };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Save buffer to disk and update meta (returns meta)
async function saveAvatarToCache(userId, buffer, mime) {
  if (!userId || !buffer) return null;
  try {
    const fileName = `avatar_${userId}.bin`;
    const filePath = path.join(AVATARS_DIR, fileName);
    await fsPromises.writeFile(filePath, buffer);
    const meta = {
      filePath,
      mime: mime || 'application/octet-stream',
      updatedAt: (new Date()).toISOString()
    };
    await SessionStore.setAvatarMeta(userId, meta);
    return meta;
  } catch (e) {
    console.error('saveAvatarToCache error', e);
    return null;
  }
}

function isCacheFresh(meta) {
  if (!meta || !meta.updatedAt) return false;
  try {
    const updated = new Date(meta.updatedAt);
    const age = Date.now() - updated.getTime();
    return age <= CACHE_TTL_MS;
  } catch (e) {
    return false;
  }
}

// Provide cached dataUrl if exists
async function getCachedDataUrl(userId) {
  const meta = await SessionStore.getAvatarMeta(userId);
  if (!meta || !meta.filePath) return null;
  try {
    const buf = await fsPromises.readFile(meta.filePath);
    return bufferToDataUrl(buf, meta.mime || 'application/octet-stream');
  } catch (e) {
    return null;
  }
}

// IPC: get avatar (returns cached if fresh; if stale -> return cached & refresh in background)
ipcMain.handle('avatar:get', async (event, userId, opts = {}) => {
  try {
    // prefer explicit token if provided in opts, else SessionStore token
    const token = (opts && opts.token) ? opts.token : (SessionStore._token || null);
    const meta = await SessionStore.getAvatarMeta(userId);
    if (meta && isCacheFresh(meta)) {
      const dataUrl = await getCachedDataUrl(userId);
      if (dataUrl) return { ok: true, dataUrl, fromCache: true, updatedAt: meta.updatedAt };
    }
    // if meta exists but stale -> return cached (if exists) and trigger background refresh
    if (meta) {
      const dataUrl = await getCachedDataUrl(userId);
      // background refresh
      (async () => {
        try {
          const dl = await downloadAvatarFromServer(userId, token);
          if (dl.ok && dl.buffer) {
            await saveAvatarToCache(userId, dl.buffer, dl.mime);
            const newDataUrl = bufferToDataUrl(dl.buffer, dl.mime);
            broadcastAvatarChanged({ userId, dataUrl: newDataUrl });
          } else if (dl.status === 404) {
            // server has no avatar; clear cache
            await SessionStore.deleteAvatarMeta(userId);
            broadcastAvatarChanged({ userId, dataUrl: null, deleted: true });
          } else {
            // ignore
          }
        } catch (e) { /* ignore */ }
      })();
      if (dataUrl) return { ok: true, dataUrl, fromCache: true, updatedAt: meta.updatedAt, refreshing: true };
    }

    // no meta -> try to download synchronously (first load)
    const dl = await downloadAvatarFromServer(userId, token);
    if (dl.ok && dl.buffer) {
      await saveAvatarToCache(userId, dl.buffer, dl.mime);
      const dataUrl = bufferToDataUrl(dl.buffer, dl.mime);
      return { ok: true, dataUrl, fromCache: false, updatedAt: (new Date()).toISOString() };
    }

    if (dl.status === 404) {
      // no avatar on server
      await SessionStore.deleteAvatarMeta(userId);
      return { ok: false, notFound: true, error: 'not found' };
    }

    return { ok: false, error: dl.error || 'failed' };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

// IPC: force refresh (download now, update cache and broadcast)
ipcMain.handle('avatar:forceRefresh', async (event, userId, tokenArg) => {
  try {
    const token = tokenArg || SessionStore._token || null;
    const dl = await downloadAvatarFromServer(userId, token);
    if (dl.ok && dl.buffer) {
      await saveAvatarToCache(userId, dl.buffer, dl.mime);
      const dataUrl = bufferToDataUrl(dl.buffer, dl.mime);
      broadcastAvatarChanged({ userId, dataUrl });
      return { ok: true, dataUrl };
    } else if (dl.status === 404) {
      await SessionStore.deleteAvatarMeta(userId);
      broadcastAvatarChanged({ userId, dataUrl: null, deleted: true });
      return { ok: true, notFound: true };
    } else {
      return { ok: false, error: dl.error || 'download failed' };
    }
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

// IPC: clear avatar cache for user (called after DELETE)
ipcMain.handle('avatar:clear', async (event, userId) => {
  try {
    const meta = await SessionStore.getAvatarMeta(userId);
    if (meta && meta.filePath) {
      try { await fsPromises.unlink(meta.filePath); } catch (e) { /* ignore */ }
    }
    await SessionStore.deleteAvatarMeta(userId);
    broadcastAvatarChanged({ userId, dataUrl: null, deleted: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('session:get', async () => {
  try {
    return { ok: true, ...SessionStore.get() };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('session:clear', async () => {
  try {
    SessionStore.clear();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});