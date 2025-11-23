document.addEventListener('DOMContentLoaded', () => {
  const guest = document.getElementById('guest'); // <webview id="guest">
  if (!guest) {
    console.error('webview #guest not found');
    return;
  }

  // Перехват попыток открытия нового окна из содержимого webview
  guest.addEventListener('new-window', (e) => {
    e.preventDefault();
    try {
      guest.loadURL(e.url);
    } catch (err) {
      guest.src = e.url;
    }
  });

  // Делегирование кликов по ссылкам в сайдбаре
  document.addEventListener('click', (ev) => {
    const a = ev.target.closest && ev.target.closest('a');
    if (!a) return;

    const href = a.getAttribute('href');
    if (!href || href === '#' || href.startsWith('mailto:') || href.startsWith('tel:')) {
      return;
    }

    const isHtml = /\.html?$/i.test(href);

    if (isHtml) {
      ev.preventDefault();
      const normalized = href.replace(/\\\\/g, '/').replace(/\\/g, '/');
      let resolved;
      try {
        resolved = new URL(normalized, location.href).href;
      } catch (err) {
        resolved = normalized;
      }
      try {
        guest.loadURL(resolved);
      } catch (err) {
        guest.src = resolved;
      }
      document.querySelectorAll('.nav-list a').forEach(x => x.classList && x.classList.remove('active'));
      a.classList && a.classList.add('active');
      return;
    }
  });

  // --- i18n: когда webview сигнализирует готовность, шлём текущие переводы ---
  guest.addEventListener('ipc-message', async (e) => {
    if (e.channel === 'guest-ready') {
      try {
        // получаем текущую локаль и json через preload API
        if (window.i18n && window.i18n.getCurrent && window.i18n.load) {
          const cur = await window.i18n.getCurrent();
          const res = await window.i18n.load(cur);
          if (res && res.ok) {
            guest.send('i18n:update', { locale: res.locale || cur, data: res.data });
          }
        }
      } catch (err) {
        console.error('Failed to send i18n to webview', err);
      }
    }
  });

  // optional: listen for global i18n updates (main -> host)
  if (window.i18n && window.i18n.onUpdate) {
    window.i18n.onUpdate((payload) => {
      // payload: { locale, data }
      try {
        // forward to webview(s)
        document.querySelectorAll('webview').forEach(wv => {
          try { wv.send('i18n:update', payload); } catch (e) {}
        });
        // apply to host UI if you have data-i18n attrs (example handler)
        applyTranslationsToHost(payload.data);
      } catch (e) { console.error(e); }
    });
  }

  // Example simple apply -> host DOM helper (keeps minimal: only data-i18n textContent)
  function resolveKey(translations, key) {
    return key.split('.').reduce((o, k) => (o && o[k] !== undefined) ? o[k] : null, translations);
  }
  function applyTranslationsToHost(translations = {}) {
    try {
      document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        const raw = resolveKey(translations, key);
        if (raw !== null && raw !== undefined) el.textContent = raw;
      });
    } catch (e) { /* ignore */ }
  }

  // initial send: in case webview is already dom-ready
  try {
    if (guest.getWebContents && guest.getWebContents().isLoadingMainFrame() === false) {
      // will be caught by ipc-message('guest-ready') normally
    }
  } catch (e) {}

});

// -----------------------------
// НЕВЫЗЫВАЕМАЯ функция переключения локали (готова к использованию)
// -----------------------------
// она циклически переключает между доступными локалями.
// функция НЕ ВЫЗЫВАЕТСЯ нигде — готова для будущего использования.
// usage (future): window.cycleLocale();
window.cycleLocale = async function cycleLocale() {
  try {
    if (!window.i18n || !window.i18n.available || !window.i18n.getCurrent || !window.i18n.setCurrent) {
      console.warn('i18n API not available');
      return { ok: false, error: 'i18n-not-available' };
    }
    const locales = await window.i18n.available();
    if (!locales || !locales.length) return { ok: false, error: 'no-locales' };

    const curRes = await window.i18n.getCurrent();
    const cur = (typeof curRes === 'string') ? curRes : (curRes && curRes.locale) ? curRes.locale : curRes;
    let idx = locales.indexOf(cur);
    if (idx === -1) idx = 0;
    const next = locales[(idx + 1) % locales.length];
    const setRes = await window.i18n.setCurrent(next);
    // setRes will broadcast 'i18n:update' to all windows/webviews via main process
    return setRes;
  } catch (err) {
    console.error('cycleLocale error', err);
    return { ok: false, error: String(err) };
  }
};

const webview = document.getElementById('guest');
webview.addEventListener('dom-ready', () => {
  webview.openDevTools();
});

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