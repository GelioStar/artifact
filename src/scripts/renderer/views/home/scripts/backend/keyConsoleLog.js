/* keyConsoleLog.js
   Логика: собирает одновременные нажатия (мышь/тач/клавиатура),
   при полном отпускании формирует набор символов (QWERTY),
   переводит в STENO по карте, затем ищет в mainMap (загруженном из main.json).
*/

(() => {
  // Настройки времени (можно подстроить)
  const releaseWindowMs = 5;
  const finalDelayMs = 5;
  const SEQUENCE_WINDOW_MS = 1000;

  const QWERTY_ORDER = "QWERTYUIOPASDFGHJKL;ZXCVBNM";

  const qwertyToSteno = {
    'Q': 'S', 'W': 'T', 'E': 'P', 'R': 'H', 'T': '*', 'Y': 'F', 'U': 'P', 'I': 'L', 'O': 'T', 'P': 'D',
    'A': 'S', 'S': 'K', 'D': 'W', 'F': 'R', 'G': '*', 'H': 'R', 'J': 'B', 'K': 'G', 'L': 'S', ';': 'Z',
    'V': 'A', 'B': 'O', 'N': 'E', 'M': 'U'
  };

  const pressedSet = new Set();
  let pressedSymbols = new Set();
  let releaseBatchSet = new Set();
  const chordSequence = [];

  let mainMap = {};
  let releaseTimer = null;
  let finalTimer = null;
  let sequenceTimer = null;

  const output = () => document.getElementById('output');
  const normalizeKey = (s) => (String(s || '').trim().toUpperCase().slice(0,1) || null);

  function idFromElement(el) {
    if (!el) return null;
    if (el.dataset && el.dataset.code) return `code:${el.dataset.code}`;
    if (el.dataset && el.dataset.key) return `key:${normalizeKey(el.dataset.key)}`;
    if (el.dataset && el.dataset.text) return `key:${normalizeKey(el.dataset.text)}`;
    const sym = normalizeKey(el.textContent || el.innerText);
    if (sym) return `key:${sym}`;
    if (!el.dataset.uid) el.dataset.uid = Math.random().toString(36).slice(2,9);
    return `el:${el.dataset.uid}`;
  }

  function keyIdFromKeyboardEvent(e) {
    const code = e.code || null;
    const key = (e.key && e.key.length === 1) ? normalizeKey(e.key) : null;
    return code ? `code:${code}` : (key ? `key:${key}` : null);
  }

  function getSymbolFromElement(el) {
    if (!el) return null;
    if (el.dataset && el.dataset.key) return normalizeKey(el.dataset.key);
    if (el.dataset && el.dataset.text) return normalizeKey(el.dataset.text);
    return normalizeKey(el.textContent || el.innerText);
  }

  function sortQwertySymbols(arr) {
    const orderMap = new Map();
    for (let i = 0; i < QWERTY_ORDER.length; i++) orderMap.set(QWERTY_ORDER[i], i);
    return arr.sort((a,b) => {
      const ia = orderMap.has(a) ? orderMap.get(a) : Number.POSITIVE_INFINITY;
      const ib = orderMap.has(b) ? orderMap.get(b) : Number.POSITIVE_INFINITY;
      if (ia !== ib) return ia - ib;
      return a.localeCompare(b);
    });
  }

  function qwertyArrayToStenoString(arr) {
    return arr.map(ch => qwertyToSteno[ch] || ch).join('');
  }

  function emitResult(text) {
    console.log(text);
    const el = document.getElementById('output');
    if (el) el.textContent = String(text);
    // отправка в main для печати
    window.electronAPI.printText(String(text));
  }


  function tryMatchLongestSequence() {
    if (!mainMap || Object.keys(mainMap).length === 0) return false;
    for (let n = chordSequence.length; n >= 1; n--) {
      const candidate = chordSequence.slice(-n).join('/');
      if (candidate in mainMap) {
        const value = mainMap[candidate];
        emitResult(value);
        chordSequence.splice(chordSequence.length - n, n);
        return true;
      }
    }
    return false;
  }

  function doLogBatch() {
    if (releaseBatchSet.size === 0) return;
    const qarr = Array.from(releaseBatchSet).map(x => String(x).toUpperCase());
    const sorted = sortQwertySymbols(qarr);
    const stenoChord = qwertyArrayToStenoString(sorted);

    releaseBatchSet.clear();
    pressedSymbols.clear();

    chordSequence.push(stenoChord);

    if (tryMatchLongestSequence()) {
      if (sequenceTimer) { clearTimeout(sequenceTimer); sequenceTimer = null; }
      return;
    }

    if (sequenceTimer) clearTimeout(sequenceTimer);
    sequenceTimer = setTimeout(() => {
      sequenceTimer = null;
      if (tryMatchLongestSequence()) return;
      while (chordSequence.length > 0) {
        const single = chordSequence.shift();
        if (single in mainMap) {
          emitResult(mainMap[single]);
        } else {
          emitResult(single);
        }
      }
    }, SEQUENCE_WINDOW_MS);
  }

  function onReleaseDetected(symbol) {
    if (symbol) releaseBatchSet.add(symbol);
    if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null; }
    if (finalTimer) { clearTimeout(finalTimer); finalTimer = null; }

    releaseTimer = setTimeout(() => {
      releaseTimer = null;
      if (pressedSet.size === 0) {
        finalTimer = setTimeout(() => {
          finalTimer = null;
          doLogBatch();
        }, finalDelayMs);
      }
    }, releaseWindowMs);
  }

  // keyboard handlers
  window.addEventListener('keydown', (e) => {
    const id = keyIdFromKeyboardEvent(e);
    if (!id) return;
    if (pressedSet.has(id)) return;
    pressedSet.add(id);
    const keyChar = (e.key && e.key.length === 1) ? normalizeKey(e.key) : null;
    if (keyChar) pressedSymbols.add(keyChar);
    if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null; }
    if (finalTimer) { clearTimeout(finalTimer); finalTimer = null; }
  });

  window.addEventListener('keyup', (e) => {
    const id = keyIdFromKeyboardEvent(e);
    if (!id) return;
    pressedSet.delete(id);
    const keyChar = (e.key && e.key.length === 1) ? normalizeKey(e.key) : null;
    if (keyChar) {
      pressedSymbols.add(keyChar);
      onReleaseDetected(keyChar);
    } else {
      onReleaseDetected(null);
    }
  });

  // mouse/touch handlers for .key-btn
  function keyButtons() { return Array.from(document.querySelectorAll('.key-btn')); }

  function initMouseTouchForButtons() {
    keyButtons().forEach(btn => {
      if (!btn.dataset.key && !btn.dataset.text) {
        const s = normalizeKey(btn.textContent || btn.innerText);
        if (s) btn.dataset.text = s;
      }
      let mouseId = null;

      btn.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        const id = idFromElement(btn);
        pressedSet.add(id);
        const sym = getSymbolFromElement(btn);
        if (sym) pressedSymbols.add(sym);
        if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null; }
        if (finalTimer) { clearTimeout(finalTimer); finalTimer = null; }
        mouseId = id;
      });

      const releaseMouseHandler = (ev) => {
        if (!mouseId) return;
        pressedSet.delete(mouseId);
        const sym = getSymbolFromElement(btn);
        if (sym) onReleaseDetected(sym);
        else onReleaseDetected(null);
        mouseId = null;
      };

      btn.addEventListener('mouseup', releaseMouseHandler);
      btn.addEventListener('mouseleave', releaseMouseHandler);

      btn.addEventListener('touchstart', (ev) => {
        ev.preventDefault();
        const id = idFromElement(btn);
        pressedSet.add(id);
        const sym = getSymbolFromElement(btn);
        if (sym) pressedSymbols.add(sym);
        if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null; }
        if (finalTimer) { clearTimeout(finalTimer); finalTimer = null; }
        mouseId = id;
      }, { passive: false });

      btn.addEventListener('touchend', releaseMouseHandler);
      btn.addEventListener('touchcancel', releaseMouseHandler);
    });
  }

  function clearAllStates() {
    pressedSet.clear();
    pressedSymbols.clear();
    releaseBatchSet.clear();
    chordSequence.length = 0;
    if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null; }
    if (finalTimer) { clearTimeout(finalTimer); finalTimer = null; }
    if (sequenceTimer) { clearTimeout(sequenceTimer); sequenceTimer = null; }
  }

  window.addEventListener('blur', clearAllStates);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') clearAllStates();
  });

  // load main.json
  async function loadMainJson() {
    try {
      if (!window.electronAPI || !window.electronAPI.loadMainJson) {
        console.warn('electronAPI.loadMainJson is not available in preload. main.json mapping will be empty.');
        return;
      }
      const res = await window.electronAPI.loadMainJson();
      if (res && res.ok && res.data) {
        mainMap = res.data;
        console.log('Loaded main.json entries:', Object.keys(mainMap).length);
      } else {
        console.warn('Failed to load main.json from main process.', res && res.error);
      }
    } catch (err) {
      console.error('Error while loading main.json:', err);
    }
  }

  window.addEventListener('DOMContentLoaded', async () => {
    await loadMainJson();
    initMouseTouchForButtons();
  });

})();
