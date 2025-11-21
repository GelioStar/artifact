// settings/renderer.js
const { ipcRenderer } = window.require ? window.require('electron') : { ipcRenderer: null };

async function applyTheme(color) {
    if (!color) return;
    document.documentElement.style.setProperty('--primary-color', color);
}

// Save theme to local settings DB via a fetch to renderer script that writes to settings.db
async function saveTheme(color) {
    // persist in a local settings DB through a small renderer-side API (if app uses preload, adapt)
    // We'll use localStorage as a fallback and also call a preload IPC if available.
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
