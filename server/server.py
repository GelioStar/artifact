import os
import sqlite3
import secrets
import time
from datetime import datetime, timedelta
from typing import Generator, Optional, Dict, Any

from fastapi import FastAPI, HTTPException, Depends, Request, UploadFile, File, Header, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from passlib.context import CryptContext
from contextlib import asynccontextmanager

# Конфигурация
BASE_DIR = os.path.dirname(__file__)
DB_PATH = os.path.join(BASE_DIR, "app.db")

# Хеширование паролей — используем pbkdf2_sha256 через passlib
pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")


def ensure_db_file():
    """
    Убедиться, что файл базы данных существует.
    Если файла нет — создать пустой файл (будет инициализирован таблицами далее).
    """
    if not os.path.exists(DB_PATH):
        open(DB_PATH, "a").close()


def create_db_and_tables() -> None:
    """
    Создание необходимых таблиц в SQLite, если их нет.
    Настраивает режим журнала (WAL) и включение внешних ключей.
    Также добавляет колонку icon_mime в таблицу users, если её нет.
    """
    conn = sqlite3.connect(DB_PATH, timeout=30.0, check_same_thread=False)
    try:
        cur = conn.cursor()
        # Используем WAL для уменьшения конфликтов записи/чтения
        cur.execute("PRAGMA journal_mode=WAL;")
        cur.execute("PRAGMA synchronous = NORMAL;")
        cur.execute("PRAGMA foreign_keys = ON;")
        # Создание таблицы пользователей
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
        # Таблица сессий (токенов)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL
            )
        """)
        # При необходимости добавляем поле icon_mime
        cur.execute("PRAGMA table_info(users);")
        cols = [r[1] for r in cur.fetchall()]
        if "icon_mime" not in cols:
            cur.execute("ALTER TABLE users ADD COLUMN icon_mime TEXT;")
        conn.commit()
    finally:
        conn.close()


def _connect_db() -> sqlite3.Connection:
    """
    Установить соединение с SQLite.
    Здесь мы настраиваем PRAGMA и увеличиваем таймаут, чтобы уменьшить вероятность ошибки "database is locked".
    Возвращает объект соединения с настройкой row_factory для удобного доступа по именам колонок.
    """
    conn = sqlite3.connect(DB_PATH, timeout=30.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous = NORMAL;")
        conn.execute("PRAGMA busy_timeout = 30000;")
    except Exception:
        print("Предупреждение: не удалось установить PRAGMA для соединения")
    return conn


def hash_password(password: str) -> str:
    """
    Захешировать пароль с помощью passlib (pbkdf2_sha256).
    """
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    """
    Проверить соответствие простого пароля и хеша.
    Возвращает False при любых ошибках проверки (не бросаем исключение наружу).
    """
    try:
        return pwd_context.verify(plain, hashed)
    except Exception:
        return False


def get_db() -> Generator[sqlite3.Connection, None, None]:
    """
    Генератор зависимостей FastAPI для получения соединения с БД.
    Обеспечивает корректное закрытие соединения после использования.
    """
    conn = _connect_db()
    try:
        yield conn
    finally:
        conn.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Контекст жизненного цикла приложения.
    При старте — проверяем наличие файла базы и создаём таблицы.
    """
    print("Запуск: проверка существования файла базы данных и создание таблиц при необходимости...")
    ensure_db_file()
    create_db_and_tables()
    yield
    print("Завершение работы сервера.")


app = FastAPI(title="Auth server (SQLite, с ретраями при блокировке БД)", lifespan=lifespan)

# Разрешаем CORS для всех источников (локальный клиент подключается к серверу)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


#  Глобальная обработка исключений 
@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception):
    """
    Универсальный обработчик необработанных исключений.
    Логирует стек вызовов и возвращает JSON с сообщением на русском.
    """
    import traceback
    tb = traceback.format_exc()
    print("Необработанное исключение:\n", tb)
    return JSONResponse(status_code=500, content={"success": False, "error": "внутренняя ошибка сервера"})


#  Модели запросов 
class RegisterRequest(BaseModel):
    username: str
    password: str
    email: Optional[str] = None


class LoginRequest(BaseModel):
    username: str
    password: str


#  Вспомогательные утилиты 
def make_user_dict(row: sqlite3.Row) -> Dict[str, Any]:
    """
    Преобразование строки пользователя из БД в словарь для ответа.
    """
    return {
        "id": row["id"],
        "username": row["username"],
        "email": row["email"],
        "created_at": row["created_at"],
    }


