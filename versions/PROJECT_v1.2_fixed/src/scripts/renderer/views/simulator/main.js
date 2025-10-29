const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.join(__dirname, 'data', 'typing.db');
const WEBVIEW_PRELOAD = path.join(__dirname, '..', '..', '..', '..', '..', 'webview-preload.js');
const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, 'sql', 'schema.sql'), 'utf8');

console.log('WEBVIEW_PRELOAD:', WEBVIEW_PRELOAD);

// ensure data dir exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

let db;

// initialize sqlite DB, run schema
async function initDb() {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) return reject(err);
      // Enable foreign keys
      db.exec('PRAGMA foreign_keys = ON;', (e) => {
        if (e) console.error('PRAGMA error', e);
        db.exec(SCHEMA_SQL, (err2) => {
          if (err2) return reject(err2);
          resolve(db);
        });
      });
    });
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100, height: 760, show: true,
    webPreferences: {
      preload: path.join(__dirname, '..', '..', '..', '..', '..', 'webview-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  console.log('Main window created');
}

app.whenReady().then(async () => {
  try {
    await initDb();
    createWindow();
  } catch (err) {
    console.error('Failed to init DB', err);
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// Helper: run SQL with Promise
function runAsync(sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) { if (err) reject(err); else resolve(this); });
  });
}
function allAsync(sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => { if (err) reject(err); else resolve(rows); });
  });
}
function getAsync(sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => { if (err) reject(err); else resolve(row); });
  });
}

// IPC: create session
ipcMain.handle('create-session', async (event, opts) => {
  const token = require('crypto').randomBytes(12).toString('hex');
  const { language='en', duration=60, punctuation=0, user_id=null, t9_enabled=0, morph_enabled=0, style='plain' } = opts || {};
  try {
    await runAsync('INSERT INTO sessions(token, user_id, language, duration, punctuation) VALUES(?,?,?,?,?)', [token, user_id, language, duration, punctuation]);
    // create settings row
    await runAsync('INSERT INTO settings(session_token, t9_enabled, morph_enabled, style) VALUES(?,?,?,?)', [token, t9_enabled, morph_enabled, style]);
    return { ok:true, token, language, duration, punctuation };
  } catch (err) {
    console.error('create-session error', err);
    return { ok:false, error: String(err) };
  }
});

// IPC: save passage
ipcMain.handle('save-passage', async (event, data) => {
  try {
    const { session_token, text, language='en', punctuation=0, source='random' } = data;
    const res = await runAsync('INSERT INTO passages(session_token, text, language, punctuation, source) VALUES(?,?,?,?,?)', [session_token, text, language, punctuation, source]);
    return { ok:true, id: res.lastID };
  } catch (err) { return { ok:false, error: String(err) }; }
});

// IPC: record keystroke
ipcMain.handle('record-keystroke', async (event, data) => {
  try {
    const { session_token, t_ms, key, position, correct } = data;
    await runAsync('INSERT INTO keystrokes(session_token, t_ms, key, position, correct) VALUES(?,?,?,?,?)', [session_token, t_ms, key, position, correct?1:0]);
    return { ok:true };
  } catch (err) { return { ok:false, error: String(err) }; }
});

// IPC: finalize results
ipcMain.handle('finalize-results', async (event, data) => {
  try {
    const { session_token, wpm, avg_wpm, errors, accuracy } = data;
    await runAsync('INSERT INTO results(session_token,wpm,avg_wpm,errors,accuracy) VALUES(?,?,?,?,?)', [session_token,wpm,avg_wpm,errors,accuracy]);
    return { ok:true };
  } catch (err) { return { ok:false, error: String(err) }; }
});

// IPC: get keystrokes by session
ipcMain.handle('get-keystrokes', async (event, session_token) => {
  try {
    const rows = await allAsync('SELECT * FROM keystrokes WHERE session_token = ? ORDER BY t_ms ASC', [session_token]);
    return { ok:true, rows };
  } catch (err) { return { ok:false, error: String(err) }; }
});

// IPC: generate passage (random or t9)
ipcMain.handle('generate-passage', async (event, opts) => {
  const { language='en', length_words=30, style='plain', generator='random' } = opts || {};
  // simple wordlists embedded for both languages
  const en = "time person year way day thing man world life hand part child eye".split(' ');
  const ru = "время человек год путь день вещь мир жизнь рука часть ребенок глаз".split(' ');
  const dict = language === 'ru' ? ru : en;
  function randomWords(n) { let a=[]; for(let i=0;i<n;i++){ a.push(dict[Math.floor(Math.random()*dict.length)]) } return a.join(style==='plain'?' ':' '); }
  if (generator === 't9') {
    // simple T9-mapped random generation: pick digits, map to letters roughly (placeholder)
    return { ok:true, text: randomWords(length_words), source: 't9' };
  }
  return { ok:true, text: randomWords(length_words), source: 'random' };
});

// IPC: get latest results (limit)
ipcMain.handle('get-results', async (event, limit=20) => {
  try {
    const rows = await allAsync('SELECT * FROM results ORDER BY created_at DESC LIMIT ?', [limit]);
    return { ok:true, rows };
  } catch (err) { return { ok:false, error: String(err) }; }
});
