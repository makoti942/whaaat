import { LocalTickModel } from './model.js';

let model = null;
self.addEventListener('message', event => {
  const { type, snapshot, options } = event.data || {};
  try {
    if (type === 'INIT' || type === 'UPDATE') {
      if (!snapshot?.symbol) throw new Error('Worker model snapshot is missing a symbol.');
      model = new LocalTickModel(snapshot.symbol).restore(snapshot);
      self.postMessage({ type: 'READY', symbol: model.symbol, version: model.version });
      return;
    }
    if (type === 'TICK') {
      if (!model) throw new Error('Generator worker is not initialized.');
      const tick = model.generate(options || {});
      self.postMessage({ type: 'TICK_RESULT', tick, snapshot: model.snapshot() });
    }
  } catch (error) { self.postMessage({ type: 'ERROR', message: error.message || 'Generator worker failed.' }); }
});
