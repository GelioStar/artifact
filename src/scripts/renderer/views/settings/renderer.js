// settings/renderer.js — обновлён, интеграция с main avatar cache (avatar.forceRefresh / avatar.clear)
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
    const token = await getAuthToken();
    await fetch('/api/settings/theme', {
      method: 'POST',
      headers: {'Content-Type':'application/json', ...(token ? {'Authorization': `Bearer ${token}`} : {})},
      body: JSON.stringify({theme_color: color})
    });
  } catch (e) { /* ignore network errors */ }
}

// -------------------- helper: token retrieval --------------------
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

// -------------------- Change password handler --------------------
async function handleChangePassword() {
  const oldP = $('oldPassword').value;
  const newP = $('newPassword').value;
  const resEl = $('changePasswordResult'); resEl.textContent = '';
  if (!oldP || !newP) { resEl.textContent = 'Заполните оба поля.'; return; }
  const token = await getAuthToken();

  try {
    let result = null;
    // Prefer preload helper
    if (window.auth && typeof window.auth.changePassword === 'function') {
      result = await window.auth.changePassword(oldP, newP, token);
    } else {
      // fallback manual fetch
      const resp = await fetch('/api/change_password', {
        method: 'POST',
        headers: {'Content-Type':'application/json', ...(token ? {'Authorization': `Bearer ${token}`} : {})},
        body: JSON.stringify({ old_password: oldP, new_password: newP })
      });
      result = await resp.json().catch(()=>({ success: resp.ok }));
      if (resp.ok && result && result.success === undefined) result.success = true;
    }

    if (result && result.success) {
      resEl.textContent = result.message || 'Пароль изменён.';
      // Optionally: inform user to re-login or keep current session (we kept current session alive)
    } else {
      resEl.textContent = result && result.error ? result.error : 'Ошибка при изменении пароля.';
    }
  } catch (e) {
    console.error('change password error', e);
    resEl.textContent = 'Не удалось связаться с сервером.';
  }
}

// -------------------- Delete account handler --------------------
async function handleDeleteAccount() {
  const confirmed = $('confirmDelete').checked;
  const resEl = $('deleteAccountResult'); resEl.textContent = '';
  if (!confirmed) { resEl.textContent = 'Подтвердите удаление.'; return; }

  // Optionally, ask for password confirmation in UI — currently optional
  const passwordInput = $('deletePassword'); // if you add it to DOM, retrieve it; otherwise undefined
  const pw = passwordInput ? passwordInput.value : null;

  if (!confirm('Вы уверены, что хотите удалить аккаунт? Это действие необратимо.')) return;

  const token = await getAuthToken();
  try {
    let result = null;
    if (window.auth && typeof window.auth.deleteAccount === 'function') {
      result = await window.auth.deleteAccount(pw, token);
    } else {
      const resp = await fetch('/api/delete_account', {
        method: 'POST',
        headers: {'Content-Type':'application/json', ...(token ? {'Authorization': `Bearer ${token}`} : {})},
        body: JSON.stringify(pw ? { password: pw } : {})
      });
      result = await resp.json().catch(()=>({ success: resp.ok }));
      if (resp.ok && result && result.success === undefined) result.success = true;
    }

    if (result && result.success) {
      resEl.textContent = result.message || 'Аккаунт удалён.';
      // Clear client session and notify main to go to auth window
      try { localStorage.removeItem('sessionToken'); } catch (e) {}
      try { if (window.bridge && typeof window.bridge.logoutNotify === 'function') await window.bridge.logoutNotify(); } catch (e) {}
      // Optionally reload app or navigate to login
    } else {
      resEl.textContent = result && result.error ? result.error : 'Ошибка при удалении аккаунта.';
    }
  } catch (e) {
    console.error('delete account error', e);
    resEl.textContent = 'Не удалось связаться с сервером.';
  }
}

// -------------------- AVATAR helpers (оставляем ваши реализации) --------------------
const DEFAULT_AVATAR = '../../../../img/asideBar/profile.jpg';
const PROFILE_IMG_ID = 'profileImg';

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

