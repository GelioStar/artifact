/* renderer.js — live stats версия (modified to render AnyChart inside .card.text-chart) */

const $ = (id) => document.getElementById(id);

// --- Возможная несовместимость preload: берем любую экспозицию API ---
const api = window.electronAPI;

// Session / timing / stats
let sessionToken = null;
let passageText = '';
let duration = 60;
let language = 'en';
let punctuation = false;
let t0 = null;
let timerInterval = null;
let elapsedMs = 0;
let keystrokes = []; // array of {t_ms, key, position, correct}

// Rendering state
let cursor = 0;
const statuses = []; // 'pending' | 'correct' | 'incorrect'

// DOM (note: trainer/textDisplay elements are cached but not replaced permanently;
// we only hide/show them so references remain valid)
const startBtn = $('startBtn');
const restartBtn = $('restart');
const timerEl = $('timer');
const passageEl = $('passage');
let textDisplay = $('textDisplay');
let trainer = $('trainer');
const resultsPanel = $('resultsPanel');
const chartDiv = $('chart'); // оставляем, но больше не используем для основного отображения
const summaryDiv = $('summary');
const languageSel = $('language');
const durationSel = $('duration');
const punctChk = $('punct');

// result fields
const words_per_minute = $('words-per-minute-value');
const correct_chars = $('correct-chars-value');
const accuracy = $('accuracy-value');
const error_chars = $('error-chars-value');

// Option: писать каждый keystroke сразу в БД (через IPC)
// Если true — stopSession пропустит bulk-insert, чтобы не дублировать.
const RECORD_EACH_KEY = true;

// helpers
function normalizeSpaceChar(ch) { if (ch === '\u00A0') return ' '; return ch; }
function nowMs() { return performance.now(); }

function initStatuses() {
  statuses.length = 0;
  for (let i = 0; i < passageText.length; i++) statuses.push('pending');
}

function render() {
  // ensure we have current references (в случае, если DOM пересоздавался извне)
  textDisplay = $('textDisplay') || textDisplay;
  trainer = $('trainer') || trainer;

  if (!textDisplay) return;
  textDisplay.innerHTML = '';
  for (let i = 0; i < passageText.length; i++) {
    const ch = passageText[i];
    const span = document.createElement('span');
    span.classList.add('char');
    span.classList.add(statuses[i] || 'pending');
    if (i === cursor) span.classList.add('caret');
    span.textContent = ch === ' ' ? '\u00A0' : ch;
    span.dataset.index = i;
    textDisplay.appendChild(span);
  }
  const caretSpan = textDisplay.querySelector('.char.caret');
  if (caretSpan) caretSpan.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  if (passageEl) passageEl.textContent = passageText;
}

// --- NEW: live stats computation ---
function computeStats() {
  const totalChars = passageText.length;
  const correctChars = keystrokes.filter(k => k.correct).length;
  const errors = keystrokes.filter(k => !k.correct).length;
  const minutes = Math.max((elapsedMs / 1000) / 60, 1 / 60);
  const wpm = ((correctChars / 5) / minutes) || 0;
  const accuracyVal = (correctChars + errors) > 0 ? (correctChars / (correctChars + errors)) : 1;
  return {
    wpm,
    correctChars,
    errors,
    accuracy: accuracyVal,
    totalChars
  };
}

function showLiveStats(stat) {
  if (words_per_minute) words_per_minute.textContent = stat.wpm.toFixed(1);
  if (accuracy) accuracy.textContent = `${(stat.accuracy * 100).toFixed(1)}%`;
  if (correct_chars) correct_chars.textContent = stat.correctChars || 0;
  if (error_chars) error_chars.textContent = stat.errors;
}

// --- card chart helpers ---
// Создаёт контейнер #chart-in-card внутри .card.text-chart и возвращает его
function ensureChartContainerInCard() {
  const card = document.querySelector('.card.text-chart');
  if (!card) return null;
  let container = document.getElementById('chart-in-card');
  if (!container) {
    container = document.createElement('div');
    container.id = 'chart-in-card';
    container.style.width = '100%';
    container.style.height = '360px';
    container.style.boxSizing = 'border-box';
    container.setAttribute('aria-hidden', 'false');
    // добавляем контейнер ПОСЛЕ #trainer, чтобы текст-тренажер был до него в DOM
    card.appendChild(container);
  } else {
    container.innerHTML = '';
  }
  return container;
}

