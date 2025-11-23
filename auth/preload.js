// preload.js — для main window
const { contextBridge, ipcRenderer } = require('electron');

const API_BASE = process.env.AUTH_SERVER_URL || 'http://localhost:8000/api';

function handleFetch(res) {
  // Попытка распарсить JSON; если не JSON — вернуть понятный объект ошибки
  return res.json().then(j => j).catch(()=>({ success:false, error: 'Invalid JSON response' }));
}

/**
 * Вспомогательная обёртка для fetch, добавляющая Authorization заголовок,
 * если передан token. Возвращает promise от fetch.
 */
function fetchWithAuth(url, opts = {}, token) {
  const headers = opts.headers ? {...opts.headers} : {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return fetch(url, {...opts, headers});
}

// --- auth API (как было, но getUser теперь поддерживает Authorization header) ---
contextBridge.exposeInMainWorld('auth', {
  // регистрация
  register: async (data) => {
    const res = await fetch(`${API_BASE}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
    return handleFetch(res);
  },

  // логин
  login: async (data) => {
    const res = await fetch(`${API_BASE}/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
    return handleFetch(res);
  },

  // получение информации о пользователе
  // если передан token, он будет передан в заголовке Authorization (предпочтительно)
  // если token === null|undefined, будет выполнен запрос без авторизации
  getUser: async (token) => {
    const url = `${API_BASE}/user` + (token ? `` : '');
    // используем заголовок Authorization, если token есть
    const res = await fetchWithAuth(url, { method: 'GET' }, token);
    return handleFetch(res);
  },

  // выход (logout)
  logout: async (token) => {
    // сервер ожидает JSON { token }
    const res = await fetch(`${API_BASE}/logout`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token })
    });
    return handleFetch(res);
  },
});

// --- NEW: profile / icon API ---
// API для загрузки, изменения и удаления иконки профиля пользователя.
// Комментарии и названия методов на русском для удобства.
contextBridge.exposeInMainWorld('profile', {
  /**
   * Загрузить или заменить иконку профиля.
   * file — объект File или Blob из input[type=file] (например fileInput.files[0])
   * token — (опционально) токен сессии; если передан, отправляется в Authorization заголовке
   */
  uploadIcon: async (file, token) => {
    if (!file) return { success: false, error: 'file required' };
    const form = new FormData();
    // поле называется file — так ожидает FastAPI UploadFile в сервере
    form.append('file', file);

    const res = await fetchWithAuth(`${API_BASE}/user/icon`, {
      method: 'POST',
      body: form
    }, token);
    // возвращаем JSON-ответ (сервер отдаёт JSON)
    return handleFetch(res);
  },

  /**
   * Удалить иконку текущего пользователя.
   * token — (обязательно) токен сессии
   */
  deleteIcon: async (token) => {
    const res = await fetchWithAuth(`${API_BASE}/user/icon`, {
      method: 'DELETE'
    }, token);
    return handleFetch(res);
  },

  /**
   * Получить публичный URL до иконки пользователя (для использования в <img src="...">)
   * Если token передан — он добавляется в query string (?token=...) чтобы можно было
   * использовать адрес в img tag'е (img не посылает Authorization-заголовок).
   *
   * Пример использования:
   * <img src={window.profile.getIconUrl(userId, token)} />
   */
  getIconUrl: (userId, token) => {
    if (!userId && userId !== 0) return null;
    const base = `${API_BASE}/user/icon/${encodeURIComponent(userId)}`;
    if (token) {
      return `${base}?token=${encodeURIComponent(token)}`;
    }
    return base;
  },

  /**
   * Получить data URL (base64) иконки пользователя, выполнив fetch с Authorization заголовком.
   * Это полезно, когда иконка приватная и требуется передать токен в заголовке.
   * Возвращает строку 'data:<mime>;base64,...' или null при ошибке.
   *
   * Пример:
   * const dataUrl = await window.profile.fetchIconDataUrl(userId, token);
   * img.src = dataUrl;
   */
  fetchIconDataUrl: async (userId, token) => {
    if (!userId && userId !== 0) return { success: false, error: 'userId required' };
    if (!token) return { success: false, error: 'token required for fetchIconDataUrl' };

    try {
      // запрашиваем иконку с заголовком Authorization
      const res = await fetchWithAuth(`${API_BASE}/user/icon/${encodeURIComponent(userId)}`, { method: 'GET' }, token);
      if (!res.ok) {
        // пытаемся прочитать JSON-ошибку
        try {
          const j = await res.json();
          return { success: false, status: res.status, error: j && j.error ? j.error : 'failed to fetch icon' };
        } catch (e) {
          return { success: false, status: res.status, error: 'failed to fetch icon' };
        }
      }
      const blob = await res.blob();
      // читаем Blob как data URL
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => { reader.abort(); reject(new Error("Failed to read blob")); };
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
      return { success: true, dataUrl };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },

  /**
   * Альтернатива: получить raw Blob (например, для дальнейшей обработки).
   * Возвращает { success: true, blob } или { success:false, error }.
   */
  fetchIconBlob: async (userId, token) => {
    if (!userId && userId !== 0) return { success: false, error: 'userId required' };
    if (!token) return { success: false, error: 'token required for fetchIconBlob' };
    try {
      const res = await fetchWithAuth(`${API_BASE}/user/icon/${encodeURIComponent(userId)}`, { method: 'GET' }, token);
      if (!res.ok) {
        try {
          const j = await res.json();
          return { success: false, status: res.status, error: j && j.error ? j.error : 'failed to fetch icon' };
        } catch (e) {
          return { success: false, status: res.status, error: 'failed to fetch icon' };
        }
      }
      const blob = await res.blob();
      return { success: true, blob };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }
});

// Bridge для уведомлений main-процессу (как было)
contextBridge.exposeInMainWorld('bridge', {
  authenticated: (token) => {
    try { ipcRenderer.send('auth:authenticated', token); } catch (e) { console.error(e); }
  },
  logoutNotify: () => {
    try { ipcRenderer.send('auth:logout'); } catch (e) { console.error(e); }
  },
});
