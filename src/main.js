import { extractDigit, formatQuote, mapHistory, precisionFromPipSize, tickIdentity } from './tick-data.js';
import { createResearchWorkspace } from './engine/workspace.js';

// Current official public read-only market-data socket; no account login or app ID is needed.
const SOCKET_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';
const HISTORY_LIMIT = 1000;
const CONCURRENCY = 3;
const CACHE_DB = 'tick-intelligence.actual.v1';
const $ = id => document.getElementById(id);
const fmtCount = n => new Intl.NumberFormat().format(n);
const fmtTime = epoch => Number.isFinite(epoch) ? new Date(epoch * 1000).toLocaleString() : '—';
const state = {
  ws: null, request: 0, pending: new Map(), symbols: [], statuses: {}, selected: '', cacheDb: null,
  data: {}, subscription: null, busy: false, connected: false, retry: 0, reconnectTimer: 0,
  arrival: null, mounted: true, manualDisconnect: false, lastTicks: {}, lastStreamTickAt: {}, lastStreamMessageAt: 0,
  lastSubscribeAt: {}, receivedTickCount: 0, duplicateCount: 0, gapCount: 0, pingTimer: 0, healthTimer: 0,
};
const research = createResearchWorkspace({
  getActualTicks: symbol => state.data[symbol] || [],
  getSymbols: () => state.symbols,
  getConnected: () => state.connected,
  getSelected: () => state.selected,
  onSelectSymbol: symbol => { if (symbol && symbol !== state.selected) chooseSymbol(symbol); },
});