async function fetchAvatarDataUrl(userId, token) {
  if (!userId) return { ok: false, error: 'no-user' };
  if (window.profile && typeof window.profile.fetchIconDataUrl === 'function' && token) {
    try {
      const r = await window.profile.fetchIconDataUrl(userId, token);
      return r;
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }
  try {
    const publicUrl = (window.profile && typeof window.profile.getIconUrl === 'function')
      ? window.profile.getIconUrl(userId, token)
      : `/api/user/icon/${encodeURIComponent(userId)}` + (token ? `?token=${encodeURIComponent(token)}` : '');
    return { success: true, dataUrl: publicUrl };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

async function handleUpload(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  const img = document.getElementById(PROFILE_IMG_ID);
  if (!file.type.startsWith('image/')) { alert('Выберите изображение.'); ev.target.value = ''; return; }
  const MAX_BYTES = 2 * 1024 * 1024;
  if (file.size > MAX_BYTES) { alert('Файл слишком большой — максимум 2 МБ.'); ev.target.value = ''; return; }

  const previewUrl = URL.createObjectURL(file);
  setLocalAvatarSrc(previewUrl);

  const token = await getAuthToken();
  let uploadRes = null;
  try {
    if (window.profile && typeof window.profile.uploadIcon === 'function') {
      uploadRes = await window.profile.uploadIcon(file, token);
    } else {
      const form = new FormData(); form.append('file', file);
      const resp = await fetch('/api/user/icon', { method: 'POST', headers: token ? { 'Authorization': `Bearer ${token}` } : {}, body: form });
      uploadRes = await resp.json().catch(()=>({ success: resp.ok }));
      if (resp.ok) uploadRes.success = true;
    }
  } catch (e) {
    console.error('upload error', e);
    uploadRes = { success: false, error: String(e) };
  } finally {
    setTimeout(() => { try { URL.revokeObjectURL(previewUrl); } catch (e){} }, 1500);
  }

  if (!uploadRes || !uploadRes.success) {
    alert('Ошибка при загрузке: ' + (uploadRes && uploadRes.error ? uploadRes.error : 'unknown'));
    ev.target.value = '';
    return;
  }

  const userId = window.currentUser && window.currentUser.id;
  try {
    if (window.avatar && typeof window.avatar.forceRefresh === 'function' && userId) {
      const fr = await window.avatar.forceRefresh(userId, token);
      if (fr && fr.ok && fr.dataUrl) {
        setLocalAvatarSrc(fr.dataUrl);
      } else {
        const fetched = await fetchAvatarDataUrl(userId, token);
        if (fetched && fetched.success && fetched.dataUrl) setLocalAvatarSrc(fetched.dataUrl);
        else setLocalAvatarSrc(DEFAULT_AVATAR);
      }
    } else {
      const fetched = await fetchAvatarDataUrl(userId, token);
      if (fetched && fetched.success && fetched.dataUrl) setLocalAvatarSrc(fetched.dataUrl);
      else setLocalAvatarSrc(DEFAULT_AVATAR);
    }
  } catch (e) {
    console.warn('After upload: refresh/cache update failed', e);
    const imgEl = document.getElementById(PROFILE_IMG_ID);
    if (imgEl && imgEl.src) imgEl.src = imgEl.src.split('?')[0] + '?t=' + Date.now();
  } finally {
    ev.target.value = '';
    alert('Фото загружено.');
  }
}

async function handleRemove() {
  if (!confirm('Удалить фотографию профиля?')) return;
  const token = await getAuthToken();
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

async function initSettingsView() {
  const colorInput = $('themeColor');
  const saveBtn = $('saveThemeBtn');
  const stored = localStorage.getItem('app-theme-color') || getComputedStyle(document.documentElement).getPropertyValue('--primary-color').trim() || '#3b82f6';
  if (colorInput) colorInput.value = stored;
  await applyTheme(stored);
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    const color = colorInput.value;
    await saveTheme(color);
    alert('Тема сохранена.');
  });

  const changeBtn = $('changePasswordBtn');
  if (changeBtn) changeBtn.addEventListener('click', handleChangePassword);

  const deleteBtn = $('deleteAccountBtn');
  if (deleteBtn) deleteBtn.addEventListener('click', handleDeleteAccount);
}

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

async function initAvatarInitialLoad() {
  const img = document.getElementById(PROFILE_IMG_ID);
  if (!img) return;
  const userId = window.currentUser && window.currentUser.id;
  if (!userId) {
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
        setLocalAvatarSrc(av.dataUrl);
        return;
      }
    } catch (e) {
      console.warn('avatar.get failed', e);
    }
  }

  const fetched = await fetchAvatarDataUrl(finalUserId, token);
  if (fetched && fetched.success && fetched.dataUrl) {
    setLocalAvatarSrc(fetched.dataUrl);
  } else {
    setLocalAvatarSrc(DEFAULT_AVATAR);
  }
}

function subscribeAvatarBroadcasts() {
  if (window.avatar && typeof window.avatar.onChanged === 'function') {
    window.avatar.onChanged((payload) => {
      try {
        const curUserId = window.currentUser && window.currentUser.id;
        if (!payload) return;
        if (payload.userId && curUserId && String(payload.userId) !== String(curUserId)) return;
        if (payload.dataUrl) {
          setLocalAvatarSrc(payload.dataUrl);
        } else if (payload.deleted) {
          setLocalAvatarSrc(DEFAULT_AVATAR);
        }
      } catch (e) { console.error('avatar.onChanged handler error', e); }
    });
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  initSettingsView().catch(e => console.error('initSettingsView error', e));
  wireControls();
  await initAvatarInitialLoad();
  subscribeAvatarBroadcasts();
});
