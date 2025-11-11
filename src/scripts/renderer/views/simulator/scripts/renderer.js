// renderer.js — оптимизированная версия (сохранён весь функционал)
(() => {
  const $ = (id) => document.getElementById(id);

  // --- API bridge (preload may expose different names; prefer window.electronAPI) ---
  const api = window.electronAPI || window.ipcRenderer || null;

  // --- Session / timing / stats ---
  let sessionToken = null;
  let passageText = '';
  let duration = 60;
  let language = 'en';
  let punctuation = false;
  let t0 = null;
  let timerInterval = null;
  let elapsedMs = 0;
  let keystrokes = []; // { t_ms, key, position, correct }

  // Rendering state
  let cursor = 0;
  let statuses = []; // 'pending' | 'correct' | 'incorrect'
  let lastRenderedCursor = -1;

  // DOM cache (kept in scope; re-resolve on-demand if removed/recreated)
  const nodes = {
    startBtn: $('startBtn'),
    restartBtn: $('restart'),
    timerEl: $('timer'),
    passageEl: $('passage'),
    textDisplay: $('textDisplay'),
    trainer: $('trainer'),
    resultsPanel: $('resultsPanel'),
    chartDiv: $('chart'),
    summaryDiv: $('summary'),
    languageSel: $('language'),
    durationSel: $('duration'),
    punctChk: $('punct'),
    words_per_minute: $('words-per-minute-value'),
    correct_chars: $('correct-chars-value'),
    accuracy: $('accuracy-value'),
    error_chars: $('error-chars-value'),
  };

  // Option: писать каждый keystroke сразу в БД (через IPC)
  const RECORD_EACH_KEY = true;

  // AnyChart cached state
  const chartState = {
    containerId: 'chart-in-card',
    chart: null,
    wpmSeries: null,
    errorSeries: null,
    rightScale: null,
    resizeHandler: null,
    createdForSession: null
  };

  // helpers
  const normalizeSpaceChar = (ch) => (ch === '\u00A0' ? ' ' : ch);
  const nowMs = () => performance.now();

  function resolveNode(name) {
    nodes[name] = $(name) || nodes[name];
    return nodes[name];
  }

  function initStatuses() {
    statuses = new Array(passageText.length).fill('pending');
  }

  // --- Batched render using rAF to avoid multiple reflows on fast typing ---
  let renderScheduled = false;
  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      render();
    });
  }

  function render() {
    const textDisplay = resolveNode('textDisplay');
    const passageEl = resolveNode('passageEl');

    if (!textDisplay) return;
    // full rebuild via fragment (fast) — avoids setting innerHTML repeatedly
    const frag = document.createDocumentFragment();

    for (let i = 0; i < passageText.length; i++) {
      const ch = passageText[i];
      const span = document.createElement('span');
      span.className = 'char ' + (statuses[i] || 'pending') + (i === cursor ? ' caret' : '');
      span.textContent = ch === ' ' ? '\u00A0' : ch;
      span.dataset.index = i;
      frag.appendChild(span);
    }

    // Replace children with fragment — minimizes reflow
    while (textDisplay.firstChild) textDisplay.removeChild(textDisplay.firstChild);
    textDisplay.appendChild(frag);

    // update passage element text (for copy/export)
    if (passageEl) passageEl.textContent = passageText;

    // scroll caret into view only if cursor changed
    if (cursor !== lastRenderedCursor) {
      lastRenderedCursor = cursor;
      const caretSpan = textDisplay.querySelector('.char.caret');
      if (caretSpan) caretSpan.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }

  // --- Stats ---
  function computeStats() {
    const totalChars = passageText.length;
    // compute once using keystrokes array
    let correctChars = 0;
    let errors = 0;
    for (let i = 0; i < keystrokes.length; i++) {
      if (keystrokes[i].correct) correctChars++;
      else errors++;
    }
    const minutes = Math.max((elapsedMs / 1000) / 60, 1 / 60);
    const wpm = ((correctChars / 5) / minutes) || 0;
    const accuracyVal = (correctChars + errors) > 0 ? (correctChars / (correctChars + errors)) : 1;
    return { wpm, correctChars, errors, accuracy: accuracyVal, totalChars };
  }

  function showLiveStats(stat) {
    const wEl = resolveNode('words_per_minute');
    const aEl = resolveNode('accuracy');
    const cEl = resolveNode('correct_chars');
    const eEl = resolveNode('error_chars');

    if (wEl) wEl.textContent = stat.wpm.toFixed(1);
    if (aEl) aEl.textContent = `${(stat.accuracy * 100).toFixed(1)}%`;
    if (cEl) cEl.textContent = stat.correctChars || 0;
    if (eEl) eEl.textContent = stat.errors || 0;
  }

  // --- Chart helpers (create once per results show; update data on subsequent calls) ---
  function ensureChartContainerInCard() {
    const card = document.querySelector('.card.text-chart');
    if (!card) return null;
    let container = document.getElementById(chartState.containerId);
    if (!container) {
      container = document.createElement('div');
      container.id = chartState.containerId;
      container.style.width = '100%';
      container.style.height = '360px';
      container.style.boxSizing = 'border-box';
      container.setAttribute('aria-hidden', 'false');
      card.appendChild(container);
    } else {
      container.innerHTML = '';
    }
    return container;
  }

  function safeAnyChartCreate(container, data) {
    // Try to reuse chart if possible, else create new
    try {
      if (typeof anychart === 'undefined') {
        container.textContent = 'AnyChart not loaded';
        return;
      }

      // If chart exists and was created for same container, try to update series
      if (chartState.chart && chartState.createdForSession === sessionToken) {
        // attempt to set new data on series
        try {
          if (chartState.wpmSeries && typeof chartState.wpmSeries.data === 'function') {
            chartState.wpmSeries.data(data.map(d => [d.time, d.wpm]));
          } else if (chartState.wpmSeries && typeof chartState.wpmSeries.setData === 'function') {
            chartState.wpmSeries.setData(data.map(d => [d.time, d.wpm]));
          }
          if (chartState.errorSeries && (typeof chartState.errorSeries.data === 'function' || typeof chartState.errorSeries.setData === 'function')) {
            const errorsData = data.filter(d => d.errors > 0).map(d => [d.time, d.errors]);
            if (typeof chartState.errorSeries.data === 'function') chartState.errorSeries.data(errorsData);
            else chartState.errorSeries.setData(errorsData);
          }
          chartState.chart.draw && chartState.chart.draw();
          return;
        } catch (e) {
          // fallback to recreate chart
          destroyChart();
        }
      }

      // Create fresh chart
      anychart.onDocumentReady(() => {
        // clear possible previous container
        container.innerHTML = '';

        const theme = {
          containerBackground: '#0B1220',
          plotBackground: '#071018',
          plotBorder: '#08171eff',
          gridLine: '#0d1b21ff',
          axisStroke: '#192930ff',
          labels: '#cfe7ff',
          titles: '#eaf6ff',
          wpm: { stroke: '#e2b714', strokeWidth: 2, markerFill: '#e2b714', markerStroke: '#e2b714', size: 3 },
          errors: { fill: '#e11529', stroke: '#e11529', type: 'star4', size: 4 },
          tooltip: { background: '#0f1720', fontColor: '#e6f2ff' }
        };

        container.style.background = theme.containerBackground;

        const chart = anychart.cartesian ? anychart.cartesian() : anychart.line();
        chart.background().fill && chart.background().fill(theme.containerBackground);

        let plot;
        if (typeof chart.plot === 'function') plot = chart.plot(0) || chart;
        else if (typeof chart.getPlot === 'function') plot = chart.getPlot(0) || chart;
        else plot = chart;

        // safe background for plot
        try {
          if (typeof plot.background === 'function') {
            plot.background().fill(theme.plotBackground);
            if (plot.background().stroke && typeof plot.background().stroke === 'function') {
              plot.background().stroke(theme.plotBorder);
            }
          }
        } catch (e) { /* ignore */ }

        // grids
        try {
          if (typeof plot.xGrid === 'function') {
            plot.xGrid(true);
            if (plot.xGrid().stroke) plot.xGrid().stroke(theme.gridLine);
          } else if (typeof chart.xGrid === 'function') {
            chart.xGrid(true);
            if (chart.xGrid().stroke) chart.xGrid().stroke(theme.gridLine);
          }
          if (typeof plot.yGrid === 'function') {
            plot.yGrid(true);
            if (plot.yGrid().stroke) plot.yGrid().stroke(theme.gridLine);
          } else if (typeof chart.yGrid === 'function') {
            chart.yGrid(true);
            if (chart.yGrid().stroke) chart.yGrid().stroke(theme.gridLine);
          }
        } catch (e) { /* ignore */ }

        // series owner
        const seriesOwner = (typeof plot.spline === 'function' || typeof plot.marker === 'function') ? plot : chart;

        // create series
        let wpmSeries;
        try {
          if (typeof seriesOwner.spline === 'function') {
            wpmSeries = seriesOwner.spline(data.map(d => [d.time, d.wpm]));
          } else if (typeof seriesOwner.line === 'function') {
            wpmSeries = seriesOwner.line(data.map(d => [d.time, d.wpm]));
          } else {
            wpmSeries = seriesOwner.area && seriesOwner.area(data.map(d => [d.time, d.wpm])) || chart.line(data.map(d => [d.time, d.wpm]));
          }
          wpmSeries.name && wpmSeries.name('Слов в минуту');
          wpmSeries.tooltip && wpmSeries.tooltip().format && wpmSeries.tooltip().format('{%value}');
          try {
            wpmSeries.stroke && wpmSeries.stroke({ color: theme.wpm.stroke, thickness: theme.wpm.strokeWidth });
            if (wpmSeries.markers && wpmSeries.markers().enabled) {
              wpmSeries.markers().enabled(true).type('circle').size(theme.wpm.size).fill(theme.wpm.markerFill).stroke(theme.wpm.markerStroke);
            }
          } catch (e) { /* ignore */ }
        } catch (e) { /* ignore */ }

        // right scale for errors
        const rightScale = anychart.scales && anychart.scales.linear ? anychart.scales.linear() : null;
        if (rightScale) {
          rightScale.minimum && rightScale.minimum(0);
          // maximum set later below
        }

        // errors markers
        const errorPointsData = data.filter(d => d.errors > 0).map(d => [d.time, d.errors]);
        let errorPoints;
        try {
          const markerOwner = (typeof plot.marker === 'function') ? plot : chart;
          if (markerOwner.marker) errorPoints = markerOwner.marker(errorPointsData);
          else errorPoints = chart.marker && chart.marker(errorPointsData);
          errorPoints && errorPoints.name && errorPoints.name('Ошибок в секунду');
          try {
            errorPoints && errorPoints.type && errorPoints.type(theme.errors.type);
            errorPoints && errorPoints.size && errorPoints.size(theme.errors.size);
            errorPoints && errorPoints.fill && errorPoints.fill(theme.errors.fill);
            errorPoints && errorPoints.stroke && errorPoints.stroke(theme.errors.stroke);
          } catch (e) { /* ignore */ }
          if (errorPoints && rightScale && typeof errorPoints.yScale === 'function') errorPoints.yScale(rightScale);
          errorPoints && errorPoints.tooltip && errorPoints.tooltip().format && errorPoints.tooltip().format('Ошибки: {%value}');
        } catch (e) { /* ignore */ }

        // axes and labels (defensive)
        try {
          chart.yScale && chart.yScale().minimum && chart.yScale().minimum(0);
          chart.yAxis && chart.yAxis(0) && chart.yAxis(0).title && chart.yAxis(0).title('Слов в минуту') && chart.yAxis(0).title().fontColor(theme.titles);
          chart.yAxis && chart.yAxis(0) && chart.yAxis(0).labels && chart.yAxis(0).labels().fontColor(theme.labels);
          chart.yAxis && chart.yAxis(0) && chart.yAxis(0).stroke && chart.yAxis(0).stroke(theme.axisStroke);

          if (chart.yAxis && chart.yAxis(1)) {
            chart.yAxis(1).orientation && chart.yAxis(1).orientation('right');
            rightScale && chart.yAxis(1).scale && chart.yAxis(1).scale(rightScale);
            chart.yAxis(1).title && chart.yAxis(1).title('Ошибок в секунду').title().fontColor(theme.titles);
            chart.yAxis(1).labels && chart.yAxis(1).labels().fontColor(theme.labels);
            chart.yAxis(1).stroke && chart.yAxis(1).stroke(theme.axisStroke);
          }

          chart.xAxis && chart.xAxis().title && chart.xAxis().title('Секунды").title().fontColor && chart.xAxis().title().fontColor(theme.titles);
          chart.xAxis && chart.xAxis().labels && chart.xAxis().labels().fontColor && chart.xAxis().labels().fontColor(theme.labels);
          chart.xAxis && chart.xAxis().stroke && chart.xAxis().stroke(theme.axisStroke);
        } catch (e) { /* ignore */ }

        try { chart.legend && chart.legend(true) && chart.legend().labels().fontColor(theme.labels); } catch (e) { /* ignore */ }
        try {
          if (chart.tooltip && chart.tooltip().background) {
            chart.tooltip().background().fill && chart.tooltip().background().fill(theme.tooltip.background);
            chart.tooltip().fontColor && chart.tooltip().fontColor(theme.tooltip.fontColor);
          }
        } catch (e) { /* ignore */ }

        chart.container && chart.container(chartState.containerId);
        chart.draw && chart.draw();

        // store state
        chartState.chart = chart;
        chartState.wpmSeries = wpmSeries;
        chartState.errorSeries = errorPoints;
        chartState.rightScale = rightScale;
        chartState.createdForSession = sessionToken;

        // recalc right scale maximum helper
        function computeMaxY() {
          const maxErrors = data.length ? Math.max(...data.map(d => d.errors)) : 0;
          return maxErrors <= 0 ? 1 : Math.ceil(maxErrors + maxErrors / 3);
        }
        try {
          rightScale && rightScale.maximum && rightScale.maximum(computeMaxY());
        } catch (e) { /* ignore */ }

        // attach resize handler (avoid duplicates)
        if (chartState.resizeHandler) window.removeEventListener('resize', chartState.resizeHandler);
        chartState.resizeHandler = () => {
          try {
            rightScale && rightScale.maximum && rightScale.maximum(computeMaxY());
            chart.draw && chart.draw();
          } catch (e) { /* ignore */ }
        };
        window.addEventListener('resize', chartState.resizeHandler);
      });
    } catch (err) {
      console.error('safeAnyChartCreate error', err);
      container.textContent = 'Chart rendering failed';
    }
  }

  function destroyChart() {
    // Remove chart container and listeners
    const container = document.getElementById(chartState.containerId);
    if (container) container.remove();
    if (chartState.resizeHandler) {
      window.removeEventListener('resize', chartState.resizeHandler);
      chartState.resizeHandler = null;
    }
    // AnyChart does not always provide a destroy API that's consistent across builds;
    // we null refs and allow GC.
    chartState.chart = null;
    chartState.wpmSeries = null;
    chartState.errorSeries = null;
    chartState.rightScale = null;
    chartState.createdForSession = null;
  }

  function renderChartInCard(data) {
    const container = ensureChartContainerInCard();
    if (!container) return;

    // hide trainer UI (keep DOM so we can restore)
    const trainer = resolveNode('trainer');
    if (trainer) {
      trainer.style.display = 'none';
      trainer.setAttribute('aria-hidden', 'true');
    }

    safeAnyChartCreate(container, data);
  }

  function restoreTrainerInCard() {
    destroyChart();
    const trainer = resolveNode('trainer');
    if (trainer) {
      trainer.style.display = '';
      trainer.removeAttribute('aria-hidden');
      trainer.focus && trainer.focus();
    }
  }

  // --- session lifecycle ---
  async function startSession() {
    try {
      // restore UI and hide results
      restoreTrainerInCard();
      const resultsPanel = resolveNode('resultsPanel');
      if (resultsPanel) resultsPanel.hidden = true;

      language = resolveNode('languageSel') ? resolveNode('languageSel').value : language;
      duration = resolveNode('durationSel') ? parseInt(resolveNode('durationSel').value, 10) || duration : duration;
      punctuation = resolveNode('punctChk') ? !!resolveNode('punctChk').checked : !!punctuation;

      const createRes = api && api.createSession ? await api.createSession({ language, duration, punctuation, t9_enabled: 0 }) : { ok: false };
      if (!createRes || !createRes.ok) { alert('Failed to create session'); return; }
      sessionToken = createRes.token;

      const gen = api && api.generatePassage ? await api.generatePassage({
        language,
        length_words: Math.round(duration / 2),
        generator: 'random',
        style: punctuation ? 'punct' : 'plain'
      }) : { ok: false, text: '' };

      passageText = String(gen.text || '');
      if (api && api.savePassage) {
        api.savePassage({ session_token: sessionToken, text: passageText, language, punctuation, source: gen.source }).catch(console.error);
      }

      // reset
      keystrokes = [];
      cursor = 0;
      initStatuses();
      t0 = nowMs();
      elapsedMs = 0;

      scheduleRender();
      resolveNode('timerEl') && (resolveNode('timerEl').textContent = String(duration));
      resolveNode('trainer') && resolveNode('trainer').focus && resolveNode('trainer').focus();

      if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
      timerInterval = setInterval(onTick, 100);
      resolveNode('startBtn') && (resolveNode('startBtn').disabled = true);
      if (resolveNode('trainer')) resolveNode('trainer').setAttribute('data-hint', passageText.slice(0, 120) || '');

    } catch (err) {
      console.error('startSession error', err);
    }
  }

  function stopSession() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }

    const stat = computeStats();
    const { wpm, errors, accuracy: acc, totalChars, correctChars } = stat;

    // Save keystrokes if not recorded per-key
    (async () => {
      try {
        if (!RECORD_EACH_KEY && api && api.recordKeystroke) {
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
          resolveNode('textDisplay') && resolveNode('textDisplay').setAttribute('textDisplay', 'results');
          await api.finalizeResults({ session_token: sessionToken, wpm, avg_wpm: wpm, errors, accuracy: acc, totalChars, total_chars: totalChars });
        }
      } catch (err) {
        console.error('stopSession save error', err);
      }
    })();

    showResults({ wpm, avg_wpm: wpm, errors, accuracy: acc, totalChars, correctChars });
    resolveNode('startBtn') && (resolveNode('startBtn').disabled = false);
  }

  // --- results/graphing ---
  function showResults(stat) {
    // show numeric results
    showLiveStats(stat);

    // build per-second arrays
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

    try {
      renderChartInCard(data);
    } catch (err) {
      console.error('renderChartInCard failed', err);
    }

    // hide separate results panel to avoid duplication
    const resultsPanel = resolveNode('resultsPanel');
    if (resultsPanel) resultsPanel.hidden = true;

    // fill summaryDiv
    const summaryDiv = resolveNode('summaryDiv');
    if (summaryDiv) {
      summaryDiv.innerHTML = `<div>WPM: ${stat.wpm.toFixed(1)}</div><div>Accuracy: ${(stat.accuracy*100).toFixed(1)}%</div><div>Errors: ${stat.errors || 0}</div>`;
    }
  }

  // --- timer tick ---
  function onTick() {
    if (!t0) return;
    elapsedMs = nowMs() - t0;
    const remaining = Math.max(0, Math.round(duration - elapsedMs / 1000));
    resolveNode('timerEl') && (resolveNode('timerEl').textContent = String(remaining));

    // update live numbers
    const stat = computeStats();
    showLiveStats(stat);

    if (remaining <= 0) stopSession();
  }

  // --- keyboard handling ---
  window.addEventListener('keydown', (e) => {
    const trainer = resolveNode('trainer');

    // If session not running, let Enter focus the trainer (accessibility)
    if (!timerInterval) {
      if (e.key === 'Enter' && trainer) trainer.focus && trainer.focus();
      return;
    }

    // Only prevent default for printable keys/backspace/arrows while session active
    const key = e.key;
    const isPrintable = key.length === 1;
    const isNav = key === 'Backspace' || key === 'Tab' || key.startsWith('Arrow') || key === 'Enter';
    if (!isPrintable && !isNav) return;

    e.preventDefault();

    if (key === 'Tab') return;

    if (key === 'Backspace') {
      if (cursor > 0) {
        cursor--;
        statuses[cursor] = 'pending';
        scheduleRender();
      }
      return;
    }

    if (isPrintable) {
      if (cursor >= passageText.length) return;

      const expected = passageText[cursor];
      const typed = key;
      const ok = normalizeSpaceChar(typed) === normalizeSpaceChar(expected);

      const pos = cursor;
      statuses[pos] = ok ? 'correct' : 'incorrect';

      const kobj = { t_ms: nowMs() - t0, key: typed, position: pos, correct: ok };
      keystrokes.push(kobj);

      // immediate recording if enabled (fire-and-forget)
      if (RECORD_EACH_KEY && api && api.recordKeystroke) {
        try {
          api.recordKeystroke({
            session_token: sessionToken,
            t_ms: Math.round(kobj.t_ms),
            key: kobj.key,
            position: kobj.position,
            correct: kobj.correct ? 1 : 0
          }).catch && api.recordKeystroke({
            session_token: sessionToken,
            t_ms: Math.round(kobj.t_ms),
            key: kobj.key,
            position: kobj.position,
            correct: kobj.correct ? 1 : 0
          }).catch(console.error);
        } catch (err) {
          // If API is sync or not available, ignore
          console.error('recordKeystroke (immediate) failed', err);
        }
      }

      cursor++;
      scheduleRender();

      // update immediate live stats (cheap)
      const stat = computeStats();
      showLiveStats(stat);

      return;
    }

    if (key === 'ArrowLeft') { if (cursor > 0) { cursor--; scheduleRender(); } }
    else if (key === 'ArrowRight') { if (cursor < passageText.length) { cursor++; scheduleRender(); } }
  });

  // --- Controls binding ---
  function bindControls() {
    const startBtn = resolveNode('startBtn');
    const restartBtn = resolveNode('restartBtn');
    const reloadBtn = $('reload');
    const resetBtn = $('reset');

    if (startBtn) startBtn.addEventListener('click', startSession);
    if (restartBtn) restartBtn.addEventListener('click', () => {
      const resultsPanel = resolveNode('resultsPanel');
      if (resultsPanel) resultsPanel.hidden = true;
      restoreTrainerInCard();
      startSession();
    });

    if (reloadBtn) {
      reloadBtn.addEventListener('click', () => {
        const sel = $('preset') ? $('preset').value : null;
        if (sel && (sel === 'short' || sel === 'long')) {
          passageText = ({ short: "Съешь ещё этих мягких французских булок, да выпей же чаю.", long: "В те времена, когда ещё не было никаких тренажёров для скоропечатания, люди всё равно печатали быстро — кто пером, кто печатной машинкой, но с приходом компьютеров и приложений всё стало гораздо удобнее." })[sel] || '';
          cursor = 0;
          initStatuses();
          scheduleRender();
        } else { resolveNode('trainer') && resolveNode('trainer').focus && resolveNode('trainer').focus(); }
      });
    }

    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        cursor = 0;
        initStatuses();
        scheduleRender();
        resolveNode('trainer') && resolveNode('trainer').focus && resolveNode('trainer').focus();
      });
    }

    if (resolveNode('trainer')) resolveNode('trainer').addEventListener('click', () => resolveNode('trainer') && resolveNode('trainer').focus && resolveNode('trainer').focus());
  }

  // initial setup
  (function init() {
    if (!passageText) passageText = (resolveNode('passageEl') ? resolveNode('passageEl').textContent || '' : '');
    initStatuses();
    scheduleRender();
    bindControls();
  })();

  // expose for debugging (optional)
  window.__TypingRenderer = {
    startSession,
    stopSession,
    restoreTrainerInCard,
    render,
    computeStats,
    getState: () => ({ sessionToken, passageText, duration, language, punctuation, cursor, keystrokes, elapsedMs })
  };
})();
