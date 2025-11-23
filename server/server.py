# server.py — FastAPI auth server с обработкой "database is locked"
import os
import sqlite3
import secrets
import time
from datetime import datetime, timedelta
from typing import Generator, Optional, Dict, Any

from fastapi import FastAPI, HTTPException, Depends, Request, UploadFile, File, Header, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from passlib.context import CryptContext
from contextlib import asynccontextmanager

# --- Config ---
BASE_DIR = os.path.dirname(__file__)
DB_PATH = os.path.join(BASE_DIR, "app.db")

# Use pbkdf2_sha256 (no external C deps)
pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")

# --- DB helpers ---
def ensure_db_file():
    # создаём пустой файл .db если его нет
    if not os.path.exists(DB_PATH):
        open(DB_PATH, "a").close()

def create_db_and_tables() -> None:
    """
    Создаём таблицы при старте и добавляем колонку icon_mime, если её нет.
    Это позволяет безопасно мигрировать уже существующую БД.
    """
    conn = sqlite3.connect(DB_PATH, timeout=30.0, check_same_thread=False)
    try:
        cur = conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL;")
        cur.execute("PRAGMA synchronous = NORMAL;")
        cur.execute("PRAGMA foreign_keys = ON;")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                email TEXT,
                hashed_password TEXT NOT NULL,
                icon BLOB,
                created_at TEXT NOT NULL
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL
            )
        """)
        # если колонки icon_mime ещё нет — добавим
        cur.execute("PRAGMA table_info(users);")
        cols = [r[1] for r in cur.fetchall()]
        if "icon_mime" not in cols:
            # ALTER TABLE ADD COLUMN безопасен — новая колонка будет NULL для старых записей
            cur.execute("ALTER TABLE users ADD COLUMN icon_mime TEXT;")
        conn.commit()
    finally:
        conn.close()

def _connect_db() -> sqlite3.Connection:
    # timeout увеличивает время ожидания освобождения блокировки SQLite
    conn = sqlite3.connect(DB_PATH, timeout=30.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    # задаём pragma на соединение для лучшей конкуррентности
    try:
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous = NORMAL;")
        conn.execute("PRAGMA busy_timeout = 30000;")  # миллисекунды
    except Exception:
        # pragma могут не поддерживаться в некоторых окружениях — игнорируем, но логируем
        print("Warning: could not set pragmas on connection")
    return conn

def hash_password(password: str) -> str:
    return pwd_context.hash(password)

def verify_password(plain: str, hashed: str) -> bool:
    try:
        return pwd_context.verify(plain, hashed)
    except Exception:
        return False

# Connection dependency: новое соединение на каждый запрос
def get_db() -> Generator[sqlite3.Connection, None, None]:
    conn = _connect_db()
    try:
        yield conn
    finally:
        conn.close()

# --- Lifespan (startup) ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    print("Startup: ensure DB file and tables exist...")
    ensure_db_file()
    create_db_and_tables()
    yield
    print("Shutdown")

app = FastAPI(title="Auth server (SQLite, retries for locked DB)", lifespan=lifespan)

# CORS for Electron client
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Generic exception handler -> always return JSON
@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception):
    import traceback
    tb = traceback.format_exc()
    print("Unhandled exception:\n", tb)
    return JSONResponse(status_code=500, content={"success": False, "error": "internal server error"})

# --- Request models ---
class RegisterRequest(BaseModel):
    username: str
    password: str
    email: Optional[str] = None

class LoginRequest(BaseModel):
    username: str
    password: str

# --- Helpers ---
def make_user_dict(row: sqlite3.Row) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "username": row["username"],
        "email": row["email"],
        "created_at": row["created_at"],
    }

def parse_iso_or_none(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s)
    except Exception:
        try:
            return datetime.fromisoformat(s.replace(" ", "T"))
        except Exception:
            return None

def execute_with_retry(cur_execute_func, *args, retries=5, backoff=0.05):
    """
    cur_execute_func должен быть callable, исполняющим операцию с курсором (и commit при необходимости).
    Повторим попытки при sqlite3.OperationalError с сообщением 'database is locked' или 'busy'.
    """
    import sqlite3
    attempt = 0
    while True:
        try:
            return cur_execute_func(*args)
        except sqlite3.OperationalError as e:
            msg = str(e).lower()
            if "locked" in msg or "busy" in msg:
                attempt += 1
                if attempt > retries:
                    raise
                # экспоненциальный бэк-оф (простая версия)
                sleep_t = backoff * attempt
                time.sleep(sleep_t)
                continue
            raise

def extract_token(authorization_header: Optional[str], query_token: Optional[str]) -> Optional[str]:
    """
    Поддерживаем передачу токена либо в заголовке Authorization: Bearer <token>,
    либо как query-параметр token.
    """
    if query_token:
        return query_token
    if not authorization_header:
        return None
    auth = authorization_header.strip()
    if auth.lower().startswith("bearer "):
        return auth.split(None, 1)[1]
    return auth  # если передали просто сам токен в заголовке

def get_user_row_from_token(token: str, db: sqlite3.Connection) -> Optional[sqlite3.Row]:
    """
    Проверяем валидность сессии по токену и возвращаем строку пользователя (users).
    Возвращаем None если токен не валиден / истёк / пользователь удалён.
    """
    if not token:
        return None
    cur = db.cursor()
    s = cur.execute("SELECT token, user_id, expires_at FROM sessions WHERE token = ?", (token,)).fetchone()
    if not s:
        return None
    expires_at_str = s["expires_at"]
    expires_dt = parse_iso_or_none(expires_at_str)
    if expires_dt is None or expires_dt < datetime.now():
        # удаляем некорректную/просроченную сессию
        try:
            def _del():
                cur.execute("DELETE FROM sessions WHERE token = ?", (token,))
                db.commit()
                return True
            execute_with_retry(_del, retries=3, backoff=0.02)
        except Exception:
            pass
        return None
    u = cur.execute("SELECT id, username, email, created_at FROM users WHERE id = ?", (s["user_id"],)).fetchone()
    return u

# --- Endpoints (existing) ---
@app.post("/api/register")
def register(payload: RegisterRequest, db: sqlite3.Connection = Depends(get_db)):
    username = (payload.username or "").strip()
    password = payload.password or ""
    email = payload.email

    if not username or not password:
        raise HTTPException(status_code=400, detail={"success": False, "error": "username and password required"})
    if len(username) < 2 or len(password) < 6:
        return {"success": False, "error": "username or password too short (min username 2, password 6 chars)"}

    cur = db.cursor()
    created_at = datetime.now().isoformat()
    try:
        try:
            hashed = hash_password(password)
        except Exception:
            return {"success": False, "error": "could not hash password"}

        def do_insert():
            cur.execute(
                "INSERT INTO users (username, email, hashed_password, created_at) VALUES (?, ?, ?, ?)",
                (username, email, hashed, created_at)
            )
            db.commit()
            return True

        execute_with_retry(do_insert, retries=8, backoff=0.05)
        print(f"Registered new user: {username}")
        user_id = cur.execute("SELECT id, username, email, created_at FROM users WHERE username = ?", (username,)).fetchone()["id"]

        # создаём сессию
        token = secrets.token_hex(32)
        now_iso = datetime.now().isoformat()
        expires_iso = (datetime.now() + timedelta(days=7)).isoformat()

        def do_session_insert():
            cur.execute(
                "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
                (token, user_id, now_iso, expires_iso)
            )
            db.commit()
            return True

        execute_with_retry(do_session_insert, retries=6, backoff=0.05)

        # читаем строку пользователя и вернём
        row = cur.execute("SELECT id, username, email, created_at FROM users WHERE id = ?", (user_id,)).fetchone()
        user = make_user_dict(row)
        return {"success": True, "token": token, "user": user}
    
    except sqlite3.IntegrityError:
        return {"success": False, "error": "username already exists"}
    except sqlite3.OperationalError as e:
        # locked after retries
        print("OperationalError on register:", e)
        return {"success": False, "error": "database locked, try again"}
    except Exception as e:
        print("Error in register:", e)
        return {"success": False, "error": f"internal error: {str(e)}"}

@app.post("/api/login")
def login(payload: LoginRequest, db: sqlite3.Connection = Depends(get_db)):
    username = (payload.username or "").strip()
    password = payload.password or ""
    if not username or not password:
        return {"success": False, "error": "Данные указаны неверно."}

    cur = db.cursor()
    row = cur.execute("SELECT id, username, email, hashed_password, created_at FROM users WHERE username = ?", (username,)).fetchone()
    if not row:
        return {"success": False, "error": "Данные указаны неверно."}

    if not verify_password(password, row["hashed_password"]):
        return {"success": False, "error": "Данные указаны неверно."}

    # Create session with retry on locked DB
    for attempt in range(1, 6):
        token = secrets.token_hex(32)
        now_iso = datetime.now().isoformat()
        expires_iso = (datetime.now() + timedelta(days=7)).isoformat()
        try:
            def do_session_insert():
                cur.execute(
                    "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
                    (token, row["id"], now_iso, expires_iso)
                )
                db.commit()
                return True

            execute_with_retry(do_session_insert, retries=6, backoff=0.05)
            print(f"Created session for user_id={row['id']} token={token[:8]}...")
            user = make_user_dict(row)
            return {"success": True, "token": token, "user": user}
        except sqlite3.IntegrityError:
            # improbable token collision — try again
            continue
        except sqlite3.OperationalError as e:
            print(f"OperationalError while creating session (attempt {attempt}):", e)
            # короткий sleep и повтор
            time.sleep(0.05 * attempt)
            continue
    return {"success": False, "error": "could not create session (db busy)"}

@app.get("/api/user")
def get_user(token: Optional[str] = None, db: sqlite3.Connection = Depends(get_db)):
    if not token:
        raise HTTPException(status_code=400, detail={"success": False, "error": "token required"})
    cur = db.cursor()
    s = cur.execute("SELECT token, user_id, expires_at FROM sessions WHERE token = ?", (token,)).fetchone()
    if not s:
        return {"success": False, "error": "invalid token"}

    expires_at_str = s["expires_at"]
    expires_dt = parse_iso_or_none(expires_at_str)
    if expires_dt is None:
        cur.execute("DELETE FROM sessions WHERE token = ?", (token,))
        db.commit()
        return {"success": False, "error": "invalid token"}
    if expires_dt < datetime.now():
        cur.execute("DELETE FROM sessions WHERE token = ?", (token,))
        db.commit()
        return {"success": False, "error": "token expired"}

    u = cur.execute("SELECT id, username, email, created_at FROM users WHERE id = ?", (s["user_id"],)).fetchone()
    if not u:
        return {"success": False, "error": "user not found"}
    return {"success": True, "user": make_user_dict(u)}

@app.post("/api/logout")
def logout(payload: Dict[str, Any], db: sqlite3.Connection = Depends(get_db)):
    token = payload.get("token")
    if not token:
        return {"success": False, "error": "token required"}
    cur = db.cursor()
    try:
        def do_delete():
            cur.execute("DELETE FROM sessions WHERE token = ?", (token,))
            db.commit()
            return True
        execute_with_retry(do_delete, retries=5, backoff=0.02)
        return {"success": True}
    except sqlite3.OperationalError as e:
        print("OperationalError on logout:", e)
        return {"success": False, "error": "database locked, try again"}

# --- Новые эндпойнты для работы с иконкой профиля ---

@app.post("/api/user/icon")
async def upload_user_icon(
    request: Request,
    file: UploadFile = File(...),
    authorization: Optional[str] = Header(None),
    token: Optional[str] = None,
    db: sqlite3.Connection = Depends(get_db)
):
    """
    Загрузить или заменить иконку текущего пользователя.
    Поддерживается передача токена в заголовке Authorization: Bearer <token>
    или как query-параметр token.
    """
    # извлекаем токен (header или query)
    token_val = extract_token(authorization, token)
    if not token_val:
        raise HTTPException(status_code=401, detail={"success": False, "error": "token required"})

    # проверяем сессию и получаем пользователя
    user_row = get_user_row_from_token(token_val, db)
    if not user_row:
        raise HTTPException(status_code=401, detail={"success": False, "error": "invalid or expired token"})

    # ограничение размера файла (безопасность) — например 2 MiB
    MAX_BYTES = 2 * 1024 * 1024
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail={"success": False, "error": "empty file"})
    if len(content) > MAX_BYTES:
        raise HTTPException(status_code=413, detail={"success": False, "error": "file too large (max 2MB)"})

    # MIME-тип файла (например image/png, image/jpeg)
    mime = file.content_type or "application/octet-stream"

    cur = db.cursor()
    try:
        def do_update():
            # используем sqlite3.Binary для записи BLOB
            cur.execute("UPDATE users SET icon = ?, icon_mime = ? WHERE id = ?",
                        (sqlite3.Binary(content), mime, user_row["id"]))
            db.commit()
            return True

        execute_with_retry(do_update, retries=8, backoff=0.05)
        return {"success": True, "message": "icon uploaded"}
    except sqlite3.OperationalError as e:
        print("OperationalError on upload_user_icon:", e)
        raise HTTPException(status_code=500, detail={"success": False, "error": "database locked, try again"})
    except Exception as e:
        print("Error in upload_user_icon:", e)
        raise HTTPException(status_code=500, detail={"success": False, "error": "internal error"})

@app.delete("/api/user/icon")
def delete_user_icon(
    authorization: Optional[str] = Header(None),
    token: Optional[str] = None,
    db: sqlite3.Connection = Depends(get_db)
):
    """
    Удалить (выгрузить) иконку текущего пользователя — очищает поле icon и icon_mime.
    Токен — в заголовке Authorization или query-параметре token.
    """
    token_val = extract_token(authorization, token)
    if not token_val:
        return {"success": False, "error": "token required"}
    user_row = get_user_row_from_token(token_val, db)
    if not user_row:
        return {"success": False, "error": "invalid or expired token"}

    cur = db.cursor()
    try:
        def do_update():
            cur.execute("UPDATE users SET icon = NULL, icon_mime = NULL WHERE id = ?", (user_row["id"],))
            db.commit()
            return True

        execute_with_retry(do_update, retries=6, backoff=0.05)
        return {"success": True, "message": "icon deleted"}
    except sqlite3.OperationalError as e:
        print("OperationalError on delete_user_icon:", e)
        return {"success": False, "error": "database locked, try again"}
    except Exception as e:
        print("Error in delete_user_icon:", e)
        return {"success": False, "error": "internal error"}

@app.get("/api/user/icon/{user_id}")
def get_user_icon(user_id: int, db: sqlite3.Connection = Depends(get_db)):
    """
    Отдать иконку пользователя как raw image bytes с корректным Content-Type.
    Доступен публично по user_id (можно изменить логику — разрешить только для авторизованных запросов).
    """
    cur = db.cursor()
    try:
        row = cur.execute("SELECT icon, icon_mime FROM users WHERE id = ?", (user_id,)).fetchone()
        if not row or not row["icon"]:
            # иконка не найдена
            return JSONResponse(status_code=404, content={"success": False, "error": "icon not found"})
        icon_bytes = row["icon"]
        mime = row["icon_mime"] or "application/octet-stream"
        # возвращаем raw bytes с правильным MIME
        return Response(content=icon_bytes, media_type=mime)
    except sqlite3.OperationalError as e:
        print("OperationalError on get_user_icon:", e)
        return JSONResponse(status_code=500, content={"success": False, "error": "database locked, try again"})
    except Exception as e:
        print("Error in get_user_icon:", e)
        return JSONResponse(status_code=500, content={"success": False, "error": "internal error"})

# Run when executed directly
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="127.0.0.1", port=8000, log_level="info", reload=False)