function openCache() {
  if (state.cacheDb) return state.cacheDb;
  state.cacheDb = new Promise((resolve, reject) => {
    const open = indexedDB.open(CACHE_DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('symbols', { keyPath: 'symbol' });
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error || new Error('IndexedDB could not be opened'));
  });
  return state.cacheDb;
}
async function restoreCache() {
  try {
    const db = await openCache();
    const records = await new Promise((resolve, reject) => {
      const request = db.transaction('symbols', 'readonly').objectStore('symbols').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    for (const entry of records) if (Array.isArray(entry.records)) state.data[entry.symbol] = entry.records.slice(-HISTORY_LIMIT);
  } catch (error) {
    console.warn('IndexedDB tick cache could not be restored.', error);
  }
}
async function persistCache(symbol) {
  if (!symbol || !state.data[symbol]) return;
  try {
    const db = await openCache();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('symbols', 'readwrite');
      transaction.objectStore('symbols').put({ symbol, records: state.data[symbol].slice(-HISTORY_LIMIT) });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB write aborted'));
    });
  } catch (error) { console.warn('Tick history cache could not be saved.', error); }
}
function setStatus(text) { $('statusMessage').textContent = text; }
function setConnection(status, label) {
  state.connected = status === 'connected';
  $('connectionDot').className = `connection-dot ${status}`;
  $('connectionLabel').textContent = label;
  $('refreshHistory').disabled = !state.connected || state.busy || !state.symbols.length;
  research.renderAll();
}
function request(payload, timeout = 20000) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('WebSocket is not connected'));
  const req_id = ++state.request;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => { state.pending.delete(req_id); reject(new Error('Deriv request timed out')); }, timeout);
    state.pending.set(req_id, { resolve, reject, timer });
    try { state.ws.send(JSON.stringify({ ...payload, req_id })); }
    catch (error) { clearTimeout(timer); state.pending.delete(req_id); reject(error); }
  });
}
function onMessage(event) {
  let message;
  try { message = JSON.parse(event.data); } catch { return; }
  state.lastStreamMessageAt = Date.now();
  if (message.req_id && state.pending.has(message.req_id)) {
    const task = state.pending.get(message.req_id);
    clearTimeout(task.timer);
    state.pending.delete(message.req_id);
    if (message.error) task.reject(new Error(message.error.message || message.error.code || 'Deriv API error'));
    else task.resolve(message);
  }
  if (message.msg_type === 'tick' && message.tick) addLiveTick(message.tick, message.subscription?.id);
  if (message.error && !message.req_id) setStatus(message.error.message || 'A live stream error occurred.');
}
function connect() {
  clearTimeout(state.reconnectTimer);
  if (state.ws && (state.ws.readyState === WebSocket.CONNECTING || state.ws.readyState === WebSocket.OPEN)) return;
  setConnection('connecting', 'CONNECTING');
  setStatus('Opening Deriv public market-data connection…');
  const ws = new WebSocket(SOCKET_URL);
  state.ws = ws;
  ws.addEventListener('open', async () => {
    state.manualDisconnect = false;
    state.retry = 0;
    setConnection('connected', 'CONNECTED');
    clearInterval(state.pingTimer);
    state.pingTimer = window.setInterval(() => {
      if (state.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      request({ ping: 1 }, 12000).catch(error => {
        if (state.ws === ws) { setStatus(`Deriv keepalive failed: ${error.message}; reconnecting…`); ws.close(); }
      });
    }, 25000);
    setStatus('Connected. Discovering active markets…');
    try {
      const response = await request({ active_symbols: 'full' });
      state.symbols = (response.active_symbols || []).map(item => ({
        ...item,
        symbol: item.symbol || item.underlying_symbol,
        display_name: item.display_name || item.underlying_symbol_name || item.symbol || item.underlying_symbol,
      })).filter(item => item.symbol);
      if (!state.symbols.length) throw new Error('Deriv returned no active symbols.');
      for (const symbol of state.symbols) {
        if (state.data[symbol.symbol]) {
          state.data[symbol.symbol] = state.data[symbol.symbol].map(tick => {
            const quote = formatQuote(tick.quote, precisionFromPipSize(symbol.pip_size));
            return { ...tick, quote, digit: extractDigit(quote) };
          }).slice(-HISTORY_LIMIT);
          persistCache(symbol.symbol);
        }
        const count = (state.data[symbol.symbol] || []).length;
        state.statuses[symbol.symbol] = { loaded: count, status: count >= HISTORY_LIMIT ? 'ready' : 'queued' };
      }
      $('statSymbols').textContent = fmtCount(state.symbols.length);
      $('statTotal').textContent = fmtCount(state.symbols.length);
      $('symbolSelect').innerHTML = '<option value="">Choose market…</option>' + state.symbols.map(s => `<option value="${escapeHtml(s.symbol)}">${escapeHtml(s.display_name || s.symbol)} · ${escapeHtml(s.symbol)}</option>`).join('');
      if (!state.selected) state.selected = state.symbols.find(s => s.symbol === '1HZ100V')?.symbol || state.symbols.find(s => s.symbol === 'R_100')?.symbol || state.symbols[0].symbol;
      $('symbolSelect').value = state.selected;
      renderSymbols(); renderStats();
      chooseSymbol(state.selected);
      await Promise.all(state.symbols.map(symbol => research.registerSymbol(symbol.symbol, state.data[symbol.symbol] || [])));
      renderSymbols(); renderStats();
      setStatus(`${state.symbols.length} active symbols discovered. Loading up to ${fmtCount(HISTORY_LIMIT)} historical ticks per symbol.`);
      hydrateHistory();
    } catch (error) { setStatus(error.message); setConnection('error', 'API ERROR'); }
  });
  ws.addEventListener('message', onMessage);
  ws.addEventListener('error', () => { if (state.ws === ws) { setConnection('error', 'CONNECTION ERROR'); setStatus('WebSocket error. Check network connectivity and reconnect.'); } });
  ws.addEventListener('close', () => {
    if (state.ws !== ws || !state.mounted) return;
    setConnection('disconnected', 'DISCONNECTED');
    setStatus('Connection closed. Cached actual history remains available; live observations are paused.');
    state.subscription = null;
    state.pending.forEach(item => { clearTimeout(item.timer); item.reject(new Error('WebSocket disconnected')); });
      state.pending.clear();
    clearInterval(state.pingTimer); state.pingTimer = 0;
    if (state.manualDisconnect) return;
    scheduleReconnect();
  });
}
function scheduleReconnect() {
  if (!state.mounted || state.reconnectTimer) return;
  const delay = Math.min(30000, 1000 * (2 ** Math.min(state.retry++, 5)));
  state.reconnectTimer = window.setTimeout(() => { state.reconnectTimer = 0; connect(); }, delay);
}
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
function renderSymbols() {
  const list = $('symbolList');
  if (!state.symbols.length) return;
  list.innerHTML = state.symbols.map(item => {
    const s = state.statuses[item.symbol] || { loaded: 0, status: 'queued' };
    const label = s.status === 'ready' ? 'READY' : s.status === 'loading' ? 'LOADING' : s.status === 'error' ? 'ERROR' : 'QUEUED';
    return `<button class="symbol-row ${item.symbol === state.selected ? 'selected' : ''}" data-symbol="${escapeHtml(item.symbol)}"><span class="symbol-badge">${escapeHtml((item.display_name || item.symbol).slice(0, 1))}</span><span class="symbol-info"><b>${escapeHtml(item.display_name || item.symbol)}</b><small>${escapeHtml(item.symbol)} · ${escapeHtml(item.market_display_name || item.market || 'Market')}${item.submarket_display_name ? ` / ${escapeHtml(item.submarket_display_name)}` : ''}</small></span><span class="symbol-status ${s.status}"><b>${label}</b><small>${fmtCount(s.loaded)} / ${fmtCount(HISTORY_LIMIT)}</small></span></button>`;
  }).join('');
  list.querySelectorAll('[data-symbol]').forEach(button => button.addEventListener('click', () => chooseSymbol(button.dataset.symbol)));
  $('universeSummary').textContent = `${state.symbols.length} symbols · ${Object.values(state.statuses).filter(s => s.status === 'ready').length} initialized`;
}
function renderStats() {
  const total = Object.values(state.data).reduce((n, records) => n + records.length, 0);
  const ready = Object.values(state.statuses).filter(s => s.status === 'ready').length;
  const percent = state.symbols.length ? Math.round(ready * 100 / state.symbols.length) : 0;
  $('statTicks').textContent = fmtCount(total);
  $('statReady').textContent = fmtCount(ready);
  $('statTotal').textContent = fmtCount(state.symbols.length);
  $('progressFill').style.width = `${percent}%`;
  $('progressText').textContent = `${ready} of ${state.symbols.length} symbol histories ready`;
  $('progressPercent').textContent = `${percent}%`;
  $('universeSummary').textContent = state.symbols.length ? `${state.symbols.length} symbols · ${ready} initialized` : 'Discovering available markets…';
  $('refreshHistory').disabled = !state.connected || state.busy || !state.symbols.length;
}
async function hydrateHistory() {
  if (!state.symbols.length || !state.connected || state.busy) return;
  state.busy = true;
  const queue = state.symbols.filter(item => (state.data[item.symbol] || []).length < HISTORY_LIMIT);
  for (const item of queue) state.statuses[item.symbol] = { loaded: (state.data[item.symbol] || []).length, status: 'queued' };
  renderSymbols(); renderStats();
  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length && state.connected) {
      const symbol = queue[cursor++];
      const priorCount = (state.data[symbol.symbol] || []).length;
      state.statuses[symbol.symbol] = { loaded: priorCount, status: 'loading' };
      renderSymbols();
      try {
        const response = await request({ ticks_history: symbol.symbol, style: 'ticks', count: HISTORY_LIMIT, end: 'latest' });
        const records = mapHistory(symbol.symbol, response.history?.prices || [], response.history?.times || [], precisionFromPipSize(symbol.pip_size));
        const live = (state.data[symbol.symbol] || []).filter(t => !records.some(h => h.epoch === t.epoch && h.quote === t.quote));
        state.data[symbol.symbol] = [...records, ...live].sort((a, b) => a.epoch - b.epoch).slice(-HISTORY_LIMIT);
        state.statuses[symbol.symbol] = { loaded: state.data[symbol.symbol].length, status: 'ready' };
        persistCache(symbol.symbol);
        await research.registerSymbol(symbol.symbol, state.data[symbol.symbol]);
        if (symbol.symbol === state.selected) renderSelected();
      } catch (error) {
        state.statuses[symbol.symbol] = { loaded: (state.data[symbol.symbol] || []).length, status: 'error', error: error.message };
      }
      renderSymbols(); renderStats();
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  state.busy = false;
  renderSymbols(); renderStats();
  if (state.connected) setStatus('History initialization finished. Data readiness is separate from any future model validation.');
}
function chooseSymbol(symbol) {
  if (!symbol) return;
  if (state.subscription && state.ws?.readyState === WebSocket.OPEN) {
    try { state.ws.send(JSON.stringify({ forget: state.subscription })); } catch { /* reconnect will restore stream */ }
  }
  state.subscription = null;
  state.selected = symbol;
  $('symbolSelect').value = symbol;
  const generatorSelect = $('generatorSymbol');
  if (generatorSelect && generatorSelect.value !== symbol) {
    generatorSelect.value = symbol;
    generatorSelect.dispatchEvent(new Event('change'));
  }
  $('selectedName').textContent = state.symbols.find(s => s.symbol === symbol)?.display_name || symbol;
  $('recordsTitle').textContent = `${state.symbols.find(s => s.symbol === symbol)?.display_name || symbol} · recent quotes`;
  renderSymbols(); renderSelected();
  research.renderAll();
  if (state.ws?.readyState === WebSocket.OPEN) subscribe(symbol);
}
async function subscribe(symbol) {
  state.lastSubscribeAt[symbol] = Date.now();
  try {
    const response = await request({ ticks: symbol, subscribe: 1 });
    if (symbol !== state.selected) {
      const old = response.subscription?.id;
      if (old && state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ forget: old }));
      return;
    }
    if (!response.subscription?.id) throw new Error('Deriv did not confirm a live tick subscription.');
    state.subscription = response.subscription.id;
    state.lastSubscribeAt[symbol] = Date.now();
    if (!response.tick) setStatus(`Subscribed to ${symbol}; waiting for the next live tick.`);
  } catch (error) {
    if (symbol === state.selected) setStatus(`Live tick subscription failed: ${error.message}`);
  }
}
function addLiveTick(raw, subscriptionId) {
  const symbol = raw.symbol;
  if (subscriptionId && symbol === state.selected) state.subscription = subscriptionId;
  const symbolInfo = state.symbols.find(s => s.symbol === symbol);
  // Tick messages expose pip_size as decimal places (e.g. 2); active_symbols
  // exposes pip_size as the minimum price increment (e.g. 0.01).
  const precision = Number.isInteger(raw.pip_size) && raw.pip_size >= 0
    ? Number(raw.pip_size)
    : precisionFromPipSize(symbolInfo?.pip_size);
  const quote = formatQuote(raw.quote, precision);
  const epoch = Number(raw.epoch);
  const records = state.data[symbol] || [];
  const previous = state.lastTicks[symbol] || records.at(-1);
  // Deriv can return the subscription id in tick.id. It is not a unique
  // observation id, so never use it alone to deduplicate a live stream.
  const identity = tickIdentity(symbol, epoch, quote);
  const duplicate = previous?.identity === identity || (previous?.epoch === epoch && previous?.quote === quote);
  if (duplicate) { state.duplicateCount += 1; return; }
  const arrival = Date.now();
  const delta = previous ? decimalDifference(quote, previous.quote) : null;
  const direction = delta === null || Number(delta) === 0 ? 'UNCHANGED' : Number(delta) > 0 ? 'UP' : 'DOWN';
  const intervalMs = previous ? Math.max(0, (epoch - previous.epoch) * 1000) : null;
  const medianInterval = research.getProfile(symbol)?.intervals?.medianMs;
  if (intervalMs && intervalMs > Math.max(5000, (medianInterval || 0) * 3)) state.gapCount += 1;
  const tick = { symbol, source: 'DERIV_ACTUAL', quote, epoch, arrival, digit: extractDigit(quote), id: identity, identity, derivId: raw.id || null,
    numericPrice: Number(quote), previousQuote: previous?.quote ?? null, priceDifference: delta, direction, intervalMs,
    sequence: (state.tickSequence?.[symbol] || records.length) + 1, modelVersion: research.getModel(symbol)?.version ?? null };
  state.tickSequence ||= {}; state.tickSequence[symbol] = tick.sequence; state.lastTicks[symbol] = tick;
  state.data[symbol] = [...records, tick].slice(-HISTORY_LIMIT);
  if (state.statuses[symbol]) state.statuses[symbol] = { loaded: state.data[symbol].length, status: state.statuses[symbol].status === 'ready' ? 'ready' : 'loading' };
  state.arrival = Date.now();
  state.lastStreamTickAt[symbol] = state.arrival; state.receivedTickCount += 1;
  $('statArrival').textContent = new Date(state.arrival).toLocaleTimeString();
  persistCache(symbol);
  if (symbol === state.selected) renderSelected();
  renderStats();
  research.observeActual(tick, state.data[symbol]).catch(error => console.warn('Research update failed.', error));
}
function decimalDifference(current, previous) {
  if (!previous || !/^-?\d+(?:\.\d+)?$/.test(String(current)) || !/^-?\d+(?:\.\d+)?$/.test(String(previous))) return null;
  const places = Math.max((String(current).split('.')[1] || '').length, (String(previous).split('.')[1] || '').length);
  const toUnits = text => { const [whole, fraction = ''] = String(text).split('.'); return BigInt(`${whole}${fraction.padEnd(places, '0')}`); };
  const difference = toUnits(current) - toUnits(previous), negative = difference < 0n, absolute = negative ? -difference : difference, base = 10n ** BigInt(places);
  return `${negative ? '-' : ''}${absolute / base}${places ? `.${String(absolute % base).padStart(places, '0')}` : ''}`;
}
function renderSelected() {
  const records = state.data[state.selected] || [];
  const latest = records.at(-1);
  const lastLiveAt = state.lastStreamTickAt[state.selected];
  const liveAge = lastLiveAt ? Date.now() - lastLiveAt : Infinity;
  const marketFresh = state.connected && liveAge < 30000;
  $('recordCount').textContent = `${fmtCount(records.length)} records`;
  $('latestQuote').textContent = latest?.quote || '—';
  $('latestDigit').textContent = Number.isInteger(latest?.digit) ? latest.digit : '—';
  $('quoteTime').textContent = latest ? `${fmtTime(latest.epoch)} · ${latest.epoch} epoch` : 'Waiting for tick data';
  $('streamTitle').textContent = marketFresh ? 'Live ticks arriving' : state.connected ? 'Socket connected · tick stream stale' : 'Live stream unavailable';
  $('streamDetail').textContent = latest ? `Market ${new Date(latest.epoch * 1000).toLocaleTimeString()} · received ${new Date(latest.arrival).toLocaleTimeString()} · ${lastLiveAt ? `last stream tick ${Math.round(liveAge / 1000)}s ago` : 'no live tick received this session'}` : 'Historical observations and live updates remain distinct.';
  $('streamPulse').classList.toggle('active', marketFresh);
  const rows = records.slice(-30).reverse();
  $('tickRows').innerHTML = rows.length ? rows.map(t => `<tr><td class="quote-cell">${escapeHtml(t.quote)}</td><td><span class="digit-chip">${t.digit}</span></td><td>${escapeHtml(fmtTime(t.epoch))}</td><td>${escapeHtml(new Date(t.arrival).toLocaleTimeString())}</td><td><span class="actual-tag"><i></i> DERIV ACTUAL</span></td></tr>`).join('') : '<tr><td class="table-empty" colspan="5">No records loaded for the selected symbol.</td></tr>';
}
$('symbolSelect').addEventListener('change', event => chooseSymbol(event.target.value));
$('refreshHistory').addEventListener('click', hydrateHistory);
$('reconnectBtn').addEventListener('click', () => { if (state.ws && state.ws.readyState !== WebSocket.CLOSED) state.ws.close(); state.retry = 0; window.setTimeout(connect, 50); });
$('disconnectBtn').addEventListener('click', () => {
  state.manualDisconnect = true;
  clearTimeout(state.reconnectTimer); state.reconnectTimer = 0;
  if (state.ws && state.ws.readyState !== WebSocket.CLOSED) state.ws.close();
  setConnection('disconnected', 'OFFLINE');
  setStatus('Disconnected by user. Local simulation can continue offline; no fresh Deriv ticks are arriving.');
  research.renderAll();
});
window.setInterval(() => { $('clock').textContent = `${new Date().toISOString().slice(11, 19)} UTC`; }, 1000);
state.healthTimer = window.setInterval(() => {
  if (!state.connected || !state.ws || state.ws.readyState !== WebSocket.OPEN || !state.selected) return;
  const symbol = state.selected, profile = research.getProfile(symbol);
  const median = Number(profile?.intervals?.medianMs) || 1000;
  const staleAfter = Math.max(20000, Math.min(90000, median * 8));
  const last = state.lastStreamTickAt[symbol] || state.lastSubscribeAt[symbol] || 0;
  if (!state.lastStreamTickAt[symbol] || Date.now() - state.lastStreamTickAt[symbol] >= 30000) renderSelected();
  if (last && Date.now() - last > staleAfter && Date.now() - (state.lastSubscribeAt[symbol] || 0) > staleAfter) {
    setStatus(`No Deriv ticks for ${Math.round((Date.now() - last) / 1000)}s on ${symbol}; refreshing subscription…`);
    if (state.subscription) { try { state.ws.send(JSON.stringify({ forget: state.subscription })); } catch { /* retry below */ } }
    state.subscription = null;
    subscribe(symbol);
  }
  if (Date.now() - state.lastStreamMessageAt > 65000) {
    setStatus('No Deriv WebSocket messages for 65s; reconnecting to restore live data…');
    state.ws.close();
  }
}, 5000);
window.addEventListener('beforeunload', () => { state.mounted = false; clearTimeout(state.reconnectTimer); if (state.subscription && state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ forget: state.subscription })); state.ws?.close(); });
setConnection('connecting', 'CONNECTING');
restoreCache().finally(connect);