// Показать/отрисовать график в карточке (data — массив объектов {time, wpm, errors})
function renderChartInCard(data) {
  const container = ensureChartContainerInCard();
  if (!container) return;

  // скрываем интерфейс тренажёра (оставляем DOM, чтобы при рестарте вернуть)
  if (trainer) {
    trainer.style.display = 'none';
    trainer.setAttribute('aria-hidden', 'true');
  }

  // AnyChart отрисовка
  if (typeof anychart === 'undefined') {
    container.textContent = 'AnyChart not loaded';
    return;
  }

  anychart.onDocumentReady(function () {
    // очищаем предыдущее содержимое контейнера (вдруг)
    container.innerHTML = '';

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
    chart.container('chart-in-card');
    chart.draw();
  });
}

// Убирает график из карточки и возвращает тренажёр
function restoreTrainerInCard() {
  const container = document.getElementById('chart-in-card');
  if (container) container.remove();
  if (trainer) {
    trainer.style.display = ''; // вернём дефолтное значение
    trainer.removeAttribute('aria-hidden');
    trainer.focus();
  }
}

// --- session lifecycle ---
async function startSession() {
  try {
    // при старте новой сессии убираем график и скрытые результаты
    restoreTrainerInCard();
    if (resultsPanel) resultsPanel.hidden = true;

    language = languageSel.value;
    duration = parseInt(durationSel.value, 10) || 60;
    punctuation = punctChk.checked ? 1 : 0;

    const res = await (api && api.createSession ? api.createSession({ language, duration, punctuation, t9_enabled: 0 }) : Promise.resolve({ ok: false }));
    if (!res || !res.ok) { alert('Failed to create session'); return; }
    sessionToken = res.token;

    const gen = await (api && api.generatePassage ? api.generatePassage({
      language,
      length_words: Math.round(duration / 2),
      generator: 'random',
      style: punctuation ? 'punct' : 'plain'
    }) : Promise.resolve({ ok: false, text: '' }));

    passageText = String(gen.text || '');
    if (api && api.savePassage) {
      api.savePassage({ session_token: sessionToken, text: passageText, language, punctuation, source: gen.source }).catch(console.error);
    }

    // reset state
    keystrokes = [];
    cursor = 0;
    initStatuses();
    t0 = nowMs();
    elapsedMs = 0;

    render();
    timerEl.textContent = String(duration);
    if (trainer) trainer.focus();

    // start timer (onTick updates elapsedMs and stops session when time's up)
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(onTick, 100); // ticks every 100ms
    startBtn.disabled = true;
    resultsPanel.hidden = true;

    if (trainer) trainer.setAttribute('data-hint', passageText.slice(0, 120));
  } catch (err) {
    console.error('startSession error', err);
  }
}

function stopSession() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }

  const stat = computeStats();
  const { wpm, errors, accuracy: acc, totalChars, correctChars } = stat;

  // Если мы не записывали клавиши по мере набора, запишем их здесь.
  if (!RECORD_EACH_KEY) {
    (async () => {
      try {
        if (api && api.recordKeystroke) {
          for (const k of keystrokes) {
            await api.recordKeystroke({
              session_token: sessionToken,
              t_ms: Math.round(k.t_ms),
              key: k.key,
              position: k.position,
              correct: k.correct ? 1 : 0
            });
          }
        }
        if (api && api.finalizeResults) {
          textDisplay.setAttribute('textDisplay', 'results');
          await api.finalizeResults({ session_token: sessionToken, wpm, avg_wpm: wpm, errors, accuracy: acc, totalChars, total_chars: totalChars });
        }
      } catch (err) {
        console.error('stopSession save error', err);
      }
    })();
  } else {
    // если писали каждое нажатие, просто finalize
    if (api && api.finalizeResults) {
      textDisplay.setAttribute('textDisplay', 'results');
      api.finalizeResults({ session_token: sessionToken, wpm, avg_wpm: wpm, errors, accuracy: acc, totalChars }).catch(console.error);
    }
  }

  showResults({ wpm, avg_wpm: wpm, errors, accuracy: acc, totalChars, correctChars });
  startBtn.disabled = false;
}

