// *******************************
// H O L D   H I G H L I G H T
// highlight on press, remove on release
// *******************************

// Ждём события 'DOMContentLoaded' — это означает, что HTML документ загружен и DOM построен,
// но внешние ресурсы (картинки, шрифты) могут ещё грузиться.
// Это безопасное место, чтобы получить элементы страницы и навесить обработчики.
window.addEventListener('DOMContentLoaded', () => {
  // querySelectorAll возвращает NodeList всех элементов, соответствующих селектору '.key-btn'.
  // Array.from превращает NodeList в обычный массив, чтобы можно было использовать forEach и другие методы массива.
  // Здесь мы предполагаем, что кнопки-клавиши помечены классом .key-btn.
  const buttons = Array.from(document.querySelectorAll('.key-btn'));

  // Для каждой найденной кнопки:
  // Если у неё нет data-key в dataset (атрибут data-key), то подставим значение по тексту кнопки.
  // dataset — это объект, через который доступны все атрибуты вида data-*
  buttons.forEach(btn => {
    // btn.dataset.key — это shortcut к атрибуту data-key
    if (!btn.dataset.key) {
      // Получаем текстовое содержимое кнопки; trim убирает пробелы по краям.
      const text = (btn.textContent || '').trim();
      // Если текст — одиночный символ, положим его в data-key (в верхнем регистре).
      // Это удобно: многие клавиши подписаны одним символом, например "Q", "W".
      if (text.length === 1) btn.dataset.key = text.toUpperCase();
      // Примечание: запись в btn.dataset.key автоматически ставит атрибут data-key в DOM.
    }
  });

  // -------------------------
  // Utility: safe CSS.escape fallback
  // -------------------------
  // CSS.escape — стандартный метод (окружённый объектом CSS) для экранирования строк в селекторах CSS.
  // Например, если код клавиши содержит пробел или спецсимвол, его нужно экранировать.
  // Но не во всех браузерах CSS.escape доступен, поэтому делаем безопасный fallback.
  const esc = (s) => {
    // Проверяем, что существует глобальный объект CSS и у него функция escape
    if (window.CSS && CSS.escape) return CSS.escape(s);
    // Если нет — применяем регулярное выражение для экранирования большинства специальных символов в селекторах.
    // Регекс ищет символы, которые имеют специальное значение в CSS-селекторах и перед ними ставит обратный слэш.
    return String(s).replace(/([ #;?%&,.+*~':"!^${}()|\[\]\/\\])/g, '\\$1');
    // Объяснение регекса: [] — класс символов; внутри перечислены символы, которые нужно экранировать.
    // g — глобально, чтобы заменить все вхождения.
  };

  // -------------------------
  // pressedMap: хранит текущее состояние "удержания" клавиш
  // -------------------------
  // Используем Map — это встроенный класс ES6, позволяющий хранить пары ключ->значение.
  // Map лучше обычного объекта, когда ключи могут быть разными типами и нужна гарантия порядка вставки.
  // В нашем Map ключ — id удержания (строка), значение — объект { selectors, origin }.
  const pressedMap = new Map(); // id -> { selectors: [...], origin: 'keyboard'|'mouse'|'touch' }

  // -------------------------
  // Функция pressBySelectors — добавляет подсветку элементам, найденным по селекторам
  // -------------------------
  function pressBySelectors(id, selectors, origin = 'keyboard') {
    // Если уже есть запись с таким id — значит уже обработано, выходим.
    if (pressedMap.has(id)) return; // защитный случай — не дублируем подсветку

    // Кладём в Map информацию о том, какие селекторы были применены и откуда пришёл event (origin).
    pressedMap.set(id, { selectors, origin });

    // selectors — массив CSS-селекторов; для каждого селектора находим элементы и объединяем их в список.
    // flatMap + Array.from здесь — чтобы получить единый массив всех элементов по всем селекторам.
    const elems = selectors.flatMap(sel => Array.from(document.querySelectorAll(sel)));

    // Для каждого найденного элемента:
    elems.forEach(el => {
      // Используем свойство _activeCount на DOM-элементе (мы создаём его динамически).
      // Идея: если один и тот же элемент подсвечивается от нескольких клавиш одновременно,
      // нужно снять класс 'active' только тогда, когда все "заинтересованные" держатели освободили клавишу.
      if (!el._activeCount) el._activeCount = 0; // если не было — инициализируем нулём
      el._activeCount += 1; // увеличиваем счётчик
      el.classList.add('active'); // добавляем CSS-класс, который визуально подсвечивает элемент
      // classList — объект DOMTokenList, предоставляет удобные методы add/remove/toggle/contains.
    });
  }

  // -------------------------
  // Функция releaseById — снимает подсветку, уменьшает счётчик и удаляет класс при нуле
  // -------------------------
  function releaseById(id) {
    // Получаем информацию из Map по id
    const info = pressedMap.get(id);
    if (!info) return; // если нет информации — ничего делать не нужно

    // Удаляем запись из Map, потому что счётчик ухода обрабатываем вручную по элементам
    pressedMap.delete(id);

    // Собираем элементы по тем же селекторам, что были при нажатии
    const elems = info.selectors.flatMap(sel => Array.from(document.querySelectorAll(sel)));

    elems.forEach(el => {
      // Уменьшаем внутренний счётчик, но не опускаем ниже 0 (безопасность)
      el._activeCount = Math.max(0, (el._activeCount||0) - 1);
      // Когда счётчик стал равен 0 — снимаем визуальный класс 'active'
      if (el._activeCount === 0) el.classList.remove('active');
    });
  }

  // -------------------------
  // clearAll — снимает ВСЕ подсветки (например, при потере фокуса)
  // -------------------------
  function clearAll() {
    // Array.from(pressedMap.keys()) — итерируем все current id'ы, чтобы корректно вызвать releaseById
    for (const id of Array.from(pressedMap.keys())) {
      releaseById(id);
    }
  }

  // -------------------------
  // infoFromKeyEvent — преобразует KeyboardEvent в { id, selectors }
  // -------------------------
  function infoFromKeyEvent(e) {
    // e.code — физический код клавиши (например "KeyQ", "Digit1"), предпочтительнее для таких кейборд-ориентированных приложений.
    const code = e.code || null;            // физическая клавиша, предпочтительна
    // e.key — символ, который производит клавиша (например "q" или "Q" или "ArrowLeft"); берём символ только если длина 1
    const key = (e.key && e.key.length === 1) ? e.key.toUpperCase() : null; // символьная репрезентация
    // Если ни code, ни key — не годится (например, функциональная клавиша без символьного key), тогда возвращаем null.
    if (!code && !key) return null;

    // Формируем детерминированный id — либо по code, либо по key. Это нужно, чтобы при отпускании клавиши
    // можно было точно найти соответствующую запись в pressedMap.
    const id = code ? `code:${code}` : `key:${key}`;

    // Формируем CSS-селекторы для поиска .key-btn, которые помечены соответствующими data-атрибутами.
    const selectors = [];
    if (code) selectors.push(`.key-btn[data-code="${esc(code)}"]`); // ищем по data-code
    if (key)  selectors.push(`.key-btn[data-key="${esc(key)}"]`);   // ищем по data-key

    // Добавляем дополнительно селектор по текстовому атрибуту, если кнопка не имеет data-key,
    // но мы пометили её data-text ранее (см. ниже).
    if (key) selectors.push(`.key-btn:not([data-key])[data-text="${esc(key)}"]`);

    // Возвращаем объект с id и массивом селекторов
    return { id, selectors };
  }

  // -------------------------
  // Обработчики клавиатуры — keydown / keyup
  // -------------------------
  window.addEventListener('keydown', (e) => {
    // Здесь можно фильтровать системные комбинации. Пример:
    // Если нажаты metaKey (Command на mac) или altKey (Alt) — возможно, это системная комбинация.
    // Этот код оставлен как пример: при необходимости доработайте логику фильтрации.
    if (e.metaKey || (e.altKey && !e.ctrlKey)) {
      // Замечание: мы не делаем `return` — просто показываем место, где можно обрабатывать спец. модификаторы.
      // Если хотите полностью игнорировать такие event'ы, можно сделать `return`.
    }

    // Преобразуем событие клавиатуры в id/selectors
    const info = infoFromKeyEvent(e);
    if (!info) return; // если не смогли извлечь полезной информации — выход

    // Игнорируем повторные срабатывания keydown при удержании клавиши (auto-repeat),
    // потому что pressedMap уже пометит состояние при первом нажатии.
    if (pressedMap.has(info.id)) return;

    // Включаем подсветку элементов, соответствующих клавише
    pressBySelectors(info.id, info.selectors, 'keyboard');
  });

  // keyup — снятие подсветки
  window.addEventListener('keyup', (e) => {
    const info = infoFromKeyEvent(e);
    if (!info) return;
    releaseById(info.id);
  });

  // При уходе фокуса с окна — очищаем все подсветки, чтобы не "зависали" состояния
  window.addEventListener('blur', clearAll);

  // Также следим за visibilitychange — если вкладка перестаёт быть видимой, снимаем подсветки
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') clearAll();
  });

  // -------------------------
  // MOUSE / TOUCH: логика подсветки при удержании мыши/тача
  // -------------------------
  // Для каждого DOM-элемента-кнопки подключаем обработчики мыши и тача.
  buttons.forEach(btn => {
    // Если у кнопки нет data-key, добавим временный атрибут data-text со значением текста.
    // Это даёт нам способ искать кнопку по видимому символу в тексте.
    if (!btn.dataset.key) {
      const t = (btn.textContent || '').trim().toUpperCase();
      if (t) btn.setAttribute('data-text', t);
      // setAttribute записывает атрибут в DOM: <button data-text="Q">...</button>
    }

    // Переменная для хранения текущего id удержания на этой кнопке (чтобы можно было снять подсветку)
    let mouseId = null;

    // mousedown — нажатие левой кнопкой мыши
    btn.addEventListener('mousedown', (ev) => {
      ev.preventDefault(); // предотвращаем нежелательные побочные эффекты (например, выделение текста)
      const { id, selectors } = infoFromButton(btn); // функция infoFromButton ниже
      mouseId = id; // сохраняем id для будущего release
      pressBySelectors(id, selectors, 'mouse'); // подсвечиваем
    });

    // Функция-снятие подсветки для мыши
    const releaseMouse = () => {
      if (!mouseId) return;
      releaseById(mouseId);
      mouseId = null;
    };

    // Когда отпускается кнопка мыши над элементом — снимаем подсветку
    btn.addEventListener('mouseup', releaseMouse);
    // Если мышь уходит за пределы кнопки (mouseleave) — тоже снимаем (часто удобно UX-wise)
    btn.addEventListener('mouseleave', releaseMouse);

    // === TOUCH поддержка: для мобильных/тачевых устройств ===
    btn.addEventListener('touchstart', (ev) => {
      ev.preventDefault(); // предотвращаем скролл страницы при удержании
      const { id, selectors } = infoFromButton(btn);
      mouseId = id;
      pressBySelectors(id, selectors, 'touch');
    }, { passive: false }); // passive:false нужно, чтобы можно было вызвать preventDefault()

    // touchend — касание закончилось
    btn.addEventListener('touchend', releaseMouse);
    // touchcancel — система отменила касание (например, пришёл системный interrupt)
    btn.addEventListener('touchcancel', releaseMouse);
  });

  // -------------------------
  // Вспомогательная функция infoFromButton — формирует id и селекторы для DOM-кнопки
  // -------------------------
  function infoFromButton(btn) {
    // Предпочитаем data-code, затем data-key; если нет — создаём уникальный id на базе Math.random.
    const code = btn.dataset.code || null;
    const key = btn.dataset.key || null;
    const id = code ? `code:${code}` : key ? `key:${key}` : `el:${Math.random().toString(36).slice(2)}`;

    const selectors = [];
    if (code) selectors.push(`.key-btn[data-code="${esc(code)}"]`);
    if (key)  selectors.push(`.key-btn[data-key="${esc(key)}"]`);
    // Заметьте: если кнопке не присвоен data-key, мы ранее могли поставить data-text — но селектор по data-text используется выше в infoFromKeyEvent.
    return { id, selectors };
  }
}); // конец DOMContentLoaded обработчика



// -------------------------
// renderer.js — updateUIText (интернационализация / перевод)
// -------------------------
// Функция updateUIText обновляет текстовые подписи кнопок в UI, запрашивая переводы из main-process через bridge.
async function updateUIText() {
  // Находим все элементы с классом .key-btn (NodeList)
  const buttons = document.querySelectorAll('.key-btn');

  // Перебираем элементы в цикле for...of (поддерживается во всех современных браузерах и средах)
  for (const button of buttons) {
    // Читаем dataset.key — это значение, которое мы используем как ключ для перевода, например 'Q' или 'W'
    const key = button.dataset.key; // e.g., 'Q', 'W'
    if (key) {
      try {
        // Request the translation for the key from the main process.
        // window.electronAPI — это объект, который должен быть выставлен в preload.js через contextBridge.
        // translate — произвольный пример метода: main должен обработать этот вызов и вернуть строку перевода.
        const translatedLabel = await window.electronAPI.translate(`keyLabels.${key}`);
        // После получения перевода подставляем его в textContent кнопки.
        button.textContent = translatedLabel;
      } catch (error) {
        // Если перевод не доступен или произошла ошибка — логируем её в консоль.
        // console.error — встроенный метод объекта console для логирования ошибок.
        console.error(`Failed to translate key ${key}:`, error);
      }
    }
  }

  // Пример: обновление других текстов интерфейса тем же способом:
  // const welcomeElement = document.getElementById('welcome');
  // if (welcomeElement) {
  //   welcomeElement.textContent = await window.electronAPI.translate('otherUiText.welcome');
  // }
}

