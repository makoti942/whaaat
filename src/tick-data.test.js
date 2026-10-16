import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDigit, formatQuote, mapHistory, precisionFromPipSize, tickIdentity } from './tick-data.js';

test('keeps string quotes exactly, including trailing zeroes', () => {
  assert.equal(formatQuote('123.450', 3), '123.450');
  assert.equal(formatQuote('123.4', 3), '123.400');
  assert.equal(formatQuote('1230', 2), '1230.00');
});
test('formats numeric quotes at the symbol precision', () => {
  assert.equal(formatQuote(123.45, 3), '123.450');
  assert.equal(formatQuote(1.2, 2), '1.20');
});
test('converts Deriv pip-size increments to decimal precision', () => {
  assert.equal(precisionFromPipSize(0.01), 2);
  assert.equal(precisionFromPipSize(0.001), 3);
  assert.equal(precisionFromPipSize(0.1), 1);
  assert.equal(precisionFromPipSize(1), 0);
});
test('extracts the final displayed decimal digit, not the integer units digit', () => {
  assert.equal(extractDigit('123.450'), 0);
  assert.equal(extractDigit('999.127'), 7);
  assert.equal(extractDigit('42'), 2);
});
test('uses epoch and quote for observation identity, not a reusable subscription id', () => {
  assert.equal(tickIdentity('1HZ100V', 100, '12.30'), '1HZ100V:100:12.30');
  assert.notEqual(tickIdentity('1HZ100V', 100, '12.30'), tickIdentity('1HZ100V', 101, '12.30'));
});
test('maps source history without mixing symbols or changing epochs', () => {
  const result = mapHistory('SYNTH_X', [12.34, 12.35], [100, 101], 3);
  assert.deepEqual(result.map(t => [t.symbol, t.source, t.quote, t.epoch, t.digit]), [
    ['SYNTH_X', 'DERIV_ACTUAL', '12.340', 100, 0],
    ['SYNTH_X', 'DERIV_ACTUAL', '12.350', 101, 0],
  ]);
});
test('drops malformed epochs and unmatched history array tails', () => {
  const result = mapHistory('A', ['1.20', '2.30', '3.40'], [1, 'bad'], 2);
  assert.equal(result.length, 1);
  assert.equal(result[0].quote, '1.20');
});
