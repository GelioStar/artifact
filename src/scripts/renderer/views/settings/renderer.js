// settings/renderer.js
const { ipcRenderer } = window.require ? window.require('electron') : { ipcRenderer: null };

async function applyTheme(color) {
    if (!color) return;
    document.documentElement.style.setProperty('--primary-color', color);
}

// Save theme to local settings DB via a fetch to renderer script that writes to settings.db
async function saveTheme(color) {
    localStorage.setItem('app-theme-color', color);
    await applyTheme(color);
    // notify main/preload if available
    try {
        if (ipcRenderer && ipcRenderer.invoke) {
            await ipcRenderer.invoke('settings:set', { key: 'theme_color', value: color });
        }
    } catch (e) {
        console.warn('IPC not available to persist settings:', e);
    }
    // also attempt to save via a small REST endpoint if available
    try {
        await fetch('/api/settings/theme', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({theme_color: color})
        });
    } catch (e) {
        // ignore network errors; server persistence is optional
    }
}

async function initSettingsView() {
    const colorInput = document.getElementById('themeColor');
    const saveBtn = document.getElementById('saveThemeBtn');
    const stored = localStorage.getItem('app-theme-color') || getComputedStyle(document.documentElement).getPropertyValue('--primary-color').trim() || '#3b82f6';
    colorInput.value = stored;
    await applyTheme(stored);

    saveBtn.addEventListener('click', async () => {
        const color = colorInput.value;
        await saveTheme(color);
        alert('Тема сохранена.');
    });

    // Change password
    document.getElementById('changePasswordBtn').addEventListener('click', async () => {
        const oldP = document.getElementById('oldPassword').value;
        const newP = document.getElementById('newPassword').value;
        const resEl = document.getElementById('changePasswordResult');
        resEl.textContent = '';
        try {
            const r = await fetch('/api/change_password', {
                method: 'POST',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ old_password: oldP, new_password: newP })
            });
            const j = await r.json();
            if (r.ok) {
                resEl.textContent = j.message || 'Пароль изменён.';
            } else {
                resEl.textContent = j.error || 'Ошибка при изменении пароля.';
            }
        } catch (e) {
            resEl.textContent = 'Не удалось связаться с сервером.';
        }
    });

    // Delete account
    document.getElementById('deleteAccountBtn').addEventListener('click', async () => {
        const confirm = document.getElementById('confirmDelete').checked;
        const resEl = document.getElementById('deleteAccountResult');
        resEl.textContent = '';
        if (!confirm || !confirm === true) {
            resEl.textContent = 'Подтвердите удаление.';
            return;
        }
        try {
            const r = await fetch('/api/delete_account', { method: 'POST' });
            const j = await r.json();
            if (r.ok) {
                resEl.textContent = j.message || 'Аккаунт удалён.';
                // optional: redirect to login
            } else {
                resEl.textContent = j.error || 'Ошибка при удалении аккаунта.';
            }
        } catch (e) {
            resEl.textContent = 'Не удалось связаться с сервером.';
        }
    });
}

document.addEventListener('DOMContentLoaded', initSettingsView);

(async function(){
  const img = document.getElementById('profileImg');
  const defaultSrc = img.src;

  // Подставьте источник userId/token как в вашем приложении
  const userId = window.currentUser && window.currentUser.id; // пример
  const token = localStorage.getItem('sessionToken'); // пример

  if (!userId) return;

  // Если есть helper в preload (window.profile.fetchIconDataUrl) — пользуемся им.
  if (window.profile && typeof window.profile.fetchIconDataUrl === 'function' && token) {
    img.classList.add('loading');
    try {
      const res = await window.profile.fetchIconDataUrl(userId, token);
      if (res && res.success && res.dataUrl) {
        img.src = res.dataUrl;
      } else {
        // если сервер вернул ошибку — ставим дефолт
        console.warn('fetchIconDataUrl failed', res);
        img.src = defaultSrc;
      }
    } catch (err) {
      console.error('Error fetching icon via profile.fetchIconDataUrl:', err);
      img.src = defaultSrc;
    } finally {
      img.classList.remove('loading');
    }
    return;
  }

  // Если нет топ-уровневого helper'а, делаем fetch вручную с Authorization header:
  if (token) {
    img.classList.add('loading');
    try {
      const resp = await fetch(`/api/user/icon/${encodeURIComponent(userId)}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      if (!resp.ok) {
        console.warn('Avatar fetch returned not ok:', resp.status);
        img.src = defaultSrc;
        return;
      }
      const blob = await resp.blob();
      // blob -> data URL
      const reader = new FileReader();
      const dataUrl = await new Promise((resolve, reject) => {
        reader.onerror = () => { reader.abort(); reject(new Error('Failed to read blob')); };
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
      img.src = dataUrl;
    } catch (err) {
      console.error('Error fetching avatar with Authorization header:', err);
      img.src = defaultSrc;
    } finally {
      img.classList.remove('loading');
    }
    return;
  }

  // Последняя попытка: если нет токена — попробуем публичный URL (если доступен)
  try {
    const publicUrl = (window.profile && typeof window.profile.getIconUrl === 'function')
      ? window.profile.getIconUrl(userId, null)
      : `/api/user/icon/${encodeURIComponent(userId)}`;
    img.onerror = () => { img.onerror = null; img.src = defaultSrc; };
    img.src = publicUrl;
  } catch (err) {
    console.error('Fallback public avatar load error:', err);
    img.src = defaultSrc;
  }
})();