/* renderer.js — merged: renderer1 functionality + renderer2-style rendering and no <textarea> input */
/* Использует electronAPI из renderer1 (createSession/generatePassage/savePassage/recordKeystroke/finalizeResults)
   и визуальную модель renderer2 (span на каждый символ + caret). */

const $ = (id) => document.getElementById(id);

// Session / timing / stats (from renderer1)
let sessionToken = null;
let passageText = '';
let duration = 60;
let language = 'en';
let punctuation = false;
let t0 = null;
let timerInterval = null;
let elapsedMs = 0;
let keystrokes = []; // array of {t_ms, key, position, correct}

// Rendering state (renderer2-style)
let cursor = 0; // index in passageText
const statuses = []; // 'pending' | 'correct' | 'incorrect'

// DOM elements (we prefer textDisplay/trainer like renderer2)
const startBtn = $('startBtn');
const restartBtn = $('restart');
const timerEl = $('timer');
const passageEl = $('passage'); // kept for compatibility if needed, but visual rendering uses textDisplay
const textDisplay = $('textDisplay'); // renderer2 visual container
const trainer = $('trainer'); // element that receives focus for keyboard input
const resultsPanel = $('resultsPanel');
const chartDiv = $('chart');
const summaryDiv = $('summary');
const languageSel = $('language');
const durationSel = $('duration');
const punctChk = $('punct');

// --- helper utilities ---
function normalizeSpaceChar(ch) {
  // treat NBSP and normal space as equivalent for comparison/display
  if (ch === '\u00A0') return ' ';
  return ch;
}
function nowMs() { return performance.now(); }

// --- rendering (renderer2 style) ---
function initStatuses() {
  statuses.length = 0;
  for (let i = 0; i < passageText.length; i++) statuses.push('pending');
}

function render() {
  // Build spans for each character in textDisplay (renderer2 behaviour)
  textDisplay.innerHTML = '';
  for (let i = 0; i < passageText.length; i++) {
    const ch = passageText[i];
    const span = document.createElement('span');
    span.classList.add('char');
    span.classList.add(statuses[i] || 'pending'); // safety
    if (i === cursor) span.classList.add('caret');
    // Show spaces visibly: use NBSP so they occupy width
    span.textContent = ch === ' ' ? '\u00A0' : ch;
    span.dataset.index = i;
    textDisplay.appendChild(span);
  }
  // Ensure caret visible — smoothly scroll if needed
  const caretSpan = textDisplay.querySelector('.char.caret');
  if (caretSpan) caretSpan.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });

  // Optional: keep old passage element (if present) in sync for accessibility / ARIA
  if (passageEl) {
    // mirror plain text for aria-live readers (but do not alter per-char statuses here)
    passageEl.textContent = passageText;
  }
}

// --- session lifecycle (from renderer1, adapted to new rendering) ---
async function startSession() {
  try {
    // read options
    language = languageSel.value;
    duration = parseInt(durationSel.value, 10) || 60;
    punctuation = punctChk.checked ? 1 : 0;

    // create session via main (electronAPI)
    const res = await window.electronAPI.createSession({ language, duration, punctuation, t9_enabled: 0 });
    if (!res.ok) { alert('Failed to create session'); return; }
    sessionToken = res.token;

    // generate passage
    const gen = await window.electronAPI.generatePassage({
      language,
      length_words: Math.round(duration / 2),
      generator: 'random',
      style: punctuation ? 'punct' : 'plain'
    });
    passageText = String(gen.text || '');
    await window.electronAPI.savePassage({
      session_token: sessionToken,
      text: passageText,
      language,
      punctuation,
      source: gen.source
    });

    // reset UI/state
    keystrokes = [];
    cursor = 0;
    initStatuses();
    t0 = nowMs();
    elapsedMs = 0;

    render();
    timerEl.textContent = String(duration);
    // focus trainer instead of textarea
    if (trainer) trainer.focus();

    // start timer (onTick updates elapsedMs and stops session when time's up)
    timerInterval = setInterval(onTick, 100);
    startBtn.disabled = true;
    resultsPanel.hidden = true;

    // optional: set a visual hint in trainer (no textarea placeholder)
    if (trainer) trainer.setAttribute('data-hint', passageText.slice(0, 120));
  } catch (err) {
    console.error('startSession error', err);
  }
}

function stopSession() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;

  const totalChars = passageText.length;
  const correctChars = keystrokes.filter(k => k.correct).length;
  const errors = keystrokes.filter(k => !k.correct).length;
  const minutes = (elapsedMs / 1000) / 60 || 1 / 60;
  const wpm = ((correctChars / 5) / minutes) || 0;
  const avg_wpm = wpm;
  const accuracy = correctChars / Math.max(1, correctChars + errors);

  // save keystrokes to DB (same as renderer1)
  (async () => {
    for (const k of keystrokes) {
      await window.electronAPI.recordKeystroke({
        session_token: sessionToken,
        t_ms: Math.round(k.t_ms),
        key: k.key,
        position: k.position,
        correct: k.correct ? 1 : 0
      });
    }
    await window.electronAPI.finalizeResults({ session_token: sessionToken, wpm, avg_wpm, errors, accuracy });
  })();

  showResults({ wpm, avg_wpm, errors, accuracy, totalChars, correctChars });

  startBtn.disabled = false;
}

