import { analyzeTicks, jensenShannonDistance } from './features.js';
import { LocalTickModel } from './model.js';
import { ForecastBook } from './forecast-book.js';
import { ResearchStorage } from './storage.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const number = n => new Intl.NumberFormat().format(n || 0);
const percent = n => Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—';
const formatMs = n => Number.isFinite(n) ? `${n.toFixed(n >= 100 ? 0 : 1)} ms` : '—';
const finalDigit = quote => { const m = String(quote).match(/\d/g); return m ? Number(m.at(-1)) : null; };

export function createResearchWorkspace({ getActualTicks, getSymbols, getConnected, getSelected, onSelectSymbol }) {
  const storage = new ResearchStorage();
  const settings = loadSettings();
  const models = new Map(), profiles = new Map(), generated = new Map(), status = new Map(), trainingData = new Map(), liveMimic = new Map();
  let forecasts = new ForecastBook(), timer = 0, started = false, paused = false, generatedTotal = 0;
  let recentEventRows = [], lastRender = 0, renderTimer = 0, droppedGenerationRequests = 0;
  let generatedWriteQueue = [], generatedWriteTimer = 0, generatorRenderTimer = 0, lastGeneratorRender = 0;
  let generatorWorker = null, workerSymbol = null, workerReady = false, workerBusy = false, workerBusySince = 0, autoStarted = false;
  try {
    if (typeof Worker === 'function') {
      generatorWorker = new Worker(new URL('./generator-worker.js', import.meta.url), { type: 'module' });
      generatorWorker.addEventListener('message', event => {
        const message = event.data || {};
        if (message.type === 'READY') { workerReady = message.symbol === workerSymbol; return; }
        if (message.type === 'ERROR') { workerBusy = false; workerReady = false; generatorWorker?.terminate(); generatorWorker = null; showGeneratorStatus(`WORKER RECOVERED · ${message.message}`); return; }
        if (message.type !== 'TICK_RESULT' || !message.tick) return;
        workerBusy = false; workerBusySince = 0;
        const model = models.get(message.tick.symbol);
        if (model && message.snapshot) {
          if (model.version <= message.snapshot.version) model.restore(message.snapshot);
          else Object.assign(model, { generatedSequence: message.snapshot.generatedSequence, lastGeneratedQuote: message.snapshot.lastGeneratedQuote, lastGeneratedDigit: message.snapshot.lastGeneratedDigit, randomState: message.snapshot.randomState });
        }
        storeGenerated(message.tick);
      });
      generatorWorker.addEventListener('error', () => { workerBusy = false; generatorWorker = null; showGeneratorStatus('WORKER UNAVAILABLE · using main thread'); });
    }
  } catch { generatorWorker = null; }

  async function initialize() {
    try {
      const [savedModels, savedForecasts, savedEvaluations] = await Promise.all([storage.listModels(), storage.listForecasts(), storage.listEvaluations()]);
      const evalMap = new Map();
      for (const row of savedEvaluations) { const list = evalMap.get(row.forecastId) || []; list.push(row); evalMap.set(row.forecastId, list); }
      forecasts.restore(savedForecasts.map(f => ({ ...f, evaluations: evalMap.get(f.id) || f.evaluations || [] })));
      for (const f of forecasts.forecasts) { f.scoringCount = f.evaluations.length; if (f.scoringCount >= f.horizon) f.status = 'COMPLETE'; else if (f.scoringCount) f.status = 'PARTIAL'; }
      for (const snapshot of savedModels) if (snapshot?.symbol) { const model = new LocalTickModel(snapshot.symbol, { priorStrength: settings.priorStrength }); try { model.restore(snapshot); models.set(snapshot.symbol, model); } catch { /* retrain from actual history once the symbol is discovered */ } }
      generatedTotal = (await storage.counts()).generatedTicks || 0;
      recentEventRows = await storage.listEvents(null, 100);
      renderAll();
    } catch (error) { showStorage(`Persistent storage unavailable: ${error.message}`); }
  }

  async function registerSymbol(symbol, ticks) {
    let model = models.get(symbol);
    if (!model) { model = new LocalTickModel(symbol, { priorStrength: settings.priorStrength, windowSize: Math.max(...settings.windows) }); models.set(symbol, model); }
    let storedActual = [];
    try { storedActual = await storage.loadTicks('actual', symbol, 10000); } catch { /* the previous browser cache can still seed this model */ }
    const byId = new Map([...storedActual, ...(ticks || getActualTicks(symbol) || [])].filter(t => t?.source === 'DERIV_ACTUAL').map(t => [t.id || `${t.symbol}:${t.epoch}`, t]));
    const actual = [...byId.values()].sort((a, b) => Number(a.epoch) - Number(b.epoch)).slice(-10000);
    trainingData.set(symbol, actual);
    const ready = actual.length > 0;
    if (ready) {
      model.fit(actual);
      prepareLiveMimic(symbol, model, actual);
      profiles.set(symbol, analyzeTicks(actual, settings.windows));
      status.set(symbol, { dataReady: true, modelReady: model.status === 'READY', sampleCount: actual.length, updatedAt: Date.now() });
      try { await storage.appendActualBatch(actual.slice(-1000)); await storage.saveModel(symbol, model.snapshot()); } catch (error) { showStorage(error.message); }
    } else {
      status.set(symbol, { dataReady: false, modelReady: model.status === 'READY', sampleCount: 0, updatedAt: null });
    }
    if (!generated.has(symbol)) {
      try { generated.set(symbol, await storage.loadTicks('generated', symbol, 1000)); } catch { generated.set(symbol, []); }
    }
    renderAll();
    if (symbol === getSelected() && model.status === 'READY' && !autoStarted && settings.autoStartGenerator !== false) {
      autoStarted = true;
      startGenerator();
    }
    return status.get(symbol);
  }

  async function observeActual(tick, allActualTicks) {
    if (tick?.source !== 'DERIV_ACTUAL') return;
    const results = forecasts.scoreActual(tick);
    const model = models.get(tick.symbol) || new LocalTickModel(tick.symbol, { priorStrength: settings.priorStrength, windowSize: Math.max(...settings.windows) });
    models.set(tick.symbol, model);
    scoreLiveMimic(tick);
    const history = trainingData.get(tick.symbol) || [];
    if (!history.some(row => row.id && row.id === tick.id)) history.push(tick);
    const retained = history.slice(-10000); trainingData.set(tick.symbol, retained);
    model.fit(retained);
    prepareLiveMimic(tick.symbol, model, retained);
    profiles.set(tick.symbol, analyzeTicks(retained, settings.windows));
    status.set(tick.symbol, { dataReady: true, modelReady: model.status === 'READY', sampleCount: model.actualCount, updatedAt: Date.now() });
    if (generatorWorker && workerSymbol === tick.symbol) { workerReady = false; generatorWorker.postMessage({ type: 'UPDATE', snapshot: model.snapshot() }); }
    try {
      await storage.appendActual(tick);
      await storage.saveModel(tick.symbol, model.snapshot());
      for (const result of results) await storage.saveEvaluation(result);
      for (const forecast of forecasts.forecasts.filter(f => f.symbol === tick.symbol)) await storage.saveForecast(forecast);
    } catch (error) { showStorage(error.message); }
    renderAll();
  }

  function predictionHorizon() {
    return Math.max(2, Math.min(36, Number($('predictionHorizon')?.value) || 12));
  }
  function prepareLiveMimic(symbol, model, actual) {
    if (!model || model.status !== 'READY' || !actual?.length) return;
    const last = actual.at(-1);
    const prior = liveMimic.get(symbol) || { evaluated: 0, correct: 0, quoteError: 0, history: [] };
    prior.path = model.predictPath(predictionHorizon(), {
      method: $('predictionModel')?.value || 'markov', seed: (Date.now() ^ model.version) >>> 0 || 1,
      startQuote: String(last.quote), startDigit: Number.isInteger(last.digit) ? last.digit : finalDigit(last.quote),
    });
    prior.issuedAt = Date.now(); prior.modelVersion = model.version; prior.lastActual = last; prior.symbol = symbol;
    liveMimic.set(symbol, prior);
  }
  function scoreLiveMimic(tick) {
    const live = liveMimic.get(tick.symbol), prediction = live?.path?.[0];
    if (!live || !prediction || tick.id === live.lastActual?.id) return;
    const actualDigit = Number.isInteger(tick.digit) ? tick.digit : finalDigit(tick.quote);
    const correct = actualDigit === prediction.digit;
    const quoteError = Number.isFinite(Number(tick.quote)) && Number.isFinite(Number(prediction.quote)) ? Math.abs(Number(tick.quote) - Number(prediction.quote)) : null;
    live.evaluated += 1; if (correct) live.correct += 1; if (quoteError !== null) live.quoteError += quoteError;
    live.lastPrediction = prediction; live.lastOutcome = { tick, actualDigit, correct, quoteError };
    live.history = [{ tick, prediction, actualDigit, correct, quoteError }].concat(live.history || []).slice(0, 36);
    live.path = live.path.slice(1);
  }

  function issueForecast(symbol, horizon, method) {
    const model = models.get(symbol), actual = trainingData.get(symbol) || getActualTicks(symbol) || [];
    if (!model) throw new Error('This symbol has no initialized model.');
    if (symbol !== getSelected()) onSelectSymbol?.(symbol);
    const forecast = forecasts.issue({ symbol, model, actualTicks: actual, horizon, method });
    storage.saveForecast(forecast).catch(error => showStorage(error.message));
    logEvent({ type: 'forecast_issued', symbol, id: forecast.id, modelVersion: forecast.modelVersion, horizon: forecast.horizon, method });
    renderAll();
    return forecast;
  }

  function makeGenerated(symbol) {
    const model = models.get(symbol);
    if (!model || model.status === 'UNTRAINED') return null;
    const mode = $('generatorMode')?.value === 'offline' || !getConnected() ? 'offline' : 'live-learning';
    const tick = model.generate({ method: $('modelSelect')?.value || 'markov', mode });
    storeGenerated(tick);
    return tick;
  }
  function storeGenerated(tick) {
    const rows = generated.get(tick.symbol) || [];
    generated.set(tick.symbol, [...rows, tick].slice(-1000)); generatedTotal += 1;
    generatedWriteQueue.push(tick);
    if (!generatedWriteTimer) generatedWriteTimer = window.setTimeout(flushGenerated, 250);
    const now = Date.now();
    if (now - lastGeneratorRender >= 150) {
      lastGeneratorRender = now; renderGenerator(tick.symbol); renderStats(); renderExplorer(); renderDiagnostics();
    } else if (!generatorRenderTimer) {
      generatorRenderTimer = window.setTimeout(() => { generatorRenderTimer = 0; lastGeneratorRender = Date.now(); renderGenerator(tick.symbol); renderStats(); renderExplorer(); renderDiagnostics(); }, 150 - (now - lastGeneratorRender));
    }
  }
  async function flushGenerated() {
    clearTimeout(generatedWriteTimer); generatedWriteTimer = 0;
    const batch = generatedWriteQueue; generatedWriteQueue = [];
    if (!batch.length) return;
    try { await storage.appendGeneratedBatch(batch); }
    catch (error) { showStorage(`Could not persist ${batch.length} simulated ticks: ${error.message}`); }
    if (generatedWriteQueue.length && !generatedWriteTimer) generatedWriteTimer = window.setTimeout(flushGenerated, 250);
  }
  function initializeWorker(symbol) {
    const model = models.get(symbol); if (!generatorWorker || !model) return false;
    workerSymbol = symbol; workerReady = false;
    generatorWorker.postMessage({ type: 'INIT', snapshot: model.snapshot() }); return true;
  }

  function startGenerator() {
    if (started && !paused) return;
    started = true; paused = false; clearInterval(timer);
    const rate = Math.max(1, Math.min(100, Number($('generationRate')?.value) || 1));
    const symbol = $('generatorSymbol')?.value || getSelected();
    if (!models.get(symbol) || models.get(symbol).status !== 'READY') showGeneratorStatus(`WAITING FOR MODEL · ${symbol} needs at least 10 actual ticks`);
    if ($('generatorMode')?.value !== 'offline' && getConnected() && symbol !== getSelected()) onSelectSymbol?.(symbol);
    if (generatorWorker && workerSymbol !== symbol) initializeWorker(symbol);
    timer = window.setInterval(() => {
      const currentSymbol = $('generatorSymbol')?.value || getSelected(), options = { method: $('modelSelect')?.value || 'markov', mode: $('generatorMode')?.value === 'offline' || !getConnected() ? 'offline' : 'live-learning' };
      try {
        const activeModel = models.get(currentSymbol);
        if (!activeModel || activeModel.status !== 'READY') { showGeneratorStatus(`WAITING FOR MODEL · ${currentSymbol} needs at least 10 actual ticks`); return; }
        if (generatorWorker) {
          if (currentSymbol !== workerSymbol) { initializeWorker(currentSymbol); return; }
          if (!workerReady) return;
          if (workerBusy) {
            droppedGenerationRequests += 1;
            if (Date.now() - workerBusySince > 5000) {
              generatorWorker.terminate(); generatorWorker = null; workerBusy = false; workerReady = false;
              showGeneratorStatus('WORKER STALLED · switched to main-thread generation');
              makeGenerated(currentSymbol);
            }
            return;
          }
          workerBusy = true; workerBusySince = Date.now(); generatorWorker.postMessage({ type: 'TICK', options });
        } else makeGenerated(currentSymbol);
      } catch (error) { showGeneratorStatus(`WAITING · ${error.message}`); }
    }, 1000 / rate);
    showGeneratorStatus(getConnected() ? 'LIVE-LEARNING · MIMIC MODE' : 'OFFLINE SIMULATION · MIMIC MODE');
    logEvent({ type: 'generator_started', symbol: $('generatorSymbol')?.value || getSelected(), rate });
    renderAll();
  }
  function pauseGenerator() { if (!started || paused) return; clearInterval(timer); timer = 0; paused = true; showGeneratorStatus('PAUSED'); renderAll(); }
  function stopGenerator() { clearInterval(timer); timer = 0; started = false; paused = false; showGeneratorStatus('STOPPED'); renderAll(); }
  function resumeGenerator() { if (started && paused) startGenerator(); else startGenerator(); }
  function predictNext(symbol, method = 'markov') {
    const model = models.get(symbol), actual = trainingData.get(symbol) || getActualTicks(symbol) || [];
    if (!model || model.status !== 'READY' || actual.length < 10) throw new Error(`${symbol} needs at least 10 actual ticks before prediction.`);
    prepareLiveMimic(symbol, model, actual);
    const last = actual.at(-1), prediction = model.predictPath(1, {
      method, seed: (Date.now() ^ model.version) >>> 0 || 1,
      startQuote: String(last.quote), startDigit: Number.isInteger(last.digit) ? last.digit : finalDigit(last.quote),
    })[0];
    const output = { symbol, createdAt: Date.now(), observedQuote: last.quote, observedDigit: last.digit ?? finalDigit(last.quote), ...prediction };
    renderPrediction(symbol);
    return output;
  }

  function renderAll(force = false) {
    const now = performance.now();
    if (!force && now - lastRender < 180) { if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = 0; renderAll(true); }, 180); return; }
    lastRender = now;
    populateSymbolSelects(); renderSymbols(); renderStats(); renderBehavior(); renderLearning(); renderForecasts(); renderGenerator($('generatorSymbol')?.value || getSelected()); renderPrediction($('predictionSymbol')?.value || getSelected()); renderExplorer(); renderDiagnostics();
  }
  function populateSymbolSelects() {
    const symbols = getSymbols();
    for (const id of ['generatorSymbol', 'forecastSymbol', 'predictionSymbol', 'filterSymbol']) {
      const select = $(id); if (!select) continue;
      const value = select.value || getSelected();
      const first = id === 'filterSymbol' ? '<option value="">Selected market</option>' : '';
      select.innerHTML = first + symbols.map(s => `<option value="${esc(s.symbol)}">${esc(s.display_name || s.symbol)} · ${esc(s.symbol)}</option>`).join('');
      if (symbols.some(s => s.symbol === value)) select.value = value;
      else if (id !== 'filterSymbol' && symbols[0]) select.value = symbols[0].symbol;
    }
    const digit = $('filterDigit'); if (digit && digit.options.length < 11) for (let d = 0; d < 10; d += 1) digit.add(new Option(String(d), String(d)));
  }
  function renderStats() {
    const actual = getActualTicks(getSelected()) || [], gen = generated.get(getSelected()) || [];
    const model = models.get(getSelected()), score = forecasts.metrics(getSelected());
    if ($('generatedCount')) $('generatedCount').textContent = number(generatedTotal);
    if ($('explorerCount')) $('explorerCount').textContent = `${number(actual.length + gen.length)} visible records`;
    if ($('symbolManagerCount')) $('symbolManagerCount').textContent = `${getSymbols().length} per-symbol profiles`;
    renderOverview(actual, gen, model, score);
  }
  function renderOverview(actual, gen, model, score) {
    const latestActual = actual.at(-1), latestGenerated = gen.at(-1);
    $('overviewActualPrice').textContent = latestActual?.quote || '—'; $('overviewActualDigit').textContent = latestActual?.digit ?? finalDigit(latestActual?.quote) ?? '—';
    $('overviewGeneratedPrice').textContent = latestGenerated?.quote || '—'; $('overviewGeneratedDigit').textContent = latestGenerated?.digit ?? '—';
    $('overviewActualTime').textContent = latestActual ? `Market ${new Date(latestActual.epoch * 1000).toLocaleTimeString()} · received ${new Date(latestActual.arrival).toLocaleTimeString()} · ${getConnected() ? 'LIVE' : 'STALE / OFFLINE'}` : 'Waiting for Deriv tick data.';
    $('overviewGeneratedTime').textContent = latestGenerated ? `${new Date(latestGenerated.generatedAt).toLocaleTimeString()} · ${number(gen.length)} buffered · ${getConnected() && latestGenerated.mode === 'live-learning' ? 'LIVE-LEARNING' : 'OFFLINE SIMULATION'}` : `Generator stopped · ${number(generatedTotal)} persisted ticks`;
    drawSparkline('actualPriceChart', actual.slice(-80), '#48c995'); drawSparkline('generatedPriceChart', gen.slice(-80), '#aa8ddd');
    const readiness = model?.status || 'PENDING';
    $('overviewMetrics').innerHTML = metric('Model readiness', readiness) + metric('Training observations', number(model?.actualCount || 0)) + metric('Generated total', number(generatedTotal)) + metric('Next-digit accuracy', score?.digit?.percent === null ? '—' : `${score.digit.percent.toFixed(1)}%`) + metric('Evaluated / baseline', `${score?.digit?.samples || 0} / ${score?.baselineDigit?.percent === null ? '—' : `${score.baselineDigit.percent.toFixed(1)}%`}`) + metric('Connection', getConnected() ? 'CONNECTED' : 'OFFLINE');
  }
  function drawSparkline(id, ticks, color) {
    const svg = $(id), path = svg?.querySelector('path'); if (!path) return;
    const vals = ticks.map(t => Number(t.quote)).filter(Number.isFinite);
    if (!vals.length) { path.setAttribute('d', ''); return; }
    const lo = Math.min(...vals), hi = Math.max(...vals), range = hi - lo || 1;
    const d = vals.map((v, i) => `${i ? 'L' : 'M'}${(i * 600 / Math.max(1, vals.length - 1)).toFixed(1)},${(100 - (v - lo) / range * 90).toFixed(1)}`).join(' ');
    path.setAttribute('d', d); path.setAttribute('stroke', color); path.setAttribute('fill', 'none'); path.setAttribute('stroke-width', '2');
  }
  function renderSymbols() {
    const symbols = getSymbols(), rows = $('symbolManagerRows');
    if (!rows) return;
    rows.innerHTML = symbols.map(s => {
      const st = status.get(s.symbol) || {}, model = models.get(s.symbol), met = forecasts.metrics(s.symbol);
      return `<tr><td>${esc(s.symbol)} · ${esc(s.display_name || s.symbol)}</td><td>${getConnected() ? '<span class="actual-tag">CONNECTED</span>' : '<span class="sim-tag">OFFLINE</span>'}</td><td>${number(st.sampleCount || (getActualTicks(s.symbol) || []).length)}</td><td>${esc(model?.status || 'PENDING')}</td><td>v${number(model?.version || 0)}</td><td>${number(met.evaluatedPredictions)}</td><td>${model?.updatedAt ? new Date(model.updatedAt).toLocaleTimeString() : '—'}</td></tr>`;
    }).join('') || '<tr><td colspan="7" class="table-empty">Discovering symbols.</td></tr>';
    const box = $('symbolList'); if (box && symbols.length && !box.children.length) box.innerHTML = '';
  }
  function renderBehavior() {
    const symbol = getSelected(), actual = trainingData.get(symbol) || getActualTicks(symbol) || [];
    if (!actual.length) return;
    const profile = analyzeTicks(actual, settings.windows); profiles.set(symbol, profile);
    const max = Math.max(1, ...profile.counts);
    $('digitBars').innerHTML = profile.counts.map((n, d) => `<div class="digit-bar"><em>${profile.samples ? (n / profile.samples * 100).toFixed(1) : '0.0'}%</em><span style="height:${Math.max(2, n / max * 100)}%"></span><label>${d}</label></div>`).join('');
    $('featureSample').textContent = `${number(profile.samples)} actual observations · 0–4 under / 5–9 over`;
    $('transitionGrid').innerHTML = '<small>FROM/TO</small>' + Array.from({ length: 10 }, (_, d) => `<small>${d}</small>`).join('') + profile.transitionProbabilities.map((row, from) => `<small>${from}</small>${row.map((p, to) => `<span class="transition-cell" title="${from} to ${to}: ${p === null ? 'no samples' : percent(p)}" style="background:${p === null ? '#202730' : `rgba(69,198,147,${0.08 + p * 0.8})`}">${p === null ? '·' : Math.round(p * 100)}</span>`).join('')}`).join('');
    const rolling = profile.rolling.at(-1), last = actual.at(-1);
    $('movementMetrics').innerHTML = metric('Mean Δ', rolling?.meanChange) + metric('Std dev Δ', rolling?.volatility) + metric('Longest streak', `${profile.longestStreak.length} × ${profile.longestStreak.digit ?? '—'}`) + metric('Repeat rate', percent(profile.repeatedDigitRate)) + metric('Median interval', formatMs(profile.intervals.medianMs)) + metric('Last digit', last?.digit ?? finalDigit(last?.quote));
    const short = profile.rolling.find(x => x.window === 50), long = profile.rolling.find(x => x.window === 1000) || profile.rolling.at(-1);
    const drift = short && long ? jensenShannonDistance(short.digitProbabilities, long.digitProbabilities) : null;
    $('windowSummary').innerHTML = profile.rolling.map(item => `<div class="window-row"><span>${item.window}</span><div class="window-track"><i style="width:${Math.min(100, item.samples / item.window * 100)}%"></i></div><span>${item.samples} n</span></div>`).join('') + `<div class="metric-box"><span>Digit-distribution JS distance (50 vs long window)</span><b>${Number.isFinite(drift) ? drift.toFixed(3) : 'Insufficient samples'}</b></div>`;
  }
  function metric(label, value) { return `<div class="metric-box"><span>${esc(label)}</span><b>${typeof value === 'number' ? (Number.isFinite(value) ? value.toFixed(6) : '—') : esc(value ?? '—')}</b></div>`; }
  function renderLearning() {
    const symbols = getSymbols();
    $('modelReadiness').innerHTML = symbols.map(s => { const m = models.get(s.symbol), st = status.get(s.symbol) || {}, accuracy = forecasts.metrics(s.symbol); return `<div class="readiness-row"><span>${esc(s.symbol)} <small>${number(m?.actualCount || 0)} training ticks · v${m?.version || 0}</small></span><span>${m?.status || 'PENDING'}<small> · ${accuracy.evaluatedPredictions} evaluated</small></span></div>`; }).join('') || '<p class="empty-copy">Waiting for symbol discovery and actual observations.</p>';
    const metrics = forecasts.metrics(getSelected());
    $('accuracyMetrics').innerHTML = accuracyBox('Next-digit accuracy', metrics.digit, 'Observed outcomes only') + accuracyBox('Empirical baseline', metrics.baselineDigit, 'Frozen at issue time') + accuracyBox('Exact quote match', metrics.exactPrice, 'Exact displayed precision') + accuracyBox('Direction accuracy', metrics.direction, 'When actual movement known') + scoreBox('Mean Brier score', metrics.brierScore, metrics.brierSamples, 'Multiclass · lower is better') + scoreBox('Validation status', metrics.validationStatus, metrics.evaluatedPredictions, 'Only issued forecasts scored prospectively');
    const events = recentEventRows;
    $('modelEvents').innerHTML = events.map(event => `<div class="event-row"><span>${esc(event.type || 'event')}<small>${esc(event.symbol || 'global')}</small></span><small>${new Date(event.at).toLocaleTimeString()}</small></div>`).join('') || '<p class="empty-copy">Model updates and locked forecasts will appear here.</p>';
  }
  function accuracyBox(title, item, note) { const show = item?.percent !== null && Number.isFinite(item?.percent); const detail = item?.samples ? `${number(item.successes ?? 0)} / ${number(item.samples)} observations` : note; return `<div class="accuracy-box"><span>${esc(title)}</span><strong>${show ? `${item.percent.toFixed(1)}%` : '—'}</strong><small>${esc(detail)}</small></div>`; }
  function scoreBox(title, value, samples, note) { const shown = typeof value === 'string' ? value : Number.isFinite(value) ? value.toFixed(4) : '—'; return `<div class="accuracy-box"><span>${esc(title)}</span><strong>${esc(shown)}</strong><small>${number(samples)} samples · ${esc(note)}</small></div>`; }
  function renderForecasts() {
    const rows = forecasts.list();
    $('forecastSummary').textContent = `${number(rows.reduce((n, f) => n + f.evaluations.length, 0))} evaluated · ${rows.length} forecasts`;
    $('forecastList').innerHTML = rows.slice(0, 50).map(f => `<article class="forecast-card"><div class="forecast-head"><span>${esc(f.symbol)} · ${f.horizon} recursive steps · v${f.modelVersion}</span><small>${new Date(f.createdAt).toLocaleString()}</small></div><div class="forecast-predictions">${f.predictions.map((p, i) => { const actual = f.evaluations[i]; return `<span class="forecast-step">${i + 1}: <b>${esc(p.quote)}</b> · d${p.digit} · ${esc(p.direction)}${actual ? ` · ${actual.digitCorrect ? '✓' : '×'} actual ${esc(actual.actualQuote)}` : ''}</span>`; }).join('')}</div><div class="forecast-status">${esc(f.status)} · ${f.evaluations.length}/${f.horizon} evaluated · uncertainty is not calibrated${f.evaluations.length ? ` · exact ${f.evaluations.filter(e => e.exactPriceMatch).length}/${f.evaluations.length}` : ''}</div></article>`).join('') || '<p class="empty-copy">No forecasts yet. Issue one before new actual ticks arrive to begin prospective scoring.</p>';
  }
  function renderGenerator(symbol) {
    if (!$('generatedQuote')) return;
    const rows = generated.get(symbol) || [], latest = rows.at(-1), model = models.get(symbol);
    $('generatedQuote').textContent = latest?.quote || '—'; $('generatedTime').textContent = latest ? `${new Date(latest.generatedAt).toLocaleTimeString()} · d${latest.digit} · ${latest.direction} · ${latest.mode} · model v${latest.modelVersion}` : `Model ${model?.status || 'PENDING'} · ${number(model?.actualCount || 0)} actual training ticks`;
    $('generatedHistory').innerHTML = rows.slice(-18).reverse().map(t => `<span class="generated-chip">${esc(t.quote)}<small>d${t.digit}</small></span>`).join('');
    const actual = trainingData.get(symbol) || getActualTicks(symbol) || [];
    const actualFreq = Array(10).fill(0), generatedFreq = Array(10).fill(0);
    actual.slice(-1000).forEach(t => { const d = Number.isInteger(t.digit) ? t.digit : finalDigit(t.quote); if (Number.isInteger(d) && d >= 0 && d <= 9) actualFreq[d] += 1; });
    rows.slice(-1000).forEach(t => { if (Number.isInteger(t.digit) && t.digit >= 0 && t.digit <= 9) generatedFreq[t.digit] += 1; });
    const fidelity = $('mimicMetrics');
    if (fidelity) fidelity.innerHTML = metric('Actual sample', number(actualFreq.reduce((a, b) => a + b, 0))) + metric('Generated sample', number(generatedFreq.reduce((a, b) => a + b, 0))) + metric('Digit-distribution JS distance', fidelityValue(actualFreq, generatedFreq)) + metric('Generator mode', $('modelSelect')?.selectedOptions?.[0]?.textContent || 'Adaptive Markov');
    if (!started) showGeneratorStatus(paused ? 'PAUSED' : 'STOPPED · press Start to resume');
    else if (paused) showGeneratorStatus('PAUSED');
    else if (latest) showGeneratorStatus(`${getConnected() ? 'LIVE-LEARNING' : 'OFFLINE SIMULATION'} · ${latest.method === 'stress' ? 'PATTERN STRESS' : 'MIMIC'} · ${number(droppedGenerationRequests)} queued intervals skipped`);
    $('generatedCount').textContent = number(generatedTotal);
  }
  function renderPrediction(symbol) {
    const live = liveMimic.get(symbol), actual = trainingData.get(symbol)?.at(-1) || getActualTicks(symbol)?.at(-1), model = models.get(symbol);
    if (!$('predictionActual')) return;
    $('predictionActual').textContent = actual?.digit ?? finalDigit(actual?.quote) ?? '—';
    $('predictionActualQuote').textContent = actual?.quote || 'Waiting for live tick';
    $('predictionNextDigit').textContent = live?.path?.[0]?.digit ?? '—';
    $('predictionModelState').textContent = model ? `${model.status} · ${number(model.actualCount)} actual ticks · model v${model.version}` : 'Waiting for training data';
    const evaluated = live?.evaluated || 0, accuracy = evaluated ? live.correct / evaluated : null;
    $('predictionAccuracy').textContent = Number.isFinite(accuracy) ? `${(accuracy * 100).toFixed(1)}%` : '—';
    $('predictionSamples').textContent = `${number(evaluated)} scored next-tick predictions`;
    $('predictionOutcome').textContent = live?.lastOutcome ? `${live.lastOutcome.correct ? 'Correct digit' : 'Missed digit'} · actual ${live.lastOutcome.actualDigit} · predicted ${live.lastPrediction?.digit}` : 'Waiting for the next actual tick to score the first prediction';
    $('predictionPath').innerHTML = (live?.path || []).map((item, index) => `<span class="prediction-digit-chip ${index === 0 ? 'next' : ''}"><b>${item.digit}</b><small>+${index + 1}</small></span>`).join('') || '<span class="empty-copy">Need at least 10 actual ticks.</span>';
  }
  function renderExplorer() {
    if (!$('explorerRows')) return;
    const selected = getSelected(), symbol = $('filterSymbol')?.value || selected, source = $('filterSource')?.value || 'actual';
    const actual = source === 'generated' ? [] : (getActualTicks(symbol) || []), sim = source === 'actual' ? [] : (generated.get(symbol) || []);
    const digit = $('filterDigit')?.value || '', direction = $('filterDirection')?.value || '', query = ($('filterSearch')?.value || '').toLowerCase();
    const from = $('filterFrom')?.value ? new Date($('filterFrom').value).getTime() / 1000 : -Infinity;
    const to = $('filterTo')?.value ? new Date($('filterTo').value).getTime() / 1000 : Infinity;
    const prediction = ($('filterPrediction')?.value || '').toLowerCase();
    const rows = [...actual, ...sim].filter(t => Number(t.epoch) >= from && Number(t.epoch) <= to && (digit === '' || Number(t.digit) === Number(digit)) && (!direction || t.direction === direction) && (!prediction || String(t.predictionId || '').toLowerCase().includes(prediction)) && (!query || `${t.quote} ${t.id} ${t.predictionId || ''}`.toLowerCase().includes(query))).sort((a, b) => Number(b.epoch) - Number(a.epoch)).slice(0, 300);
    $('explorerRows').innerHTML = rows.map(t => `<tr><td>${new Date(Number(t.epoch) * 1000).toLocaleString()}</td><td>${esc(t.symbol)}</td><td><span class="${t.source === 'DERIV_ACTUAL' ? 'actual-tag' : 'sim-tag'}">${t.source === 'DERIV_ACTUAL' ? 'ACTUAL' : 'SIMULATED'}</span></td><td class="quote-cell">${esc(t.quote)}</td><td>${esc(t.digit)}</td><td>${esc(t.direction || '—')}</td><td>${esc(t.predictionId || '—')}</td></tr>`).join('') || '<tr><td colspan="7" class="table-empty">No records match these filters.</td></tr>';
  }
  function renderDiagnostics() {
    const ticks = getActualTicks(getSelected()) || [], latest = ticks.at(-1), latency = latest?.arrival ? Date.now() - latest.arrival : null;
    $('diagnostics').innerHTML = metric('Latest browser arrival age', formatMs(latency)) + metric('Actual buffered', number(ticks.length)) + metric('Generated buffered', number((generated.get(getSelected()) || []).length)) + metric('Feature calc', profiles.get(getSelected()) ? `${profiles.get(getSelected()).samples} samples` : 'Waiting') + metric('Model fit', formatMs(models.get(getSelected())?.trainingMs)) + metric('Forecasts evaluated', number(forecasts.metrics(getSelected()).evaluatedPredictions));
  }

  async function logEvent(event) {
    const item = { ...event, at: Date.now(), id: `evt:${Date.now()}:${Math.random().toString(36).slice(2, 8)}` };
    recentEventRows.unshift(item); recentEventRows = recentEventRows.slice(0, 100);
    try { await storage.addEvent(item); } catch { /* transient diagnostics may remain in memory */ }
    renderLearning();
  }
  function showStorage(text) { if ($('storageStatus')) $('storageStatus').textContent = text; }
  function showGeneratorStatus(text) { if ($('generatorState')) $('generatorState').textContent = text; }
  function download(filename, data) { const blob = new Blob([data], { type: 'application/json' }), url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  async function exportData(source) { await flushGenerated(); const data = await storage.exportData({ source }); download(`tick-intelligence-${source}-${new Date().toISOString().slice(0, 10)}.json`, data); }
  async function importData(file) { await flushGenerated(); const text = await file.text(); const result = await storage.importData(text); showStorage(`Imported ${number(result.actual)} actual, ${number(result.generated)} simulated ticks, ${number(result.models)} models, ${number(result.forecasts)} forecasts. Reloading to restore records.`); setTimeout(() => location.reload(), 800); }

  document.querySelectorAll('.workspace-tab').forEach(tab => tab.addEventListener('click', () => {
    document.querySelectorAll('.workspace-tab').forEach(item => item.classList.toggle('active', item === tab));
    document.querySelectorAll('.view-pane').forEach(pane => pane.classList.toggle('active', pane.id === `view-${tab.dataset.view}`));
    renderAll();
  }));
  $('startGenerator')?.addEventListener('click', startGenerator); $('pauseGenerator')?.addEventListener('click', () => paused ? resumeGenerator() : pauseGenerator()); $('stopGenerator')?.addEventListener('click', stopGenerator);
  $('generatorSymbol')?.addEventListener('change', e => { renderGenerator(e.target.value); if (started && generatorWorker) initializeWorker(e.target.value); }); $('generationRate')?.addEventListener('change', () => { if (started && !paused) { clearInterval(timer); timer = 0; started = false; startGenerator(); } });
  $('issueForecast')?.addEventListener('click', () => { try { issueForecast($('forecastSymbol').value || getSelected(), Number($('forecastHorizon').value), $('forecastModel').value === 'baseline' ? 'baseline' : 'markov'); } catch (error) { window.alert(error.message); } });
  $('predictNext')?.addEventListener('click', () => { try { predictNext($('predictionSymbol').value || getSelected(), $('predictionModel').value || 'markov'); } catch (error) { window.alert(error.message); } });
  $('predictionModel')?.addEventListener('change', () => { const symbol = $('predictionSymbol')?.value || getSelected(); const model = models.get(symbol); const actual = trainingData.get(symbol) || getActualTicks(symbol) || []; if (model) prepareLiveMimic(symbol, model, actual); renderPrediction(symbol); });
  $('predictionHorizon')?.addEventListener('change', () => { const symbol = $('predictionSymbol')?.value || getSelected(); const model = models.get(symbol); const actual = trainingData.get(symbol) || getActualTicks(symbol) || []; if (model) prepareLiveMimic(symbol, model, actual); renderPrediction(symbol); });
  $('predictionSymbol')?.addEventListener('change', event => renderPrediction(event.target.value));
  for (const id of ['filterSymbol', 'filterSource', 'filterDigit', 'filterDirection', 'filterSearch', 'filterFrom', 'filterTo', 'filterPrediction']) $(id)?.addEventListener('input', renderExplorer);
  $('saveSettings')?.addEventListener('click', async () => {
    const windows = $('rollingWindows').value.split(',').map(x => Number(x.trim())).filter(x => Number.isInteger(x) && x >= 10 && x <= 10000);
    if (!windows.length) { window.alert('Enter one or more valid windows (10–10,000).'); return; }
    settings.windows = [...new Set(windows)].sort((a, b) => a - b); settings.priorStrength = Math.max(0, Number($('modelPrior').value) || 0); saveSettings(settings);
    for (const symbol of getSymbols()) { const model = models.get(symbol.symbol); if (model) { model.priorStrength = settings.priorStrength; const data = trainingData.get(symbol.symbol) || getActualTicks(symbol.symbol); model.fit(data); profiles.set(symbol.symbol, analyzeTicks(data, settings.windows)); await storage.saveModel(symbol.symbol, model.snapshot()); } }
    renderAll();
  });
  $('resetModel')?.addEventListener('click', async () => {
    const symbol = getSelected(); if (!window.confirm(`Reset the saved model for ${symbol}? Actual data and issued forecasts will be retained.`)) return;
    const model = new LocalTickModel(symbol, { priorStrength: settings.priorStrength, windowSize: Math.max(...settings.windows) }); model.fit(trainingData.get(symbol) || getActualTicks(symbol)); models.set(symbol, model); await storage.saveModel(symbol, model.snapshot()); logEvent({ type: 'model_reset', symbol }); renderAll();
  });
  $('exportActual')?.addEventListener('click', () => exportData('actual').catch(e => showStorage(e.message)));
  $('exportGenerated')?.addEventListener('click', () => exportData('generated').catch(e => showStorage(e.message)));
  $('exportAll')?.addEventListener('click', () => exportData('all').catch(e => showStorage(e.message)));
  $('importState')?.addEventListener('change', event => { const file = event.target.files?.[0]; if (file) importData(file).catch(e => showStorage(`Import rejected: ${e.message}`)); event.target.value = ''; });
  $('symbolSelect')?.addEventListener('change', () => renderAll());
  window.addEventListener('online', renderAll); window.addEventListener('offline', renderAll);
  if ($('rollingWindows')) $('rollingWindows').value = settings.windows.join(','); if ($('modelPrior')) $('modelPrior').value = settings.priorStrength;
  initialize();

  return { initialize, registerSymbol, observeActual, renderAll, issueForecast, predictNext, startGenerator, pauseGenerator, stopGenerator, storage, getModel: symbol => models.get(symbol), getProfile: symbol => profiles.get(symbol), getGenerated: symbol => generated.get(symbol) || [], metrics: symbol => forecasts.metrics(symbol) };
}
function loadSettings() { try { const value = JSON.parse(localStorage.getItem('tick-intelligence.settings.v1') || '{}'); return { windows: Array.isArray(value.windows) ? value.windows : [50, 100, 250, 500, 1000], priorStrength: Number(value.priorStrength ?? 1), autoStartGenerator: value.autoStartGenerator !== false }; } catch { return { windows: [50, 100, 250, 500, 1000], priorStrength: 1, autoStartGenerator: true }; } }
function saveSettings(settings) { localStorage.setItem('tick-intelligence.settings.v1', JSON.stringify(settings)); }
function fidelityValue(actual, generated) {
  const normalize = values => { const total = values.reduce((a, b) => a + b, 0); return values.map(v => total ? v / total : 0); };
  const a = normalize(actual), b = normalize(generated); return generated.reduce((x, y) => x + y, 0) ? jensenShannonDistance(a, b)?.toFixed(3) ?? '—' : 'waiting for generated sample';
}
