// main.js — main process (Electron)
const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const { pathToFileURL } = require('url');
const oboe = require('oboe');

let MAIN_JSON_PATH = path.join(__dirname, '..', 'locales', 'main.json');

// --- подключаем IPC хэндлеры симулятора (если файл существует) ---
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
      preload: path.join(__dirname, 'auth', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    autoHideMenuBar: true,
    resizable: false,
    icon: path.join(__dirname, 'img', 'logo.png'),
  });
  authWindow.removeMenu?.();
  authWindow.loadFile(path.join(__dirname, 'auth', 'src', 'index.html'));
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
  mainWindow.on('ready-to-show', () => mainWindow.show());
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
    // payload: { token: '...', user: { id, username, email, created_at } }
    console.log('Main: auth:authenticated received. user=', payload && payload.user && payload.user.username);
    // close auth window
    if (authWindow) {
      try { authWindow.close(); } catch (e) { console.error(e); }
      authWindow = null;
    }
    // create main window
    const win = createWindow();
    // after the main window has loaded, send user info to main renderer
    win.webContents.once('did-finish-load', () => {
      try {
        win.webContents.send('user:info', payload); // payload includes token and user
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
