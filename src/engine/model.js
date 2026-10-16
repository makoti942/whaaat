import { extractDigit, formatQuote } from '../tick-data.js';

const MAX_HISTORY = 10000;
const isActual = tick => tick?.source === 'DERIV_ACTUAL' && /^-?\d+(?:\.\d+)?$/.test(String(tick.quote)) && Number.isFinite(Number(tick.epoch));
const places = q => (String(q).split('.')[1] || '').length;
function units(q, scale) { const [whole, fraction = ''] = String(q).split('.'); return BigInt(`${whole}${fraction.padEnd(scale, '0').slice(0, scale)}`); }
function decimal(value, scale) { const neg = value < 0n, n = neg ? -value : value, base = 10n ** BigInt(scale); return `${neg ? '-' : ''}${n / base}${scale ? `.${String(n % base).padStart(scale, '0')}` : ''}`; }
function weighted(values, rng) {
  const sum = values.reduce((s, x) => s + x.weight, 0);
  if (!sum) return values[0]?.value;
  let r = rng() * sum;
  for (const item of values) { r -= item.weight; if (r <= 0) return item.value; }
  return values.at(-1)?.value;
}
const uniform = n => Array.from({ length: n }, () => 1 / n);

/** A browser-local per-symbol model. Only actual source records may fit parameters. */
export class LocalTickModel {
  constructor(symbol, options = {}) {
    this.symbol = symbol; this.priorStrength = Math.max(0, Number(options.priorStrength ?? 1));
    this.version = Number(options.version || 0); this.actualCount = 0; this.updatedAt = null;
    this.digitCounts = Array(10).fill(0); this.transitionCounts = Array.from({ length: 10 }, () => Array(10).fill(0));
    this.secondOrderCounts = new Map(); this.incrementCounts = new Map(); this.priceScale = 0;
    this.lastActualQuote = null; this.lastActualDigit = null; this.lastActualEpoch = null;
    this.generatedSequence = 0; this.lastGeneratedQuote = null; this.lastGeneratedDigit = null;
    this.randomState = (hashString(symbol) || 1) >>> 0; this.windowSize = options.windowSize || 1000;
    this.trainingMs = 0; this.status = 'UNTRAINED';
  }
  fit(input) {
    const start = performance.now();
    const ticks = input.filter(isActual).slice().sort((a, b) => Number(a.epoch) - Number(b.epoch)).slice(-this.windowSize);
    const actual = ticks;
    this.digitCounts = Array(10).fill(0); this.transitionCounts = Array.from({ length: 10 }, () => Array(10).fill(0)); this.secondOrderCounts = new Map(); this.incrementCounts = new Map();
    this.priceScale = Math.min(12, Math.max(0, ...actual.map(t => places(t.quote))));
    let priorDigit = null, secondKey = null, previousUnits, previousEpoch;
    for (const tick of actual) {
      const digit = Number.isInteger(tick.digit) && tick.digit >= 0 && tick.digit <= 9 ? tick.digit : extractDigit(tick.quote);
      if (!Number.isInteger(digit) || digit < 0 || digit > 9) continue;
      this.digitCounts[digit] += 1;
      if (priorDigit !== null) {
        this.transitionCounts[priorDigit][digit] += 1;
        if (secondKey !== null) { const key = `${secondKey},${priorDigit}`; this.secondOrderCounts.set(key, incrementCount(this.secondOrderCounts.get(key) || Array(10).fill(0), digit)); }
      }
      const price = units(tick.quote, this.priceScale);
      if (previousUnits !== undefined) {
        const delta = String(price - previousUnits); this.incrementCounts.set(delta, (this.incrementCounts.get(delta) || 0) + 1);
      }
      const currentDigit = digit;
      secondKey = priorDigit; priorDigit = currentDigit; previousUnits = price; previousEpoch = Number(tick.epoch);
      void previousEpoch;
    }
    this.actualCount = actual.length; const latest = actual.at(-1);
    if (latest) { this.lastActualQuote = String(latest.quote); this.lastActualDigit = Number.isInteger(latest.digit) ? latest.digit : extractDigit(latest.quote); this.lastActualEpoch = Number(latest.epoch); }
    this.version += 1; this.updatedAt = Date.now(); this.trainingMs = performance.now() - start;
    this.status = actual.length >= 10 ? 'READY' : actual.length ? 'WARMING' : 'UNTRAINED';
    if (latest && this.lastGeneratedQuote === null) { this.lastGeneratedQuote = this.lastActualQuote; this.lastGeneratedDigit = this.lastActualDigit; }
    return this.summary();
  }
  probabilities(previousDigit, method = 'markov', secondPreviousDigit = null) {
    const alpha = this.priorStrength;
    let counts = this.digitCounts;
    if (method === 'markov' && Number.isInteger(previousDigit)) {
      const second = this.secondOrderCounts.get(`${secondPreviousDigit},${previousDigit}`);
      const row = this.transitionCounts[previousDigit];
      const rowTotal = row.reduce((a, b) => a + b, 0);
      if (second && second.reduce((a, b) => a + b, 0) >= 5) counts = second;
      else if (rowTotal >= 3) counts = row;
    }
    const denominator = counts.reduce((a, b) => a + b, 0) + alpha * 10;
    return denominator ? counts.map(n => (n + alpha) / denominator) : uniform(10);
  }
  incrementDistribution() {
    const entries = [...this.incrementCounts].map(([delta, count]) => ({ value: delta, weight: count }));
    if (entries.length) return entries;
    return [{ value: '1', weight: 1 }, { value: '-1', weight: 1 }];
  }
  predictPath(horizon, options = {}) {
    const steps = Math.max(1, Math.min(100, Number(horizon) || 1));
    let quote = options.startQuote ?? this.lastGeneratedQuote ?? this.lastActualQuote ?? '0';
    let digit = options.startDigit ?? (options.startQuote ? extractDigit(options.startQuote) : this.lastGeneratedDigit ?? this.lastActualDigit);
    let prevDigit = digit, prevPrev = null;
    let rngState = Number.isInteger(options.seed) ? (options.seed >>> 0 || 1) : this.randomState;
    const rng = () => { rngState ^= rngState << 13; rngState ^= rngState >>> 17; rngState ^= rngState << 5; return (rngState >>> 0) / 4294967296; };
    const output = [];
    for (let i = 0; i < steps; i += 1) {
      const method = options.method || 'markov';
      const probabilityMethod = method === 'baseline' || method === 'empirical' || method === 'stress' ? 'empirical' : 'markov';
      const probs = this.probabilities(prevDigit, probabilityMethod, prevPrev);
      let predictedDigit;
      if (method === 'persistence' && Number.isInteger(prevDigit)) {
        predictedDigit = prevDigit;
      } else if (method === 'stress') {
        const minimum = Math.min(...probs);
        predictedDigit = weighted(probs.map((p, value) => ({ value, weight: Math.abs(p - minimum) < 1e-12 ? 1 : 0 })), rng);
      } else {
        predictedDigit = weighted(probs.map((p, value) => ({ value, weight: p })), rng);
      }
      const incrementChoices = method === 'persistence' ? [{ value: '0', weight: 1 }] : this.incrementDistribution();
      const matching = incrementChoices.filter(item => {
        const candidate = decimal(units(quote, this.priceScale) + BigInt(item.value), this.priceScale);
        return extractDigit(candidate) === predictedDigit;
      });
      const stressIncrements = method === 'stress' ? [...incrementChoices].sort((a, b) => Math.abs(Number(b.value)) - Math.abs(Number(a.value))).slice(0, Math.max(1, Math.ceil(incrementChoices.length * 0.1))) : incrementChoices;
      let eligible = matching.length ? matching : stressIncrements;
      if (method === 'stress' && !matching.length) {
        const forced = Array.from({ length: 19 }, (_, index) => String(index - 9)).filter(delta => extractDigit(decimal(units(quote, this.priceScale) + BigInt(delta), this.priceScale)) === predictedDigit);
        if (forced.length) eligible = forced.map(value => ({ value, weight: 1 }));
      }
      const deltaString = weighted(eligible, rng) || '1';
      const priceUnits = units(quote, this.priceScale), nextUnits = priceUnits + BigInt(deltaString);
      const nextQuote = formatQuote(decimal(nextUnits, this.priceScale), this.priceScale);
      const nextDigit = extractDigit(nextQuote);
      const direction = nextUnits > priceUnits ? 'UP' : nextUnits < priceUnits ? 'DOWN' : 'UNCHANGED';
      output.push({ step: i + 1, quote: nextQuote, digit: nextDigit, direction, distribution: probs, probability: probs[nextDigit], increment: deltaString, modelVersion: this.version, method });
      prevPrev = prevDigit; prevDigit = nextDigit; digit = nextDigit; quote = nextQuote;
    }
    if (options.advanceRandom) this.randomState = (rngState >>> 0) || 1;
    return output;
  }
  generate(options = {}) {
    if (this.status !== 'READY' || !this.lastGeneratedQuote) throw new Error(`Model for ${this.symbol} needs at least 10 actual ticks before generation.`);
    const predicted = this.predictPath(1, { ...options, advanceRandom: true })[0];
    const previous = this.lastGeneratedQuote, previousUnits = units(previous, this.priceScale), nextUnits = units(predicted.quote, this.priceScale);
    this.generatedSequence += 1; this.lastGeneratedQuote = predicted.quote; this.lastGeneratedDigit = predicted.digit;
    const tick = {
      symbol: this.symbol, source: 'LOCAL_GENERATED', quote: predicted.quote, epoch: Date.now() / 1000,
      arrival: Date.now(), generatedAt: Date.now(), id: `${this.symbol}:sim:${this.generatedSequence}`,
      digit: predicted.digit, previousQuote: previous, priceDifference: decimal(nextUnits - previousUnits, this.priceScale),
      direction: predicted.direction, modelVersion: this.version, predictionHorizon: 1, predictionId: options.predictionId || null,
      mode: options.mode || 'offline', method: options.method || 'markov',
    };
    return tick;
  }
  summary() { return { symbol: this.symbol, status: this.status, actualCount: this.actualCount, version: this.version, updatedAt: this.updatedAt, trainingMs: this.trainingMs, digitCounts: [...this.digitCounts], lastActualQuote: this.lastActualQuote, generatedSequence: this.generatedSequence }; }
  snapshot() { return { schema: 1, symbol: this.symbol, priorStrength: this.priorStrength, version: this.version, actualCount: this.actualCount, digitCounts: this.digitCounts, transitionCounts: this.transitionCounts, secondOrderCounts: [...this.secondOrderCounts], incrementCounts: [...this.incrementCounts], priceScale: this.priceScale, lastActualQuote: this.lastActualQuote, lastActualDigit: this.lastActualDigit, lastActualEpoch: this.lastActualEpoch, generatedSequence: this.generatedSequence, lastGeneratedQuote: this.lastGeneratedQuote, lastGeneratedDigit: this.lastGeneratedDigit, randomState: this.randomState, windowSize: this.windowSize, updatedAt: this.updatedAt, status: this.status }; }
  restore(snapshot) {
    if (snapshot?.schema !== 1 || snapshot.symbol !== this.symbol || !Array.isArray(snapshot.digitCounts) || snapshot.digitCounts.length !== 10) throw new Error('Invalid or mismatched model snapshot.');
    Object.assign(this, snapshot); this.secondOrderCounts = new Map(snapshot.secondOrderCounts || []); this.incrementCounts = new Map(snapshot.incrementCounts || []); return this;
  }
}
function hashString(text) { let h = 2166136261; for (const char of String(text)) h = Math.imul(h ^ char.charCodeAt(0), 16777619); return h >>> 0; }
function incrementCount(array, value) { array[value] += 1; return array; }
