// src/index.js (main) — safe send / session fixes (логика: не меняет функционал)
const { app, BrowserWindow, shell, ipcMain, webContents } = require('electron');
const path = require('node:path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const { pathToFileURL } = require('url');
const oboe = require('oboe');

const BASE_DIR = __dirname;
let MAIN_JSON_PATH = path.join(__dirname, '..', 'locales', 'main.json');
const LOCALES_DIR = path.join(__dirname, '..', 'locales');

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

// --- Safety flag to avoid sending messages while quitting ---
let isAppQuitting = false;
app.on('before-quit', () => { isAppQuitting = true; });

// --- Safe send helpers ---
function safeSendToWebContents(wc, channel, ...args) {
  try {
    if (!wc) return false;
    if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) return false;
    if (typeof wc.isCrashed === 'function' && wc.isCrashed()) return false;
    if (isAppQuitting) return false;
    try { wc.send(channel, ...args); return true; }
    catch (e) { console.warn('safeSend failed for', channel, e); return false; }
  } catch (e) {
    console.warn('safeSend outer error', e);
    return false;
  }
}

function safeBroadcast(channel, payload) {
  if (isAppQuitting) return;
  try {
    BrowserWindow.getAllWindows().forEach(win => {
      try { safeSendToWebContents(win.webContents, channel, payload); } catch (e) {}
    });
    webContents.getAllWebContents().forEach(wc => {
      try { safeSendToWebContents(wc, channel, payload); } catch (e) {}
    });
  } catch (e) {
    console.error('safeBroadcast error', e);
  }
}

