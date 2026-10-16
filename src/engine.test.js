import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTicks } from './engine/features.js';
import { LocalTickModel } from './engine/model.js';
import { ForecastBook } from './engine/forecast-book.js';

function actualTicks(symbol = 'TEST', count = 40) {
  return Array.from({ length: count }, (_, i) => {
    const quote = (1000 + ((i * 7) % 13) / 100).toFixed(2);
    return { symbol, source: 'DERIV_ACTUAL', quote, epoch: 1700000000 + i, arrival: (1700000000 + i) * 1000, digit: Number(quote.at(-1)), id: `${symbol}:${i}` };
  });
}

test('behavior analysis uses only actual observations and calculates distributions/transitions', () => {
  const actual = actualTicks();
  const generated = { ...actualTicks('TEST', 1)[0], source: 'LOCAL_GENERATED', symbol: 'TEST' };
  const profile = analyzeTicks([...actual, generated], [10, 20]);
  assert.equal(profile.samples, actual.length);
  assert.equal(profile.counts.reduce((a, b) => a + b, 0), actual.length);
  assert.equal(profile.transitionProbabilities.length, 10);
  assert.equal(profile.rolling[0].window, 10);
  assert.equal(profile.directions.UP + profile.directions.DOWN + profile.directions.UNCHANGED, actual.length - 1);
});

test('model filters non-actual records and generates independent local records', () => {
  const source = actualTicks('VOL100', 80);
  const model = new LocalTickModel('VOL100');
  model.fit([...source, { ...source.at(-1), source: 'LOCAL_GENERATED', quote: '9999.99' }]);
  assert.equal(model.actualCount, 80);
  assert.equal(model.status, 'READY');
  const tick = model.generate({ mode: 'offline' });
  assert.equal(tick.source, 'LOCAL_GENERATED');
  assert.equal(tick.mode, 'offline');
  assert.notEqual(tick, source.at(-1));
  assert.notEqual(tick.id, source.at(-1).id);
  assert.equal(tick.symbol, 'VOL100');
  assert.match(tick.quote, /^-?\d+\.\d{2}$/);
  assert.equal(tick.digit, Number(tick.quote.at(-1)));
  assert.equal(model.generatedSequence, 1);
});

test('forecast issue freezes recursive predictions and scores only later actual arrivals', () => {
  const history = actualTicks('STEP', 30);
  const model = new LocalTickModel('STEP');
  model.fit(history);
  const book = new ForecastBook();
  const forecast = book.issue({ symbol: 'STEP', model, actualTicks: history, horizon: 5 });
  const locked = JSON.stringify(forecast.predictions);
  assert.throws(() => book.issue({ symbol: 'STEP', model, actualTicks: history.slice(0, 5), horizon: 1 }), /10 actual/);
  assert.deepEqual(book.scoreActual({ ...history.at(-1), arrival: Date.now() }), []);
  assert.deepEqual(book.scoreActual({ ...history.at(-1), source: 'LOCAL_GENERATED', epoch: 1700000031, arrival: Date.now() }), []);
  const future = { symbol: 'STEP', source: 'DERIV_ACTUAL', quote: '1001.13', epoch: history.at(-1).epoch + 1, arrival: forecast.createdAt + 1, digit: 3, id: 'STEP:future:1', direction: 'UP' };
  const result = book.scoreActual(future);
  assert.equal(result.length, 1);
  assert.equal(result[0].actualTickId, future.id);
  assert.equal(result[0].horizonStep, 1);
  assert.equal(JSON.stringify(book.list()[0].predictions), locked);
  assert.equal(book.metrics('STEP').evaluatedPredictions, 1);
  assert.equal(book.metrics('STEP').digit.samples, 1);
  assert.equal(book.metrics('STEP').baselineDigit.samples, 1);
});

test('a forecast is unavailable when only generated history exists', () => {
  const model = new LocalTickModel('X');
  model.fit([{ ...actualTicks('X', 10)[0], source: 'LOCAL_GENERATED' }]);
  assert.throws(() => model.generate(), /at least 10 actual ticks/);
});

test('persistence generator repeats the last generated digit from the learned stream', () => {
  const history = actualTicks('PERSIST', 60);
  const model = new LocalTickModel('PERSIST');
  model.fit(history);
  const previousDigit = model.lastActualDigit;
  const tick = model.generate({ method: 'persistence', mode: 'offline' });
  assert.equal(tick.digit, previousDigit);
  assert.equal(tick.method, 'persistence');
});

test('pattern stress mode deliberately samples a least-likely empirical digit', () => {
  const history = actualTicks('STRESS', 80);
  const model = new LocalTickModel('STRESS');
  model.fit(history);
  const probs = model.probabilities(null, 'empirical');
  const leastLikely = Math.min(...probs);
  const generated = model.generate({ method: 'stress', mode: 'offline' });
  assert.equal(probs[generated.digit], leastLikely);
  assert.equal(generated.source, 'LOCAL_GENERATED');
  assert.equal(generated.method, 'stress');
});

test('forecast scores distinct post-issue ticks in the same second and stops at its horizon', () => {
  const history = actualTicks('SAMESECOND', 30);
  history.at(-1).sequence = 500;
  const model = new LocalTickModel('SAMESECOND'); model.fit(history);
  const book = new ForecastBook();
  const forecast = book.issue({ symbol: 'SAMESECOND', model, actualTicks: history, horizon: 2 });
  const first = { ...history.at(-1), sequence: 501, id: 'same-second:1', arrival: forecast.createdAt + 1 };
  const second = { ...history.at(-1), sequence: 502, id: 'same-second:2', arrival: forecast.createdAt + 2 };
  const third = { ...history.at(-1), sequence: 503, id: 'same-second:3', arrival: forecast.createdAt + 3 };
  assert.equal(book.scoreActual(first).length, 1);
  assert.equal(book.scoreActual(second).length, 1);
  assert.equal(book.scoreActual(third).length, 0);
  assert.equal(book.list()[0].scoringCount, 2);
  assert.equal(book.list()[0].evaluations.length, 2);
});
