PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER,
  language TEXT NOT NULL DEFAULT 'en',
  duration INTEGER NOT NULL DEFAULT 60, -- seconds
  punctuation INTEGER NOT NULL DEFAULT 0, -- 0/1
  created_at DATETIME DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS passages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_token TEXT NOT NULL,
  text TEXT NOT NULL,
  language TEXT NOT NULL,
  punctuation INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  created_at DATETIME DEFAULT (datetime('now')),
  FOREIGN KEY(session_token) REFERENCES sessions(token) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS keystrokes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_token TEXT NOT NULL,
  t_ms INTEGER NOT NULL, -- ms from session start
  key TEXT NOT NULL,
  position INTEGER NOT NULL, -- index in passage
  correct INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT (datetime('now')),
  FOREIGN KEY(session_token) REFERENCES sessions(token) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_token TEXT NOT NULL,
  wpm REAL,
  avg_wpm REAL,
  errors INTEGER,
  accuracy REAL,
  created_at DATETIME DEFAULT (datetime('now')),
  FOREIGN KEY(session_token) REFERENCES sessions(token) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_token TEXT NOT NULL,
  t9_enabled INTEGER NOT NULL DEFAULT 0,
  morph_enabled INTEGER NOT NULL DEFAULT 0,
  style TEXT DEFAULT 'plain', -- 'plain'|'punctuated'
  created_at DATETIME DEFAULT (datetime('now')),
  FOREIGN KEY(session_token) REFERENCES sessions(token) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS metadata (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_token TEXT NOT NULL,
  meta_key TEXT,
  meta_value TEXT,
  created_at DATETIME DEFAULT (datetime('now')),
  FOREIGN KEY(session_token) REFERENCES sessions(token) ON DELETE CASCADE
);