// --- Simple in-memory session store (existing behavior preserved) ---
const SessionStore = {
  _token: null,
  _user: null,
  _avatarMeta: null,
  set(token, user) { this._token = token || null; this._user = user || null; console.log('SessionStore.set: token=', token ? `${String(token).slice(0,8)}...` : null); return true; },
  get() { return { token: this._token, user: this._user }; },
  clear() { console.log('SessionStore.clear'); this._token = null; this._user = null; return true; },

  // avatar meta persistence (keeps your behavior)
  async _loadAvatarMeta() {
    if (this._avatarMeta) return this._avatarMeta;
    try {
      const file = path.join(app.getPath('userData'), 'avatars', 'meta.json');
      const txt = await fsPromises.readFile(file, 'utf8').catch(()=>null);
      this._avatarMeta = txt ? JSON.parse(txt) : {};
    } catch (e) { this._avatarMeta = {}; }
    return this._avatarMeta;
  },
  async _saveAvatarMeta() {
    try {
      const dir = path.join(app.getPath('userData'), 'avatars');
      await fsPromises.mkdir(dir, { recursive: true });
      const file = path.join(dir, 'meta.json');
      await fsPromises.writeFile(file, JSON.stringify(this._avatarMeta || {}, null, 2), 'utf8');
    } catch (e) { console.error('Failed to write avatar meta', e); }
  },
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

// --- Session IPC: register both handle and on to avoid "No handler registered" races ---
// session:set
ipcMain.handle('session:set', async (event, token, user) => {
  try { SessionStore.set(token, user); return { ok: true }; } catch (err) { return { ok: false, error: String(err) }; }
});
ipcMain.on('session:set', (event, token, user) => {
  try { SessionStore.set(token, user); } catch (err) { console.error('session:set (on) error', err); }
});
// session:get
ipcMain.handle('session:get', async () => {
  try { return { ok: true, ...SessionStore.get() }; } catch (err) { return { ok: false, error: String(err) }; }
});
// session:clear
ipcMain.handle('session:clear', async () => {
  try { SessionStore.clear(); return { ok: true }; } catch (err) { return { ok: false, error: String(err) }; }
});
ipcMain.on('session:clear', (event) => {
  try { SessionStore.clear(); } catch (err) { console.error('session:clear (on) error', err); }
});

// --- Avatar cache / download helpers (preserve existing behavior) ---
const AVATARS_DIR = path.join(app.getPath('userData'), 'avatars');
const CACHE_TTL_MS = 5 * 60 * 1000;
function bufferToDataUrl(buf, mime='application/octet-stream') { return `data:${mime};base64,${buf.toString('base64')}`; }

let _fetch = global.fetch;
if (typeof _fetch !== 'function') {
  try { _fetch = require('node-fetch'); } catch (e) { _fetch = null; console.warn('fetch not available in main process'); }
}

async function downloadAvatarFromServer(userId, token, apiBase='http://localhost:8000/api') {
  if (!_fetch) return { ok: false, error: 'fetch-unavailable' };
  if (!userId) return { ok: false, error: 'userId-required' };
  try {
    const url = `${apiBase.replace(/\/+$/,'')}/user/icon/${encodeURIComponent(userId)}`;
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
    const resp = await _fetch(url, { method: 'GET', headers });
    if (!resp.ok) return { ok: false, status: resp.status, error: `http ${resp.status}` };
    const arr = await resp.arrayBuffer();
    const buf = Buffer.from(arr);
    const mime = (resp.headers && resp.headers.get) ? resp.headers.get('content-type') : 'application/octet-stream';
    const dataUrl = bufferToDataUrl(buf, mime);
    return { ok: true, dataUrl, mime, buffer: buf };
  } catch (e) { return { ok: false, error: String(e) }; }
}

async function saveAvatarToCache(userId, buffer, mime) {
  if (!userId || !buffer) return null;
  try {
    await fsPromises.mkdir(AVATARS_DIR, { recursive: true });
    const fileName = `avatar_${userId}.bin`;
    const filePath = path.join(AVATARS_DIR, fileName);
    await fsPromises.writeFile(filePath, buffer);
    const meta = { filePath, mime: mime || 'application/octet-stream', updatedAt: (new Date()).toISOString() };
    await SessionStore.setAvatarMeta(userId, meta);
    return meta;
  } catch (e) { console.error('saveAvatarToCache error', e); return null; }
}
function isCacheFresh(meta) {
  if (!meta || !meta.updatedAt) return false;
  try { return (Date.now() - new Date(meta.updatedAt).getTime()) <= CACHE_TTL_MS; } catch (e) { return false; }
}
async function getCachedDataUrl(userId) {
  const meta = await SessionStore.getAvatarMeta(userId);
  if (!meta || !meta.filePath) return null;
  try {
    const buf = await fsPromises.readFile(meta.filePath);
    return bufferToDataUrl(buf, meta.mime || 'application/octet-stream');
  } catch (e) { return null; }
}

// avatar handlers
ipcMain.handle('avatar:get', async (event, userId, opts = {}) => {
  try {
    const token = (opts && opts.token) ? opts.token : (SessionStore._token || null);
    const meta = await SessionStore.getAvatarMeta(userId);
    if (meta && isCacheFresh(meta)) {
      const dataUrl = await getCachedDataUrl(userId);
      if (dataUrl) return { ok: true, dataUrl, fromCache: true, updatedAt: meta.updatedAt };
    }
    if (meta) {
      const dataUrl = await getCachedDataUrl(userId);
      (async () => {
        try {
          const dl = await downloadAvatarFromServer(userId, token);
          if (dl.ok && dl.buffer) {
            await saveAvatarToCache(userId, dl.buffer, dl.mime);
            const newDataUrl = bufferToDataUrl(dl.buffer, dl.mime);
            safeBroadcast('avatar:changed', { userId, dataUrl: newDataUrl });
          } else if (dl.status === 404) {
            await SessionStore.deleteAvatarMeta(userId);
            safeBroadcast('avatar:changed', { userId, dataUrl: null, deleted: true });
          }
        } catch (e) {}
      })();
      if (dataUrl) return { ok: true, dataUrl, fromCache: true, updatedAt: meta.updatedAt, refreshing: true };
    }
    const dl = await downloadAvatarFromServer(userId, token);
    if (dl.ok && dl.buffer) {
      await saveAvatarToCache(userId, dl.buffer, dl.mime);
      const dataUrl = bufferToDataUrl(dl.buffer, dl.mime);
      return { ok: true, dataUrl, fromCache: false, updatedAt: (new Date()).toISOString() };
    }
    if (dl.status === 404) {
      await SessionStore.deleteAvatarMeta(userId);
      return { ok: false, notFound: true, error: 'not found' };
    }
    return { ok: false, error: dl.error || 'failed' };
  } catch (e) { return { ok: false, error: String(e) }; }
});

ipcMain.handle('avatar:forceRefresh', async (event, userId, tokenArg) => {
  try {
    const token = tokenArg || SessionStore._token || null;
    const dl = await downloadAvatarFromServer(userId, token);
    if (dl.ok && dl.buffer) {
      await saveAvatarToCache(userId, dl.buffer, dl.mime);
      const dataUrl = bufferToDataUrl(dl.buffer, dl.mime);
      safeBroadcast('avatar:changed', { userId, dataUrl });
      return { ok: true, dataUrl };
    } else if (dl.status === 404) {
      await SessionStore.deleteAvatarMeta(userId);
      safeBroadcast('avatar:changed', { userId, dataUrl: null, deleted: true });
      return { ok: true, notFound: true };
    } else return { ok: false, error: dl.error || 'download failed' };
  } catch (e) { return { ok: false, error: String(e) }; }
});

ipcMain.handle('avatar:clear', async (event, userId) => {
  try {
    const meta = await SessionStore.getAvatarMeta(userId);
    if (meta && meta.filePath) {
      try { await fsPromises.unlink(meta.filePath); } catch (e) {}
    }
    await SessionStore.deleteAvatarMeta(userId);
    safeBroadcast('avatar:changed', { userId, dataUrl: null, deleted: true });
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
});

// --- Windows and auth flow (preserve original behavior, use safeSend) ---
let authWindow = null;
let mainWindow = null;

function createAuthWindow () {
  authWindow = new BrowserWindow({
    width: 320, height: 380,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    autoHideMenuBar: true, resizable: false, icon: path.join(__dirname, 'img', 'logo.png'),
  });
  authWindow.removeMenu?.();
  authWindow.loadFile(path.join(__dirname, '..', 'auth', 'src', 'index.html'));
  authWindow.on('closed', () => { authWindow = null; });
  return authWindow;
}

const createWindow = () => {
  if (mainWindow) { try { mainWindow.focus(); } catch (e) {} return mainWindow; }
  mainWindow = new BrowserWindow({
    width: 1366, height: 768,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, webviewTag: true,
    },
    icon: path.join(__dirname, 'img', 'logo.png'),
    show: false, autoHideMenuBar: true,
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('ready-to-show', async () => {
    try {
      mainWindow.show();
    } catch (e) { console.error(e); }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
};

// Receive authentication from auth renderer
ipcMain.on('auth:authenticated', (event, payload) => {
  try {
    let token = null, user = null;
    if (!payload) {}
    else if (typeof payload === 'string') token = payload;
    else if (typeof payload === 'object') { token = payload.token || null; user = payload.user || null; }
    if (token) SessionStore.set(token, user);
    console.log('Main: auth:authenticated received. user=', user && user.username ? user.username : '[no user obj]');
    if (authWindow) { try { authWindow.close(); } catch (e) {} authWindow = null; }
    const win = createWindow();
    win.webContents.once('did-finish-load', () => {
      safeSendToWebContents(win.webContents, 'user:info', payload);
    });
  } catch (err) { console.error('Error handling auth:authenticated', err); }
});

// замените существующий ipcMain.on('auth:logout', ...) этим блоком
ipcMain.on('auth:logout', () => {
  try {
    console.log('Main: auth:logout received');

    // очистка сессии (как было)
    SessionStore.clear();

    // helper: безопасно закрыть devtools у конкретного webContents
    function closeDevToolsSafeForWC(wc) {
      try {
        if (!wc) return;
        if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) return;
        if (typeof wc.isDevToolsOpened === 'function' && wc.isDevToolsOpened()) {
          // closeDevTools может бросать, поэтому в try/catch
          try { wc.closeDevTools(); } catch (e) { console.warn('closeDevTools failed for wc', e); }
        }
      } catch (e) {
        console.warn('closeDevToolsSafeForWC error', e);
      }
    }

    // 1) закрыть DevTools у всех видимых окон (BrowserWindow)
    try {
      BrowserWindow.getAllWindows().forEach(win => {
        try {
          closeDevToolsSafeForWC(win && win.webContents);
        } catch (e) { /* ignore per-window error */ }
      });
    } catch (e) {
      console.warn('Failed to iterate BrowserWindow.getAllWindows()', e);
    }

    // 2) на всякий случай — пройтись по всем webContents (включая webviews) и закрыть DevTools
    try {
      webContents.getAllWebContents().forEach(wc => {
        try { closeDevToolsSafeForWC(wc); } catch (e) {}
      });
    } catch (e) {
      console.warn('Failed to iterate webContents.getAllWebContents()', e);
    }

    // После закрытия DevTools — закрываем основное окно и открываем окно авторизации
    if (mainWindow) {
      try { mainWindow.close(); } catch (e) { console.error('Error closing mainWindow', e); }
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

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

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

app.whenReady().then(() => {
  // Регистрация обработчиков (обязательно в main)
  ipcMain.handle('create-session', async (event, opts) => {
    // TODO: реальная логика создания сессии
    return { ok: true, token: `session-${Date.now()}` };
  });

  ipcMain.handle('generate-passage', async (event, opts) => {
    return { ok: true, text: 'Тестовый текст для набора.' , source: 'local' };
  });

  ipcMain.handle('record-keystroke', async (event, data) => {
    return { ok: true };
  });

  ipcMain.handle('save-passage', async (event, data) => { return { ok: true }; });
  ipcMain.handle('finalize-results', async (event, data) => { return { ok: true }; });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});