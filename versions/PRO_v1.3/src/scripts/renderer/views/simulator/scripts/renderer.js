/* renderer.js - typing trainer UI logic */
const $ = (id) => document.getElementById(id);

let sessionToken = null;
let passageText = '';
let duration = 60;
let language = 'en';
let punctuation = false;
let t0 = null;
let timerInterval = null;
let elapsedMs = 0;
let keystrokeIndex = 0;
let keystrokes = []; // array of {t_ms, key, position, correct}

// DOM
const startBtn = $('startBtn');
const restartBtn = $('restart');
const timerEl = $('timer');
const passageEl = $('passage');
const inputEl = $('input');
const resultsPanel = $('resultsPanel');
const chartDiv = $('chart');
const summaryDiv = $('summary');
const languageSel = $('language');
const durationSel = $('duration');
const punctChk = $('punct');

function renderPassage() {
  passageEl.innerHTML = '';
  for (let i=0;i<passageText.length;i++) {
    const span = document.createElement('span');
    span.className = 'ch';
    span.textContent = passageText[i];
    if (i === keystrokeIndex) span.classList.add('current');
    passageEl.appendChild(span);
  }
}

async function startSession() {
  try {// read options
  language = languageSel.value;
  duration = parseInt(durationSel.value,10) || 60;
  punctuation = punctChk.checked ? 1 : 0;
  // create session via main
  const res = await window.electronAPI.createSession({ language, duration, punctuation, t9_enabled:0 });
  if (!res.ok) { alert('Failed to create session'); return; }
  sessionToken = res.token;
  // generate passage
  const gen = await window.electronAPI.generatePassage({ language, length_words: Math.round(duration/2), generator: 'random', style: punctuation? 'punct':'plain' });
  passageText = gen.text + '';
  await window.electronAPI.savePassage({ session_token: sessionToken, text: passageText, language, punctuation, source: gen.source });
  // reset UI
  keystrokes = [];
  keystrokeIndex = 0;
  t0 = performance.now();
  elapsedMs = 0;
  inputEl.value = '';
  renderPassage();
  $('timer').textContent = duration.toString();
  // focus and start timer
  inputEl.focus();
  timerInterval = setInterval(onTick, 100);
  startBtn.disabled = true;
  resultsPanel.hidden = true;
  // set placeholder
  inputEl.placeholder = passageText.slice(0,120);
  } catch (err) {
    console.error('startSession error', err);
  }
}

function stopSession() {
  clearInterval(timerInterval);
  timerInterval = null;
  // compute results
  const totalChars = passageText.length;
  const correctChars = keystrokes.filter(k=>k.correct).length;
  const errors = keystrokes.filter(k=>!k.correct).length;
  const minutes = (elapsedMs/1000)/60 || 1/60;
  const wpm = ((correctChars/5)/minutes) || 0;
  const avg_wpm = wpm; // placeholder
  const accuracy = correctChars / Math.max(1, correctChars+errors);
  // save keystrokes to DB
  (async ()=>{
    for (const k of keystrokes) {
      await window.electronAPI.recordKeystroke({ session_token: sessionToken, t_ms: Math.round(k.t_ms), key: k.key, position: k.position, correct: k.correct ? 1:0 });
    }
    await window.electronAPI.finalizeResults({ session_token: sessionToken, wpm, avg_wpm, errors, accuracy });
  })();
  showResults({ wpm, avg_wpm, errors, accuracy, totalChars, correctChars });
  startBtn.disabled = false;
}

function showResults(stat) {
  resultsPanel.hidden = false;
  // Summary
  summaryDiv.innerHTML = `
    <div>WPM: ${stat.wpm.toFixed(1)}</div>
    <div>Accuracy: ${(stat.accuracy*100).toFixed(1)}%</div>
    <div>Correct chars: ${stat.correctChars || stat.totalChars}</div>
    <div>Errors: ${stat.errors}</div>
  `;
  // Build series per second: WPM per second (smoothed) and errors per second (bars)
  const seconds = Math.ceil(elapsedMs/1000);
  const wpmSeries = new Array(seconds).fill(0);
  const errSeries = new Array(seconds).fill(0);
  // compute cumulative correct chars per second
  for (const k of keystrokes) {
    const s = Math.min(seconds-1, Math.floor(k.t_ms/1000));
    if (k.correct) wpmSeries[s] += 1;
    else errSeries[s] += 1;
  }
  // convert chars->WPM smoothing: rolling sum of last 5 seconds * 12 (chars per min) /5? We'll make a simple conversion
  const wpmPerSec = wpmSeries.map((v,i)=> {
    const window = 5;
    const start = Math.max(0,i-window+1);
    const sum = wpmSeries.slice(start,i+1).reduce((a,b)=>a+b,0);
    const charsPerMin = sum * (60/window);
    const wpm = charsPerMin / 5;
    return +wpm.toFixed(2);
  });
  // build data for chart
  const data = [];
  for (let i=0;i<seconds;i++) data.push({ time: i, wpm: wpmPerSec[i], errors: errSeries[i] });
  // AnyChart plotting
  anychart.onDocumentReady(function () {
    var chart = anychart.cartesian();
    var wpmSeriesPlot = chart.line(data.map(d=>[d.time,d.wpm]));
    wpmSeriesPlot.name('WPM').markers(true);
    wpmSeriesPlot.tooltip().format('{%value}');
    var errorsSeries = chart.column(data.map(d=>[d.time,d.errors]));
    errorsSeries.name('Errors/sec');
    errorsSeries.yScale().ticks().interval(1);
    // map axes: left (WPM), right (errors)
    chart.yScale().minimum(0);
    chart.yAxis(0).title('WPM');
    chart.yAxis(1).orientation('right').title('Errors/sec');
    errorsSeries.yScale(chart.yScale()); // share scale but visually columns
    chart.xAxis().title('Seconds');
    chart.legend(true);
    chart.container('chart');
    chart.draw();
  });
}

function onTick() {
  elapsedMs = performance.now() - t0;
  const remaining = Math.max(0, Math.round(duration - elapsedMs/1000));
  timerEl.textContent = String(remaining);
  if (remaining <= 0) {
    stopSession();
  }
}

// Input handling — simple per-character compare
inputEl.addEventListener('input', (e) => {
  const val = inputEl.value;
  // compare with passageText up to val.length
  const now = performance.now();
  // Determine last char typed
  const lastPos = val.length - 1;
  const lastChar = val[lastPos] || '';
  // compute correctness at that position in passage
  const expected = passageText[lastPos] || '';
  const correct = lastChar === expected;
  // push keystroke entry
  keystrokes.push({ t_ms: now - t0, key: lastChar, position: lastPos, correct });
  // update display: update classes
  keystrokeIndex = val.length; // current position is next char
  const spans = passageEl.querySelectorAll('.ch');
  spans.forEach((sp,i)=>{ sp.classList.remove('correct','wrong','current'); if (i<val.length){ if (val[i]===passageText[i]) sp.classList.add('correct'); else sp.classList.add('wrong'); } if (i===keystrokeIndex) sp.classList.add('current'); });
  // blink cursor handled by CSS current class
});

startBtn.addEventListener('click', startSession);
restartBtn.addEventListener('click', ()=>{ resultsPanel.hidden=true; startSession(); });

// Small UX: press Enter to focus textarea
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { inputEl.focus(); }
});
