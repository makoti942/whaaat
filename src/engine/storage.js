const DB_NAME = 'tick-intelligence.research.v1';
const DB_VERSION = 1;
const STORE_LIMIT = 10000;
const STORE_NAMES = ['actualTicks', 'generatedTicks', 'models', 'forecasts', 'evaluations', 'events'];

export class ResearchStorage {
  constructor() { this.dbPromise = null; }
  open() {
    if (!globalThis.indexedDB) return Promise.reject(new Error('IndexedDB is unavailable in this browser.'));
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of STORE_NAMES) {
          if (!db.objectStoreNames.contains(name)) {
            const store = db.createObjectStore(name, { keyPath: 'key' });
            store.createIndex('symbol', 'symbol', { unique: false });
            if (name === 'actualTicks' || name === 'generatedTicks') store.createIndex('epoch', 'record.epoch', { unique: false });
          }
        }
      };
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
      request.onerror = () => reject(request.error || new Error('Could not open persistent research storage.'));
      request.onblocked = () => reject(new Error('Storage upgrade is blocked by another open tab.'));
    });
    return this.dbPromise;
  }
  async #write(storeName, entries) {
    const db = await this.open();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite'), store = tx.objectStore(storeName);
      for (const entry of entries) store.put(entry);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted.'));
    });
  }
  async appendActual(tick) { validateTick(tick, 'DERIV_ACTUAL'); await this.#write('actualTicks', [{ key: recordKey(tick), symbol: tick.symbol, record: tick }]); await this.trim('actualTicks', tick.symbol); }
  async appendActualBatch(ticks) { const rows = ticks.filter(t => validTick(t, 'DERIV_ACTUAL')); await this.#write('actualTicks', rows.map(t => ({ key: recordKey(t), symbol: t.symbol, record: t }))); for (const symbol of new Set(rows.map(t => t.symbol))) await this.trim('actualTicks', symbol); }
  async appendGenerated(tick) { validateTick(tick, 'LOCAL_GENERATED'); await this.#write('generatedTicks', [{ key: recordKey(tick), symbol: tick.symbol, record: tick }]); await this.trim('generatedTicks', tick.symbol); }
  async appendGeneratedBatch(ticks) { const rows = ticks.filter(t => validTick(t, 'LOCAL_GENERATED')); for (const t of rows) validateTick(t, 'LOCAL_GENERATED'); await this.#write('generatedTicks', rows.map(t => ({ key: recordKey(t), symbol: t.symbol, record: t }))); for (const symbol of new Set(rows.map(t => t.symbol))) await this.trim('generatedTicks', symbol); }
  async loadTicks(source, symbol, limit = STORE_LIMIT) { const store = source === 'DERIV_ACTUAL' || source === 'actual' ? 'actualTicks' : 'generatedTicks'; return (await this.#bySymbol(store, symbol)).map(x => x.record).filter(Boolean).sort((a, b) => Number(a.epoch) - Number(b.epoch)).slice(-clampLimit(limit)); }
  async #bySymbol(storeName, symbol) { const db = await this.open(); return requestResult(db.transaction(storeName, 'readonly').objectStore(storeName).index('symbol').getAll(IDBKeyRange.only(symbol))); }
  async trim(storeName, symbol, limit = STORE_LIMIT) { const rows = (await this.#bySymbol(storeName, symbol)).sort((a, b) => Number(a.record?.epoch) - Number(b.record?.epoch)); if (rows.length > limit) { const excess = rows.slice(0, rows.length - limit); const tx = await this._dbTransaction(storeName, 'readwrite'); await new Promise((resolve, reject) => { for (const row of excess) tx.objectStore(storeName).delete(row.key); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); } }
  async saveModel(symbol, snapshot) { if (!symbol || snapshot?.symbol !== symbol) throw new Error('Model symbol mismatch.'); await this.#write('models', [{ key: symbol, symbol, snapshot, updatedAt: Date.now() }]); }
  async loadModel(symbol) { const db = await this.open(); const row = await requestResult(db.transaction('models', 'readonly').objectStore('models').get(symbol)); return row?.snapshot || null; }
  async listModels() { return (await this.#all('models')).map(x => x.snapshot); }
  async deleteModel(symbol) { const db = await this.open(); return new Promise((resolve, reject) => { const tx = db.transaction('models', 'readwrite'); tx.objectStore('models').delete(symbol); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); }
  async saveForecast(forecast) { if (forecast?.source !== 'LOCAL_PREDICTED' || !forecast.id || !forecast.symbol || !Array.isArray(forecast.predictions)) throw new Error('Invalid locked forecast.'); await this.#write('forecasts', [{ key: forecast.id, symbol: forecast.symbol, forecast, createdAt: forecast.createdAt }]); }
  async listForecasts(symbol = null) { const rows = symbol ? await this.#bySymbol('forecasts', symbol) : await this.#all('forecasts'); return rows.map(x => x.forecast).filter(Boolean).sort((a, b) => b.createdAt - a.createdAt); }
  async saveEvaluation(result) { if (!result?.forecastId || !result.symbol || !result.actualTickId) throw new Error('Invalid forecast evaluation.'); const id = `${result.forecastId}:${result.horizonStep}`; await this.#write('evaluations', [{ key: id, symbol: result.symbol, result }]); }
  async listEvaluations(symbol = null) { const rows = symbol ? await this.#bySymbol('evaluations', symbol) : await this.#all('evaluations'); return rows.map(x => x.result).filter(Boolean); }
  async addEvent(event) { const row = { ...event, key: event.id || `event:${Date.now()}:${Math.random()}`, symbol: event.symbol || '_global', at: event.at || Date.now() }; await this.#write('events', [row]); return row; }
  async listEvents(symbol = null, limit = 500) { const rows = symbol ? await this.#bySymbol('events', symbol) : await this.#all('events'); return rows.sort((a, b) => b.at - a.at).slice(0, clampLimit(limit)); }
  async counts() { const db = await this.open(); const counts = {}; await Promise.all(STORE_NAMES.map(async name => { counts[name] = await requestResult(db.transaction(name, 'readonly').objectStore(name).count()); })); return counts; }
  async exportData({ source = 'all' } = {}) {
    const actualTicks = source === 'generated' ? [] : (await this.#all('actualTicks')).map(x => x.record);
    const generatedTicks = source === 'actual' ? [] : (await this.#all('generatedTicks')).map(x => x.record);
    const data = { app: 'Deriv Tick Intelligence', schemaVersion: 1, exportedAt: new Date().toISOString(), actualTicks, generatedTicks,
      models: source === 'actual' || source === 'generated' ? [] : (await this.listModels()),
      forecasts: source === 'actual' || source === 'generated' ? [] : (await this.listForecasts()),
      evaluations: source === 'actual' || source === 'generated' ? [] : (await this.listEvaluations()),
      events: source === 'actual' || source === 'generated' ? [] : (await this.listEvents(null, 10000)) };
    if (source === 'actual') { data.generatedTicks = []; data.models = []; data.forecasts = []; data.evaluations = []; data.events = []; }
    if (source === 'generated') { data.models = []; data.forecasts = []; data.evaluations = []; data.events = []; }
    return JSON.stringify(data, null, 2);
  }
  async importData(text, { replace = false } = {}) {
    const data = typeof text === 'string' ? JSON.parse(text) : text;
    if (!data || data.app !== 'Deriv Tick Intelligence' || data.schemaVersion !== 1) throw new Error('Unsupported export file or schema version.');
    const actual = requireArray(data.actualTicks, x => validTick(x, 'DERIV_ACTUAL'), 'actualTicks');
    const generated = requireArray(data.generatedTicks, x => validTick(x, 'LOCAL_GENERATED'), 'generatedTicks');
    const models = requireArray(data.models || [], x => x?.symbol && x.schema === 1, 'models');
    const forecasts = requireArray(data.forecasts || [], x => x?.source === 'LOCAL_PREDICTED' && x.id && Array.isArray(x.predictions), 'forecasts');
    const evaluations = requireArray(data.evaluations || [], x => x?.forecastId && x?.symbol && x?.actualTickId, 'evaluations');
    if (replace) { const db = await this.open(); await Promise.all(STORE_NAMES.map(name => new Promise((resolve, reject) => { const tx = db.transaction(name, 'readwrite'); tx.objectStore(name).clear(); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }))); }
    await this.appendActualBatch(actual); await this.appendGeneratedBatch(generated);
    for (const model of models) await this.saveModel(model.symbol, model);
    for (const forecast of forecasts) await this.saveForecast(forecast);
    for (const item of evaluations) await this.saveEvaluation(item);
    for (const event of data.events || []) if (event && typeof event === 'object') await this.addEvent(event);
    return { actual: actual.length, generated: generated.length, models: models.length, forecasts: forecasts.length, evaluations: evaluations.length };
  }
  async #all(storeName) { const db = await this.open(); return requestResult(db.transaction(storeName, 'readonly').objectStore(storeName).getAll()); }
  async _dbTransaction(storeName, mode) { const db = await this.open(); return db.transaction(storeName, mode); }
}
function requestResult(request) { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
function recordKey(tick) { return `${tick.symbol}:${tick.id ?? tick.epoch}:${tick.source}`; }
function validTick(t, source) { return !!t && t.source === source && typeof t.symbol === 'string' && typeof t.quote === 'string' && /^-?\d+(?:\.\d+)?$/.test(t.quote) && Number.isFinite(Number(t.epoch)) && Number.isInteger(t.digit) && t.digit >= 0 && t.digit <= 9; }
function validateTick(tick, source) { if (!validTick(tick, source)) throw new Error(`Invalid ${source} tick record.`); }
function requireArray(value, predicate, name) { if (!Array.isArray(value) || value.some(item => !predicate(item))) throw new Error(`Import rejected: invalid ${name} records or source mix.`); return value; }
function clampLimit(n) { return Math.max(1, Math.min(STORE_LIMIT, Number(n) || STORE_LIMIT)); }