def parse_iso_or_none(s: Optional[str]) -> Optional[datetime]:
    """
    Попытка распарсить ISO-строку даты; при неудаче вернуть None.
    Поддерживаем строки с пробелом между датой и временем.
    """
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
    Выполнение операции с повтором при ошибках блокировки БД (sqlite3.OperationalError с 'locked' или 'busy').
    cur_execute_func — функция, которая выполняет нужные SQL-операции (без аргументов или с args).
    retries — максимальное число попыток; backoff — множитель времени ожидания (растёт с каждой попыткой).
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
                    # если превышен лимит — пробрасываем исключение дальше
                    raise
                sleep_t = backoff * attempt
                time.sleep(sleep_t)
                continue
            # неперехватываемые OperationalError'ы пробрасываем дальше
            raise


def extract_token(authorization_header: Optional[str], query_token: Optional[str]) -> Optional[str]:
    """
    Извлечь токен из заголовка Authorization (Bearer ...) или из параметра ?token=...
    Приоритет отдаётся query_token, затем заголовку.
    """
    if query_token:
        return query_token
    if not authorization_header:
        return None
    auth = authorization_header.strip()
    if auth.lower().startswith("bearer "):
        return auth.split(None, 1)[1]
    return auth


def get_user_row_from_token(token: str, db: sqlite3.Connection) -> Optional[sqlite3.Row]:
    """
    Достать строку пользователя по токену сесии.
    Проверяет срок действия токена; при просрочке — удаляет сессию и возвращает None.
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
        # токен просрочен — пробуем удалить запись о сессии
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


#  Существующие endpoints (регистрация / логин / получение пользователя / выход / аватар) 
# (основная логика сохранена; сообщения и логи — на русском)


@app.post("/api/register")
def register(payload: RegisterRequest, db: sqlite3.Connection = Depends(get_db)):
    """
    Регистрация нового пользователя:
      - проверка входных данных
      - хеширование пароля
      - вставка в таблицу users с ретраями при блокировке БД
      - создание сессии (токена) для вновь созданного пользователя
    Возвращает token и данные пользователя при успехе.
    """
    username = (payload.username or "").strip()
    password = payload.password or ""
    email = payload.email

    if not username or not password:
        raise HTTPException(status_code=400, detail={"success": False, "error": "требуются имя пользователя и пароль"})
    if len(username) < 2 or len(password) < 6:
        return {"success": False, "error": "имя пользователя или пароль слишком короткие (мин: имя 2, пароль 6 символов)"}

    cur = db.cursor()
    created_at = datetime.now().isoformat()
    try:
        try:
            hashed = hash_password(password)
        except Exception:
            return {"success": False, "error": "не удалось захешировать пароль"}

        def do_insert():
            cur.execute(
                "INSERT INTO users (username, email, hashed_password, created_at) VALUES (?, ?, ?, ?)",
                (username, email, hashed, created_at)
            )
            db.commit()
            return True

        execute_with_retry(do_insert, retries=8, backoff=0.05)
        print(f"Зарегистрирован новый пользователь: {username}")
        user_id = cur.execute("SELECT id, username, email, created_at FROM users WHERE username = ?", (username,)).fetchone()["id"]

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

        row = cur.execute("SELECT id, username, email, created_at FROM users WHERE id = ?", (user_id,)).fetchone()
        user = make_user_dict(row)
        return {"success": True, "token": token, "user": user}

    except sqlite3.IntegrityError:
        # уникальность имени нарушена
        return {"success": False, "error": "имя пользователя уже существует"}
    except sqlite3.OperationalError as e:
        print("OperationalError при регистрации:", e)
        return {"success": False, "error": "база данных занята, попробуйте снова"}
    except Exception as e:
        print("Ошибка в register:", e)
        return {"success": False, "error": f"внутренняя ошибка: {str(e)}"}


@app.post("/api/login")
def login(payload: LoginRequest, db: sqlite3.Connection = Depends(get_db)):
    """
    Вход пользователя:
      - проверка наличия пользователя
      - проверка пароля
      - создание записи сессии (token) с ретраями при блокировке БД
    Возвращает token и данные пользователя при успехе.
    """
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
            print(f"Создана сессия для user_id={row['id']} token={token[:8]}...")
            user = make_user_dict(row)
            return {"success": True, "token": token, "user": user}
        except sqlite3.IntegrityError:
            # случаем токен мог совпасть — пробуем снова
            continue
        except sqlite3.OperationalError as e:
            print(f"OperationalError при создании сессии (попытка {attempt}):", e)
            time.sleep(0.05 * attempt)
            continue
    return {"success": False, "error": "не удалось создать сессию (база занята)"}


@app.get("/api/user")
def get_user(authorization: Optional[str] = Header(None), token: Optional[str] = None, db: sqlite3.Connection = Depends(get_db)):
    """
    Получение информации о пользователе по токену.
    Токен передаётся через заголовок Authorization или как параметр ?token=...
    """
    token_val = extract_token(authorization, token)
    if not token_val:
        raise HTTPException(status_code=401, detail={"success": False, "error": "требуется токен"})
    user_row = get_user_row_from_token(token_val, db)
    if not user_row:
        return {"success": False, "error": "некорректный или просроченный токен"}
    return {"success": True, "user": make_user_dict(user_row)}


@app.post("/api/logout")
def logout(payload: Dict[str, Any], db: sqlite3.Connection = Depends(get_db)):
    """
    Выход (удаление сессии по токену).
    Ожидается payload с ключом 'token'.
    """
    token = payload.get("token")
    if not token:
        return {"success": False, "error": "требуется токен"}
    cur = db.cursor()
    try:
        def do_delete():
            cur.execute("DELETE FROM sessions WHERE token = ?", (token,))
            db.commit()
            return True
        execute_with_retry(do_delete, retries=5, backoff=0.02)
        return {"success": True}
    except sqlite3.OperationalError as e:
        print("OperationalError при logout:", e)
        return {"success": False, "error": "база данных занята, попробуйте снова"}


@app.post("/api/user/icon")
async def upload_user_icon(
    request: Request,
    file: UploadFile = File(...),
    authorization: Optional[str] = Header(None),
    token: Optional[str] = None,
    db: sqlite3.Connection = Depends(get_db)
):
    """
    Загрузка аватара пользователя:
      - проверка токена
      - проверка размера и наличия файла
      - сохранение BLOB и mime в users
    """
    token_val = extract_token(authorization, token)
    if not token_val:
        raise HTTPException(status_code=401, detail={"success": False, "error": "требуется токен"})

    user_row = get_user_row_from_token(token_val, db)
    if not user_row:
        raise HTTPException(status_code=401, detail={"success": False, "error": "некорректный или просроченный токен"})

    MAX_BYTES = 2 * 1024 * 1024
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail={"success": False, "error": "пустой файл"})
    if len(content) > MAX_BYTES:
        raise HTTPException(status_code=413, detail={"success": False, "error": "файл слишком большой (макс 2 МБ)"})

    mime = file.content_type or "application/octet-stream"
    cur = db.cursor()
    try:
        def do_update():
            cur.execute("UPDATE users SET icon = ?, icon_mime = ? WHERE id = ?",
                        (sqlite3.Binary(content), mime, user_row["id"]))
            db.commit()
            return True

        execute_with_retry(do_update, retries=8, backoff=0.05)
        return {"success": True, "message": "аватар загружен"}
    except sqlite3.OperationalError as e:
        print("OperationalError при upload_user_icon:", e)
        raise HTTPException(status_code=500, detail={"success": False, "error": "база данных занята, попробуйте снова"})
    except Exception as e:
        print("Ошибка в upload_user_icon:", e)
        raise HTTPException(status_code=500, detail={"success": False, "error": "внутренняя ошибка сервера"})


@app.delete("/api/user/icon")
def delete_user_icon(
    authorization: Optional[str] = Header(None),
    token: Optional[str] = None,
    db: sqlite3.Connection = Depends(get_db)
):
    """
    Удаление аватара (обнуляет icon и icon_mime).
    Требуется валидный токен.
    """
    token_val = extract_token(authorization, token)
    if not token_val:
        return {"success": False, "error": "требуется токен"}
    user_row = get_user_row_from_token(token_val, db)
    if not user_row:
        return {"success": False, "error": "некорректный или просроченный токен"}

    cur = db.cursor()
    try:
        def do_update():
            cur.execute("UPDATE users SET icon = NULL, icon_mime = NULL WHERE id = ?", (user_row["id"],))
            db.commit()
            return True

        execute_with_retry(do_update, retries=6, backoff=0.05)
        return {"success": True, "message": "аватар удалён"}
    except sqlite3.OperationalError as e:
        print("OperationalError при delete_user_icon:", e)
        return {"success": False, "error": "база данных занята, попробуйте снова"}
    except Exception as e:
        print("Ошибка в delete_user_icon:", e)
        return {"success": False, "error": "внутренняя ошибка сервера"}


@app.get("/api/user/icon/{user_id}")
def get_user_icon(user_id: int, db: sqlite3.Connection = Depends(get_db)):
    """
    Получить аватар пользователя (BLOB) по id.
    Возвращает Response с media_type, если аватар найден, иначе 404.
    """
    cur = db.cursor()
    try:
        row = cur.execute("SELECT icon, icon_mime FROM users WHERE id = ?", (user_id,)).fetchone()
        if not row or not row["icon"]:
            return JSONResponse(status_code=404, content={"success": False, "error": "аватар не найден"})
        icon_bytes = row["icon"]
        mime = row["icon_mime"] or "application/octet-stream"
        return Response(content=icon_bytes, media_type=mime)
    except sqlite3.OperationalError as e:
        print("OperationalError при get_user_icon:", e)
        return JSONResponse(status_code=500, content={"success": False, "error": "база данных занята, попробуйте снова"})
    except Exception as e:
        print("Ошибка в get_user_icon:", e)
        return JSONResponse(status_code=500, content={"success": False, "error": "внутренняя ошибка сервера"})


#  Новый endpoint: смена пароля 
@app.post("/api/change_password")
def change_password(payload: Dict[str, str], authorization: Optional[str] = Header(None), token: Optional[str] = None, db: sqlite3.Connection = Depends(get_db)):
    """
    payload: { old_password: str, new_password: str }
    Токен должен быть передан через Authorization или ?token=...
    При успешной смене:
      - обновляется hashed_password
      - удаляются все сессии пользователя, кроме текущей
    """
    token_val = extract_token(authorization, token)
    if not token_val:
        raise HTTPException(status_code=401, detail={"success": False, "error": "требуется токен"})
    if not payload or 'old_password' not in payload or 'new_password' not in payload:
        raise HTTPException(status_code=400, detail={"success": False, "error": "требуются old_password и new_password"})

    old = payload.get('old_password') or ''
    new = payload.get('new_password') or ''
    if len(new) < 6:
        return {"success": False, "error": "новый пароль слишком короткий (мин 6 символов)"}
    cur = db.cursor()
    # найти сессию и пользователя
    s = cur.execute("SELECT token, user_id FROM sessions WHERE token = ?", (token_val,)).fetchone()
    if not s:
        return {"success": False, "error": "некорректный или просроченный токен"}
    user_id = s["user_id"]
    row = cur.execute("SELECT id, hashed_password FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        return {"success": False, "error": "пользователь не найден"}
    if not verify_password(old, row["hashed_password"]):
        return {"success": False, "error": "неверный пароль"}

    try:
        new_hashed = hash_password(new)
    except Exception:
        return {"success": False, "error": "не удалось захешировать новый пароль"}

    try:
        def do_change():
            cur.execute("UPDATE users SET hashed_password = ? WHERE id = ?", (new_hashed, user_id))
            # удалить все сессии этого пользователя, кроме текущей
            cur.execute("DELETE FROM sessions WHERE user_id = ? AND token != ?", (user_id, token_val))
            db.commit()
            return True
        execute_with_retry(do_change, retries=6, backoff=0.05)
        return {"success": True, "message": "пароль изменён"}
    except sqlite3.OperationalError as e:
        print("OperationalError при change_password:", e)
        return {"success": False, "error": "база данных занята, попробуйте снова"}
    except Exception as e:
        print("Ошибка в change_password:", e)
        return {"success": False, "error": "внутренняя ошибка сервера"}


#  Новый endpoint: удаление аккаунта 
@app.post("/api/delete_account")
def delete_account(payload: Optional[Dict[str, str]] = None, authorization: Optional[str] = Header(None), token: Optional[str] = None, db: sqlite3.Connection = Depends(get_db)):
    """
    Удаление аккаунта:
      - токен обязателен (Authorization: Bearer <token> или ?token=...)
      - payload может содержать 'password' для дополнительной проверки (опционально)
    Удаляются: все сессии пользователя и запись в users.
    """
    token_val = extract_token(authorization, token)
    if not token_val:
        raise HTTPException(status_code=401, detail={"success": False, "error": "требуется токен"})
    cur = db.cursor()
    s = cur.execute("SELECT token, user_id FROM sessions WHERE token = ?", (token_val,)).fetchone()
    if not s:
        return {"success": False, "error": "некорректный или просроченный токен"}
    user_id = s["user_id"]
    # если передан пароль — проверяем его
    if payload and 'password' in payload and payload['password'] is not None:
        p = payload['password']
        row = cur.execute("SELECT hashed_password FROM users WHERE id = ?", (user_id,)).fetchone()
        if not row or not verify_password(p, row["hashed_password"]):
            return {"success": False, "error": "неверный пароль"}

    try:
        def do_delete():
            # удалить сессии пользователя
            cur.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
            # удалить пользователя (BLOB аватар также удалится вместе со строкой)
            cur.execute("DELETE FROM users WHERE id = ?", (user_id,))
            db.commit()
            return True
        execute_with_retry(do_delete, retries=6, backoff=0.05)
        return {"success": True, "message": "аккаунт удалён"}
    except sqlite3.OperationalError as e:
        print("OperationalError при delete_account:", e)
        return {"success": False, "error": "база данных занята, попробуйте снова"}
    except Exception as e:
        print("Ошибка в delete_account:", e)
        return {"success": False, "error": "внутренняя ошибка сервера"}


# Запуск сервера (для запуска напрямую)
if __name__ == "__main__":
    import uvicorn
    # Запускаем приложение uvicorn: указываем модуль 'server' и приложение 'app'
    uvicorn.run("server:app", host="127.0.0.1", port=8000, log_level="info", reload=False)