// --- results/graphing (kept from renderer1) ---
function showResults(stat) {
  resultsPanel.hidden = false;
  summaryDiv.innerHTML = `
    <div>WPM: ${stat.wpm.toFixed(1)}</div>
    <div>Accuracy: ${(stat.accuracy * 100).toFixed(1)}%</div>
    <div>Correct chars: ${stat.correctChars || stat.totalChars}</div>
    <div>Errors: ${stat.errors}</div>
  `;

  const seconds = Math.max(1, Math.ceil(elapsedMs / 1000));
  const wpmSeries = new Array(seconds).fill(0);
  const errSeries = new Array(seconds).fill(0);

  for (const k of keystrokes) {
    const s = Math.min(seconds - 1, Math.floor(k.t_ms / 1000));
    if (k.correct) wpmSeries[s] += 1;
    else errSeries[s] += 1;
  }

  const wpmPerSec = wpmSeries.map((v, i) => {
    const window = 5;
    const start = Math.max(0, i - window + 1);
    const sum = wpmSeries.slice(start, i + 1).reduce((a, b) => a + b, 0);
    const charsPerMin = sum * (60 / window);
    const wpm = charsPerMin / 5;
    return +wpm.toFixed(2);
  });

  const data = [];
  for (let i = 0; i < seconds; i++) data.push({ time: i, wpm: wpmPerSec[i], errors: errSeries[i] });

  anychart.onDocumentReady(function () {
    var chart = anychart.cartesian();
    var wpmSeriesPlot = chart.line(data.map(d => [d.time, d.wpm]));
    wpmSeriesPlot.name('WPM').markers(true);
    wpmSeriesPlot.tooltip().format('{%value}');
    var errorsSeries = chart.column(data.map(d => [d.time, d.errors]));
    errorsSeries.name('Errors/sec');
    errorsSeries.yScale().ticks().interval(1);
    chart.yScale().minimum(0);
    chart.yAxis(0).title('WPM');
    chart.yAxis(1).orientation('right').title('Errors/sec');
    errorsSeries.yScale(chart.yScale());
    chart.xAxis().title('Seconds');
    chart.legend(true);
    chart.container('chart');
    chart.draw();
  });
}

// --- timer tick ---
function onTick() {
  if (!t0) return;
  elapsedMs = nowMs() - t0;
  const remaining = Math.max(0, Math.round(duration - elapsedMs / 1000));
  timerEl.textContent = String(remaining);
  if (remaining <= 0) stopSession();
}

// --- keyboard handling (no textarea) ---
// We capture keydown while session is active. We call e.preventDefault() only when session active
// to avoid interfering with general page keys otherwise.
window.addEventListener('keydown', (e) => {
  // Only process keys during an active session (timerInterval != null)
  if (!timerInterval) {
    // small UX: if Enter pressed and session not active, focus trainer so user can start
    if (e.key === 'Enter' && trainer) trainer.focus();
    return;
  }

  // Now session is active: intercept keys
  e.preventDefault();
  const key = e.key;

  if (key === 'Tab') return; // ignore Tab (we already prevented default)
  if (key === 'Backspace') {
    // move cursor back and mark pending (do not record backspace as keystroke)
    if (cursor > 0) {
      cursor--;
      statuses[cursor] = 'pending';
      render();
    }
    return;
  }

  // printable characters: single-character strings
  if (key.length === 1) {
    if (cursor >= passageText.length) {
      // ignore input past end
      return;
    }
    const expected = passageText[cursor];
    const typed = key;
    // normalize spaces for comparison
    const ok = normalizeSpaceChar(typed) === normalizeSpaceChar(expected);
    statuses[cursor] = ok ? 'correct' : 'incorrect';

    // record keystroke (time from start, the character we *saw* from the keyboard, position, correctness)
    keystrokes.push({ t_ms: nowMs() - t0, key: typed, position: cursor, correct: ok });

    cursor++;
    render();
    return;
  }

  // navigation keys while session running
  if (key === 'ArrowLeft') {
    if (cursor > 0) { cursor--; render(); }
  } else if (key === 'ArrowRight') {
    if (cursor < passageText.length) { cursor++; render(); }
  }
  // other modifier keys ignored (Shift/Ctrl/Alt)
});

// Controls (start/restart, reload/reset from renderer2 UI)
if (startBtn) startBtn.addEventListener('click', startSession);
if (restartBtn) restartBtn.addEventListener('click', () => { resultsPanel.hidden = true; startSession(); });

// reload/reset controls from renderer2-style index2.html if present
const reloadBtn = $('reload');
if (reloadBtn) {
  reloadBtn.addEventListener('click', () => {
    const sel = $('preset') ? $('preset').value : null;
    if (sel && (sel === 'short' || sel === 'long')) {
      // load local preset immediately (useful when working offline)
      passageText = ({ short: "Съешь ещё этих мягких французских булок, да выпей же чаю.", long: "В те времена, когда ещё не было никаких тренажёров для скоропечатания, люди всё равно печатали быстро — кто пером, кто печатной машинкой, но с приходом компьютеров и приложений всё стало гораздо удобнее." })[sel] || '';
      cursor = 0;
      initStatuses();
      render();
    } else {
      // fallback: just focus trainer
      if (trainer) trainer.focus();
    }
    if (trainer) trainer.focus();
  });
}
const resetBtn = $('reset');
if (resetBtn) {
  resetBtn.addEventListener('click', () => {
    cursor = 0;
    initStatuses();
    render();
    if (trainer) trainer.focus();
  });
}

// click into trainer to focus (so keydowns are captured)
if (trainer) trainer.addEventListener('click', () => trainer.focus());

// initial load: if passageText already present (or loaded inline), prepare status and render
if (!passageText) {
  // If you want initial passage from server, keep it empty or load default preset here.
  passageText = passageEl ? (passageEl.textContent || '') : '';
}
initStatuses();
render();
