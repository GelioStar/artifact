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

// --- existing simulator loader (unchanged) ---
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

// --- Keep existing handler for main.json streaming (as-is) ---
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

// --- New: локали и i18n IPC handlers ---

async function readJsonSafe(filePath) {
  try {
    const text = await fsPromises.readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

async function loadLocaleData(lang) {
  // Try cached first
  const key = String(lang || '').toLowerCase();
  if (cachedLocales[key]) return cachedLocales[key];

  // base/default fallback (main.json)
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
    // expose locales without extension and exclude main.json if you want
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
    // reload into cache
    const data = await loadLocaleData(currentLocale);

    // Broadcast to all renderer/webview contexts
    try {
      // Send to all windows (main window renderers)
      BrowserWindow.getAllWindows().forEach(win => {
        try { win.webContents.send('i18n:update', { locale: currentLocale, data }); }
        catch (e) { /* ignore */ }
      });
      // Send to all webContents (covers webviews and other frames)
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

// --- rest of your existing main.js (window creation, auth flow, etc.) ---
// I keep the remainder of your original main.js behavior intact

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
      preload: path.join(__dirname, '..', 'auth', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    autoHideMenuBar: true,
    resizable: false,
    icon: path.join(__dirname, 'img', 'logo.png'),
  });
  
  authWindow.webContents.openDevTools({ mode: 'detach' });
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
    // when main window ready, immediately push current locale translations
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

// Receive authentication from auth renderer: token + user object
ipcMain.on('auth:authenticated', (event, payload) => {
  try {
    console.log('Main: auth:authenticated received. user=', payload && payload.user && payload.user.username);
    if (authWindow) {
      try { authWindow.close(); } catch (e) { console.error(e); }
      authWindow = null;
    }
    const win = createWindow();
    win.webContents.once('did-finish-load', () => {
      try {
        win.webContents.send('user:info', payload);
      } catch (err) { console.error('Failed to send user:info', err); }
    });
  } catch (err) {
    console.error('Error handling auth:authenticated', err);
  }
});

ipcMain.on('auth:logout', () => {
  try {
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

