// PRO_v1.3/src/scripts/renderer/views/simulator/main.js
// IPC handlers for the "simulator" webview — рабочая, самодостаточная реализация.

const { ipcMain } = require('electron');
const path = require('node:path');
const fs = require('fs');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();

const BASE_DIR = __dirname;
const DB_DIR = path.join(BASE_DIR, 'data');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const DB_PATH = path.join(DB_DIR, 'typing.db');

// открываем БД (файл будет создан, если его нет)
const db = new sqlite3.Database(DB_PATH);

// Асинхронные helper'ы для sqlite
function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}
function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}
function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

// Создать минимальные необходимые таблицы (safe при повторном запуске)
async function ensureSchema() {
  await runAsync(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER,
    language TEXT NOT NULL DEFAULT 'en',
    duration INTEGER NOT NULL DEFAULT 60,
    punctuation INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now'))
  );`);

  await runAsync(`CREATE TABLE IF NOT EXISTS passages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_token TEXT NOT NULL,
    text TEXT NOT NULL,
    language TEXT NOT NULL,
    punctuation INTEGER NOT NULL DEFAULT 0,
    source TEXT DEFAULT 'random',
    created_at DATETIME DEFAULT (datetime('now')),
    FOREIGN KEY(session_token) REFERENCES sessions(token) ON DELETE CASCADE
  );`);

  await runAsync(`CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_token TEXT NOT NULL,
    t9_enabled INTEGER NOT NULL DEFAULT 0,
    morph_enabled INTEGER NOT NULL DEFAULT 0,
    style TEXT DEFAULT 'plain',
    created_at DATETIME DEFAULT (datetime('now')),
    FOREIGN KEY(session_token) REFERENCES sessions(token) ON DELETE CASCADE
  );`);

  await runAsync(`CREATE TABLE IF NOT EXISTS keystrokes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_token TEXT NOT NULL,
    t_ms REAL,
    key TEXT,
    position INTEGER,
    correct INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now')),
    FOREIGN KEY(session_token) REFERENCES sessions(token) ON DELETE CASCADE
  );`);

  await runAsync(`CREATE TABLE IF NOT EXISTS results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_token TEXT NOT NULL,
    wpm REAL,
    accuracy REAL,
    total_chars INTEGER,
    errors INTEGER,
    created_at DATETIME DEFAULT (datetime('now')),
    FOREIGN KEY(session_token) REFERENCES sessions(token) ON DELETE CASCADE
  );`);
}
ensureSchema().catch(console.error);

// Простейший генератор текста (можно заменить алгоритмом)
function randomWords(n = 30) {
  const words = ("lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua").split(' ');
  const out = [];
  for (let i = 0; i < n; i++) out.push(words[Math.floor(Math.random() * words.length)]);
  return out.join(' ');
}

// IPC handlers

ipcMain.handle('create-session', async (event, opts = {}) => {
  try {
    const token = crypto.randomBytes(12).toString('hex');
    const {
      language = 'en',
      duration = 60,
      punctuation = 0,
      user_id = null,
      t9_enabled = 0,
      morph_enabled = 0,
      style = 'plain'
    } = opts || {};

    await runAsync(`INSERT INTO sessions(token, user_id, language, duration, punctuation) VALUES(?,?,?,?,?)`, [token, user_id, language, duration, punctuation]);
    await runAsync(`INSERT INTO settings(session_token, t9_enabled, morph_enabled, style) VALUES(?,?,?,?)`, [token, t9_enabled, morph_enabled, style]);

    return { ok: true, token, language, duration, punctuation };
  } catch (err) {
    console.error('create-session error', err);
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('save-passage', async (event, data = {}) => {
  try {
    const { session_token, text, language = 'en', punctuation = 0, source = 'random' } = data || {};
    const res = await runAsync(`INSERT INTO passages(session_token, text, language, punctuation, source) VALUES(?,?,?,?,?)`, [session_token, text, language, punctuation, source]);
    return { ok: true, id: res.lastID };
  } catch (err) {
    console.error('save-passage error', err);
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('record-keystroke', async (event, data = {}) => {
  try {
    const { session_token, t_ms = 0, key = '', position = 0, correct = 0 } = data || {};
    await runAsync(`INSERT INTO keystrokes(session_token, t_ms, key, position, correct) VALUES(?,?,?,?,?)`, [session_token, t_ms, key, position, correct ? 1 : 0]);
    return { ok: true };
  } catch (err) {
    console.error('record-keystroke error', err);
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('finalize-results', async (event, data = {}) => {
  try {
    const { session_token, wpm = 0, accuracy = 0, total_chars = 0, errors = 0 } = data || {};
    const res = await runAsync(`INSERT INTO results(session_token, wpm, accuracy, total_chars, errors) VALUES(?,?,?,?,?)`, [session_token, wpm, accuracy, total_chars, errors]);
    return { ok: true, id: res.lastID };
  } catch (err) {
    console.error('finalize-results error', err);
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('get-keystrokes', async (event, session_token) => {
  try {
    const rows = await allAsync(`SELECT * FROM keystrokes WHERE session_token = ? ORDER BY id ASC`, [session_token]);
    return { ok: true, rows };
  } catch (err) {
    console.error('get-keystrokes error', err);
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('generate-passage', async (event, opts = {}) => {
  try {
    const words = Number(opts.length_words) || 30;
    const text = randomWords(words);
    return { ok: true, text, source: 'random' };
  } catch (err) {
    console.error('generate-passage error', err);
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('get-results', async (event, limit = 20) => {
  try {
    const rows = await allAsync(`SELECT * FROM results ORDER BY created_at DESC LIMIT ?`, [limit]);
    return { ok: true, rows };
  } catch (err) {
    console.error('get-results error', err);
    return { ok: false, error: String(err) };
  }
});
