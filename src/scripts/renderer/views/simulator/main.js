const { ipcMain } = require('electron');
const path = require('node:path');
const fs = require('fs');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();

const BASE_DIR = __dirname;
const DB_DIR = path.join(BASE_DIR, 'data');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const DB_PATH = path.join(DB_DIR, 'typing.db');

// Открываем (или создаём) файл базы данных SQLite
const db = new sqlite3.Database(DB_PATH);

// Асинхронные обёртки для sqlite
// Небольшие promisified-версия методов run/all/get для удобства в async/await.

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

// Схема БД и её инициализация
/**
 * ensureSchema
 * Создаёт минимальные таблицы, необходимые для работы симулятора.
 * Алгоритм idempotent — безопасен при повторном запуске (IF NOT EXISTS).
 * Таблицы:
 *  - sessions: информация о сессии (токен, язык, длительность и т.п.)
 *  - passages: тексты для набора, привязанные к сессии
 *  - settings: настройки сессии (t9, морфология, стиль)
 *  - keystrokes: события нажатий клавиш (телеметрия)
 *  - results: итоговые результаты (wpm, accuracy и т.д.)
 */
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

ensureSchema().catch(err => {
  console.error('Ошибка при инициализации схемы БД:', err);
});

// Генератор случайного текста
/**
 * randomWords
 * Простейший генератор текста — возвращает строку из n случайных слов
 * (используется как заглушка; может быть заменён более сложным алгоритмом).
 */
function randomWords(n = 30) {
  const words = ("I and read this in pH from ask why").split(' ');
  const out = [];
  for (let i = 0; i < n; i++) out.push(words[Math.floor(Math.random() * words.length)]);
  return out.join(' ');
}

// IPC-обработчики 
/**
 * create-session
 * Генерирует новый токен сессии, создаёт запись в таблице sessions и базовые настройки в settings.
 * opts может содержать параметры: language, duration, punctuation, user_id, t9_enabled, morph_enabled, style.
 */
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

    // Вставляем запись о сессии и связанные параметры
    await runAsync(`INSERT INTO sessions(token, user_id, language, duration, punctuation) VALUES(?,?,?,?,?)`, [token, user_id, language, duration, punctuation]);
    await runAsync(`INSERT INTO settings(session_token, t9_enabled, morph_enabled, style) VALUES(?,?,?,?)`, [token, t9_enabled, morph_enabled, style]);

    return { ok: true, token, language, duration, punctuation };
  } catch (err) {
    // Логируем ошибку на русском и возвращаем понятный пользователю ответ на русском
    console.error('Ошибка при создании сессии:', err);
    return { ok: false, error: 'Не удалось создать сессию', detail: String(err) };
  }
});

/**
 * save-passage
 * Сохраняет текст (passage) в таблицу passages, привязанную к session_token.
 * Возвращает id созданной записи.
 */
ipcMain.handle('save-passage', async (event, data = {}) => {
  try {
    const { session_token, text, language = 'en', punctuation = 0, source = 'random' } = data || {};
    const res = await runAsync(`INSERT INTO passages(session_token, text, language, punctuation, source) VALUES(?,?,?,?,?)`, [session_token, text, language, punctuation, source]);
    return { ok: true, id: res.lastID };
  } catch (err) {
    console.error('Ошибка при сохранении passage:', err);
    return { ok: false, error: 'Не удалось сохранить текст задания', detail: String(err) };
  }
});

/**
 * record-keystroke
 * Фиксация одного события нажатия клавиши в таблице keystrokes.
 * Ожидаемые поля: session_token, t_ms (время в мс), key (строка), position (позиция в тексте), correct (0/1).
 */
ipcMain.handle('record-keystroke', async (event, data = {}) => {
  try {
    const { session_token, t_ms = 0, key = '', position = 0, correct = 0 } = data || {};
    await runAsync(`INSERT INTO keystrokes(session_token, t_ms, key, position, correct) VALUES(?,?,?,?,?)`, [session_token, t_ms, key, position, correct ? 1 : 0]);
    return { ok: true };
  } catch (err) {
    console.error('Ошибка при записи keystroke:', err);
    return { ok: false, error: 'Не удалось сохранить нажатие клавиши', detail: String(err) };
  }
});

/**
 * finalize-results
 * Сохраняет итоговые результаты сессии в таблицу results.
 * Ожидаемые поля: session_token, wpm, accuracy, total_chars, errors.
 */
ipcMain.handle('finalize-results', async (event, data = {}) => {
  try {
    const { session_token, wpm = 0, accuracy = 0, total_chars = 0, errors = 0 } = data || {};
    const res = await runAsync(`INSERT INTO results(session_token, wpm, accuracy, total_chars, errors) VALUES(?,?,?,?,?)`, [session_token, wpm, accuracy, total_chars, errors]);
    return { ok: true, id: res.lastID };
  } catch (err) {
    console.error('Ошибка при сохранении результатов:', err);
    return { ok: false, error: 'Не удалось сохранить результаты', detail: String(err) };
  }
});

/**
 * get-keystrokes
 * Возвращает все события keystrokes для заданной сессии (упорядоченные по id).
 * Полезно для воспроизведения сессии или отладки.
 */
ipcMain.handle('get-keystrokes', async (event, session_token) => {
  try {
    const rows = await allAsync(`SELECT * FROM keystrokes WHERE session_token = ? ORDER BY id ASC`, [session_token]);
    return { ok: true, rows };
  } catch (err) {
    console.error('Ошибка при получении keystrokes:', err);
    return { ok: false, error: 'Не удалось получить данные о нажатиях клавиш', detail: String(err) };
  }
});

/**
 * generate-passage
 * Генерирует новый текст-задание (passage) на клиент без обращения к внешним источникам.
 * opts.length_words — количество слов в сгенерированном тексте.
 */
ipcMain.handle('generate-passage', async (event, opts = {}) => {
  try {
    const words = Number(opts.length_words) || 30;
    const text = randomWords(words);
    return { ok: true, text, source: 'random' };
  } catch (err) {
    console.error('Ошибка при генерации текста:', err);
    return { ok: false, error: 'Не удалось сгенерировать текст', detail: String(err) };
  }
});

/**
 * get-results
 * Возвращает последние результаты из таблицы results (по убыванию created_at).
 * limit — максимальное число возвращаемых записей.
 */
ipcMain.handle('get-results', async (event, limit = 20) => {
  try {
    const rows = await allAsync(`SELECT * FROM results ORDER BY created_at DESC LIMIT ?`, [limit]);
    return { ok: true, rows };
  } catch (err) {
    console.error('Ошибка при получении результатов:', err);
    return { ok: false, error: 'Не удалось получить результаты', detail: String(err) };
  }
});
