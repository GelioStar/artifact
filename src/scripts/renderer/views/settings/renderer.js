// settings/renderer.js — обновлён, интеграция с main avatar cache (avatar.forceRefresh / avatar.clear)
// Предположения: в preload.js выставлены window.profile, window.session и window.avatar (описаны ранее).

const $ = id => document.getElementById(id);

const uploadPhoto = $('uploadPhoto');
const removePhotoBtn = $('removePhoto');
const exitAccountBtn = $('exitAccount');

async function applyTheme(color) {
  if (!color) return;
  document.documentElement.style.setProperty('--primary-color', color);
}

async function saveTheme(color) {
  localStorage.setItem('app-theme-color', color);
  await applyTheme(color);
  try {
    if (window.ipcRenderer && window.ipcRenderer.invoke) {
      await window.ipcRenderer.invoke('settings:set', { key: 'theme_color', value: color });
    } else if (window.electronAPI && window.electronAPI.settingsSet) {
      await window.electronAPI.settingsSet({ key: 'theme_color', value: color });
    }
  } catch (e) { console.warn('IPC not available to persist settings:', e); }
  try {
    await fetch('/api/settings/theme', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({theme_color: color})
    });
  } catch (e) { /* ignore network errors */ }
}

async function initSettingsView() {
  // Theme UI
  const colorInput = $('themeColor');
  const saveBtn = $('saveThemeBtn');
  const stored = localStorage.getItem('app-theme-color') || getComputedStyle(document.documentElement).getPropertyValue('--primary-color').trim() || '#3b82f6';
  colorInput.value = stored;
  await applyTheme(stored);
  saveBtn.addEventListener('click', async () => {
    const color = colorInput.value;
    await saveTheme(color);
    alert('Тема сохранена.');
  });

  // change password (existing)
  $('changePasswordBtn').addEventListener('click', async () => {
    const oldP = $('oldPassword').value;
    const newP = $('newPassword').value;
    const resEl = $('changePasswordResult'); resEl.textContent = '';
    try {
      const r = await fetch('/api/change_password', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ old_password: oldP, new_password: newP })
      });
      const j = await r.json();
      resEl.textContent = r.ok ? (j.message || 'Пароль изменён.') : (j.error || 'Ошибка при изменении пароля.');
    } catch (e) {
      resEl.textContent = 'Не удалось связаться с сервером.';
    }
  });

  // delete account (existing)
  $('deleteAccountBtn').addEventListener('click', async () => {
    const confirm = $('confirmDelete').checked;
    const resEl = $('deleteAccountResult'); resEl.textContent = '';
    if (!confirm) { resEl.textContent = 'Подтвердите удаление.'; return; }
    try {
      const r = await fetch('/api/delete_account', { method: 'POST' });
      const j = await r.json();
      resEl.textContent = r.ok ? (j.message || 'Аккаунт удалён.') : (j.error || 'Ошибка при удалении аккаунта.');
    } catch (e) {
      resEl.textContent = 'Не удалось связаться с сервером.';
    }
  });

  // upload/remove handlers wired below
}

// -------------------- AVATAR helpers --------------------

const DEFAULT_AVATAR = '../../../../img/asideBar/profile.jpg';
const PROFILE_IMG_ID = 'profileImg';

// Получаем токен: сначала main session (безопаснее), затем localStorage
async function getAuthToken() {
  try {
    if (window.session && typeof window.session.get === 'function') {
      const s = await window.session.get();
      if (s && s.ok !== false && s.token) return s.token;
    }
  } catch (e) {
    console.warn('session.get failed', e);
  }
  return localStorage.getItem('sessionToken') || null;
}

// Установить src для локального <img> с защитой onerror
function setLocalAvatarSrc(src) {
  const img = document.getElementById(PROFILE_IMG_ID);
  if (!img) return;
  if (!src) {
    img.onerror = null;
    img.src = DEFAULT_AVATAR;
    return;
  }
  img.onerror = () => { img.onerror = null; img.src = DEFAULT_AVATAR; };
  img.src = src;
}

