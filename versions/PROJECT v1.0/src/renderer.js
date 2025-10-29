document.addEventListener('DOMContentLoaded', () => {
  const guest = document.getElementById('guest'); // <webview id="guest">
  if (!guest) {
    console.error('webview #guest not found');
    return;
  }

  // Перехват попыток открытия нового окна из содержимого webview
  // (например, ссылки с target="_blank" или window.open)
  guest.addEventListener('new-window', (e) => {
    e.preventDefault();
    try {
      // загрузим URL прямо в тот же webview
      guest.loadURL(e.url);
    } catch (err) {
      // fallback: установить src
      guest.src = e.url;
    }
  });

  // Делегирование кликов по ссылкам в сайдбаре — если ссылка ведёт на .html,
  // загружаем её в webview, не трогаем главное окно.
  document.addEventListener('click', (ev) => {
    const a = ev.target.closest && ev.target.closest('a');
    if (!a) return;

    // Игнорируем ссылки якоря или ссылки без href
    const href = a.getAttribute('href');
    if (!href || href === '#' || href.startsWith('mailto:') || href.startsWith('tel:')) {
      return;
    }

    // Обычная цель: локальный html-файл (напр. "./scripts/.../training.html")
    // — проверяем по расширению .html (регистронезависимо)
    const isHtml = /\.html?$/i.test(href);

    if (isHtml) {
      ev.preventDefault(); // предотвращаем навигацию host-страницы

      // Нормализуем обратные слеши в путь (если используются Windows-style пути)
      const normalized = href.replace(/\\\\/g, '/').replace(/\\/g, '/');
      // Преобразуем относительный путь в абсолютный URL относительно текущего index.html.
      // location.href у тебя будет что-то вроде file:///.../index.html
      let resolved;
      try {
        resolved = new URL(normalized, location.href).href;
      } catch (err) {
        // На случай, если new URL не сработал — попробуем просто указать normalized
        resolved = normalized;
      }
      // Загружаем в webview
      try {
        guest.loadURL(resolved);
      } catch (err) {
        // Если loadURL недоступен по каким-то причинам, можно присвоить src
        guest.src = resolved;
      }
      // (опционально) обновить UI: пометить активную ссылку
      document.querySelectorAll('.nav-list a').forEach(x => x.classList && x.classList.remove('active'));
      a.classList && a.classList.add('active');
      return;
    }

    // Если не .html — ничего не делаем (позволим обычное поведение)
  });
});