// --- results/graphing (keeps previous showResults but live) ---
function showResults(stat) {
  // уже показываем итоговые числа
  showLiveStats(stat);

  // build per-second arrays for charting (optional)
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

  // Отрисовываем график ВНУТРИ карточки .card.text-chart
  try {
    renderChartInCard(data);
  } catch (err) {
    console.error('renderChartInCard failed', err);
  }

  // прячем отдельную секцию результатов (чтобы не дублировать)
  if (resultsPanel) resultsPanel.hidden = true;

  // итоговый текст/summary можно заполнить в summaryDiv (если нужно)
  if (summaryDiv) {
    summaryDiv.innerHTML = `<div>WPM: ${stat.wpm.toFixed(1)}</div><div>Accuracy: ${(stat.accuracy*100).toFixed(1)}%</div><div>Errors: ${stat.errors || 0}</div>`;
  }
}

// --- timer tick (updates elapsedMs and live stats) ---
function onTick() {
  if (!t0) return;
  elapsedMs = nowMs() - t0;
  const remaining = Math.max(0, Math.round(duration - elapsedMs / 1000));
  timerEl.textContent = String(remaining);

  // update live numbers every tick (lightweight)
  const stat = computeStats();
  showLiveStats(stat);

  // stop when finished
  if (remaining <= 0) stopSession();
}

// --- keyboard handling (no textarea) ---
window.addEventListener('keydown', (e) => {
  if (!timerInterval) {
    if (e.key === 'Enter' && trainer) trainer.focus();
    return;
  }

  e.preventDefault();
  const key = e.key;
  if (key === 'Tab') return;
  if (key === 'Backspace') {
    if (cursor > 0) {
      cursor--;
      statuses[cursor] = 'pending';
      render();
    }
    return;
  }

  if (key.length === 1) {
    if (cursor >= passageText.length) return;

    const expected = passageText[cursor];
    const typed = key;
    const ok = normalizeSpaceChar(typed) === normalizeSpaceChar(expected);

    // remember position before increment
    const pos = cursor;

    statuses[pos] = ok ? 'correct' : 'incorrect';

    const kobj = { t_ms: nowMs() - t0, key: typed, position: pos, correct: ok };
    keystrokes.push(kobj);

    // --- NEW: send individual keystroke immediately (optional) ---
    if (RECORD_EACH_KEY && api && api.recordKeystroke) {
      try {
        api.recordKeystroke({
          session_token: sessionToken,
          t_ms: Math.round(kobj.t_ms),
          key: kobj.key,
          position: kobj.position,
          correct: kobj.correct ? 1 : 0
        }).catch(console.error);
      } catch (err) {
        console.error('recordKeystroke (immediate) failed', err);
      }
    }

    cursor++;
    render();

    // update live stats right after keystroke
    const stat = computeStats();
    showLiveStats(stat);

    return;
  }

  if (key === 'ArrowLeft') { if (cursor > 0) { cursor--; render(); } }
  else if (key === 'ArrowRight') { if (cursor < passageText.length) { cursor++; render(); } }
});

// Controls
if (startBtn) startBtn.addEventListener('click', startSession);
if (restartBtn) restartBtn.addEventListener('click', () => {
  // при рестарте прячем панель результатов и возвращаем тренажер
  if (resultsPanel) resultsPanel.hidden = true;
  restoreTrainerInCard();
  startSession();
});

const reloadBtn = $('reload');
if (reloadBtn) {
  reloadBtn.addEventListener('click', () => {
    const sel = $('preset') ? $('preset').value : null;
    if (sel && (sel === 'short' || sel === 'long')) {
      passageText = ({ short: "Съешь ещё этих мягких французских булок, да выпей же чаю.", long: "В те времена, когда ещё не было никаких тренажёров для скоропечатания, люди всё равно печатали быстро — кто пером, кто печатной машинкой, но с приходом компьютеров и приложений всё стало гораздо удобнее." })[sel] || '';
      cursor = 0;
      initStatuses();
      render();
    } else { if (trainer) trainer.focus(); }
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
if (trainer) trainer.addEventListener('click', () => trainer.focus());

// initial load
if (!passageText) {
  passageText = passageEl ? (passageEl.textContent || '') : '';
}
initStatuses();
render();