// Попытаться получить dataUrl от сервера (через helper preload) или публичный URL
async function fetchAvatarDataUrl(userId, token) {
  if (!userId) return { ok: false, error: 'no-user' };
  // Prefer preload helper which returns dataUrl
  if (window.profile && typeof window.profile.fetchIconDataUrl === 'function' && token) {
    try {
      const r = await window.profile.fetchIconDataUrl(userId, token);
      return r; // { success: true, dataUrl } или { success:false, error:... }
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }
  // Fallback: try public URL (we will not fetch binary here often — main caching should handle frequent loads)
  try {
    const publicUrl = (window.profile && typeof window.profile.getIconUrl === 'function')
      ? window.profile.getIconUrl(userId, token)
      : `/api/user/icon/${encodeURIComponent(userId)}` + (token ? `?token=${encodeURIComponent(token)}` : '');
    return { success: true, dataUrl: publicUrl }; // note: dataUrl may be an URL, not data:...
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

// -------------------- upload handler: показывает мгновенную превью, загружает, обновляет кеш main --------------------
async function handleUpload(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  const img = document.getElementById(PROFILE_IMG_ID);
  // validate
  if (!file.type.startsWith('image/')) { alert('Выберите изображение.'); ev.target.value = ''; return; }
  const MAX_BYTES = 2 * 1024 * 1024;
  if (file.size > MAX_BYTES) { alert('Файл слишком большой — максимум 2 МБ.'); ev.target.value = ''; return; }

  // instant preview via object URL
  const previewUrl = URL.createObjectURL(file);
  setLocalAvatarSrc(previewUrl);

  // upload via preload helper
  const token = await getAuthToken();
  let uploadRes = null;
  try {
    if (window.profile && typeof window.profile.uploadIcon === 'function') {
      uploadRes = await window.profile.uploadIcon(file, token);
    } else {
      // fallback manual fetch (multipart)
      const form = new FormData(); form.append('file', file);
      const resp = await fetch('/api/user/icon', { method: 'POST', headers: token ? { 'Authorization': `Bearer ${token}` } : {}, body: form });
      // try to parse JSON but don't fail if server returns empty
      uploadRes = await resp.json().catch(()=>({ success: resp.ok }));
      if (resp.ok) uploadRes.success = true;
    }
  } catch (e) {
    console.error('upload error', e);
    uploadRes = { success: false, error: String(e) };
  } finally {
    // revoke preview after a short delay so browser can render it
    setTimeout(() => { try { URL.revokeObjectURL(previewUrl); } catch (e){} }, 1500);
  }

  if (!uploadRes || !uploadRes.success) {
    alert('Ошибка при загрузке: ' + (uploadRes && uploadRes.error ? uploadRes.error : 'unknown'));
    ev.target.value = '';
    // optionally restore previous avatar by forcing a refresh from main (below)
    return;
  }

  // Успешно загрузили на сервер — теперь:
  // 1) попросим main скачать свежий blob и обновить кеш (avatar.forceRefresh)
  // 2) если main вернул dataUrl — сразу установим его; иначе — попытаемся отдельно получить dataUrl и установить
  const userId = window.currentUser && window.currentUser.id;
  try {
    if (window.avatar && typeof window.avatar.forceRefresh === 'function' && userId) {
      const fr = await window.avatar.forceRefresh(userId, token);
      if (fr && fr.ok && fr.dataUrl) {
        setLocalAvatarSrc(fr.dataUrl);
      } else if (fr && fr.notFound) {
        setLocalAvatarSrc(DEFAULT_AVATAR);
      } else {
        // if forceRefresh failed - try fetching via preload helper
        const fetched = await fetchAvatarDataUrl(userId, token);
        if (fetched && fetched.success && fetched.dataUrl) setLocalAvatarSrc(fetched.dataUrl);
        else setLocalAvatarSrc(DEFAULT_AVATAR);
      }
    } else {
      // no avatar API in preload: try to fetch dataUrl directly via preload or public url
      const fetched = await fetchAvatarDataUrl(userId, token);
      if (fetched && fetched.success && fetched.dataUrl) setLocalAvatarSrc(fetched.dataUrl);
      else setLocalAvatarSrc(DEFAULT_AVATAR);
    }
  } catch (e) {
    console.warn('After upload: refresh/cache update failed', e);
    // Last fallback: force cache-busting URL
    const imgEl = document.getElementById(PROFILE_IMG_ID);
    if (imgEl && imgEl.src) imgEl.src = imgEl.src.split('?')[0] + '?t=' + Date.now();
  } finally {
    ev.target.value = '';
    alert('Фото загружено.');
  }
}

// -------------------- delete handler: удаляем на сервер и сбрасываем кеш в main --------------------
async function handleRemove() {
  if (!confirm('Удалить фотографию профиля?')) return;
  const token = await getAuthToken();
  // delete via preload helper
  let delRes = null;
  try {
    if (window.profile && typeof window.profile.deleteIcon === 'function') {
      delRes = await window.profile.deleteIcon(token);
    } else {
      const resp = await fetch('/api/user/icon', { method: 'DELETE', headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
      delRes = await resp.json().catch(()=>({ success: resp.ok }));
      if (resp.ok) delRes.success = true;
    }
  } catch (e) {
    console.error('delete error', e);
    delRes = { success: false, error: String(e) };
  }

  if (!delRes || !delRes.success) {
    alert('Не удалось удалить фото: ' + (delRes && delRes.error ? delRes.error : 'unknown'));
    return;
  }

  // tell main to clear cache and broadcast deletion
  const userId = window.currentUser && window.currentUser.id;
  try {
    if (userId && window.avatar && typeof window.avatar.clear === 'function') {
      await window.avatar.clear(userId);
    }
  } catch (e) {
    console.warn('avatar.clear failed', e);
  }

  setLocalAvatarSrc(DEFAULT_AVATAR);
  alert('Фото удалено.');
}

// -------------------- Initialization and wiring --------------------

async function initAvatarInitialLoad() {
  const img = document.getElementById(PROFILE_IMG_ID);
  if (!img) return;
  const userId = window.currentUser && window.currentUser.id;
  if (!userId) {
    // If no currentUser: try to recover once via token
    const token = await getAuthToken();
    if (token && window.auth && typeof window.auth.getUser === 'function') {
      try {
        const ru = await window.auth.getUser(token);
        if (ru && ru.success && ru.user) {
          window.currentUser = ru.user;
        }
      } catch (e) { /* ignore */ }
    }
  }

  const finalUserId = window.currentUser && window.currentUser.id;
  const token = await getAuthToken();

  // Try to load using main's avatar cache if available
  if (finalUserId && window.avatar && typeof window.avatar.get === 'function') {
    try {
      const av = await window.avatar.get(finalUserId);
      if (av && av.ok && av.dataUrl) {
        setLocalAvatarSrc(av.dataUrl);
        return;
      } else if (av && av.notFound) {
        setLocalAvatarSrc(DEFAULT_AVATAR);
        return;
      } else if (av && av.dataUrl) {
        // sometimes returns non-ok but has dataUrl (use it)
        setLocalAvatarSrc(av.dataUrl);
        return;
      }
    } catch (e) {
      console.warn('avatar.get failed', e);
    }
  }

  // fallback: fetch via preload helper or public url
  const fetched = await fetchAvatarDataUrl(finalUserId, token);
  if (fetched && fetched.success && fetched.dataUrl) {
    setLocalAvatarSrc(fetched.dataUrl);
  } else {
    setLocalAvatarSrc(DEFAULT_AVATAR);
  }
}

// Subscribe to broadcasts (main-вызовы при обновлении кеша)
function subscribeAvatarBroadcasts() {
  if (window.avatar && typeof window.avatar.onChanged === 'function') {
    // callback(payload) where payload: { userId, dataUrl, deleted }
    window.avatar.onChanged((payload) => {
      try {
        const curUserId = window.currentUser && window.currentUser.id;
        if (!payload) return;
        if (payload.userId && curUserId && String(payload.userId) !== String(curUserId)) return; // different user
        if (payload.dataUrl) {
          setLocalAvatarSrc(payload.dataUrl);
        } else if (payload.deleted) {
          setLocalAvatarSrc(DEFAULT_AVATAR);
        }
      } catch (e) { console.error('avatar.onChanged handler error', e); }
    });
  } else {
    // if avatar.onChanged not available, nothing to subscribe to
  }
}

// Wire upload/remove/exit UI
function wireControls() {
  if (uploadPhoto) uploadPhoto.addEventListener('change', handleUpload);
  if (removePhotoBtn) removePhotoBtn.addEventListener('click', handleRemove);
  if (exitAccountBtn) {
    exitAccountBtn.addEventListener('click', async () => {
      try {
        const token = await getAuthToken();
        try { await window.auth.logout(token); } catch (e) {}
        localStorage.removeItem('sessionToken');
        if (window.bridge && typeof window.bridge.logoutNotify === 'function') {
          await window.bridge.logoutNotify();
        } else if (window.session && typeof window.session.clear === 'function') {
          await window.session.clear();
        }
      } catch (e) { console.error(e); }
    });
  }
}

// -------------------- Run init --------------------
document.addEventListener('DOMContentLoaded', async () => {
  initSettingsView().catch(e => console.error('initSettingsView error', e));
  wireControls();
  await initAvatarInitialLoad();
  subscribeAvatarBroadcasts();
});
