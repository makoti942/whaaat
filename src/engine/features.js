const DIGITS = 10;

const decimalPlaces = value => (String(value).split('.')[1] || '').length;
function asUnits(value, scale) {
  const text = String(value);
  const [whole, fraction = ''] = text.split('.');
  return BigInt(`${whole}${fraction.padEnd(scale, '0').slice(0, scale)}`);
}
function average(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; }

/** Compute a descriptive profile from one symbol's chronological actual data only. */
export function analyzeTicks(input, windows = [50, 100, 250, 500, 1000]) {
  const ticks = input.filter(t => t?.source === 'DERIV_ACTUAL' && Number.isFinite(Number(t.epoch)) && /^-?\d+(?:\.\d+)?$/.test(String(t.quote)))
    .slice().sort((a, b) => a.epoch - b.epoch);
  const counts = Array(DIGITS).fill(0);
  const transitions = Array.from({ length: DIGITS }, () => Array(DIGITS).fill(0));
  const intervals = [], changes = [], directions = { UP: 0, DOWN: 0, UNCHANGED: 0 };
  let streak = { digit: null, length: 0 }, longestStreak = { digit: null, length: 0 }, previousUnits;
  const scale = Math.min(12, Math.max(0, ...ticks.map(t => decimalPlaces(t.quote))));
  const factor = 10 ** scale;
  for (let i = 0; i < ticks.length; i += 1) {
    const tick = ticks[i], digit = Number.isInteger(tick.digit) ? tick.digit : Number(String(tick.quote).replace(/\D/g, '').at(-1));
    if (digit >= 0 && digit <= 9) {
      counts[digit] += 1;
      if (streak.digit === digit) streak.length += 1; else streak = { digit, length: 1 };
      if (streak.length > longestStreak.length) longestStreak = { ...streak };
      const prev = ticks[i - 1];
      if (prev && Number.isInteger(prev.digit) && prev.digit >= 0 && prev.digit <= 9) transitions[prev.digit][digit] += 1;
    }
    if (i && Number.isFinite(Number(ticks[i - 1].epoch))) intervals.push(Math.max(0, (Number(tick.epoch) - Number(ticks[i - 1].epoch)) * 1000));
    const units = asUnits(tick.quote, scale);
    if (previousUnits !== undefined) {
      const deltaUnits = units - previousUnits, delta = Number(deltaUnits) / factor;
      changes.push(delta);
      directions[delta > 0 ? 'UP' : delta < 0 ? 'DOWN' : 'UNCHANGED'] += 1;
    }
    previousUnits = units;
  }
  const total = counts.reduce((a, b) => a + b, 0);
  const meanChange = average(changes);
  const varianceChange = changes.length > 1 ? changes.reduce((sum, value) => sum + (value - meanChange) ** 2, 0) / (changes.length - 1) : null;
  const even = counts.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0);
  const under = counts.slice(0, 5).reduce((a, b) => a + b, 0);
  const transitionProbabilities = transitions.map(row => { const n = row.reduce((a, b) => a + b, 0); return row.map(v => n ? v / n : null); });
  const rolling = windows.map(size => {
    const series = changes.slice(-size), sample = ticks.slice(-Math.min(size + 1, ticks.length));
    const mu = average(series), variance = series.length > 1 ? series.reduce((s, x) => s + (x - mu) ** 2, 0) / (series.length - 1) : null;
    const freq = Array(10).fill(0); sample.forEach(t => { const d = Number.isInteger(t.digit) ? t.digit : Number(String(t.quote).replace(/\D/g, '').at(-1)); if (d >= 0 && d <= 9) freq[d] += 1; });
    return { window: size, samples: sample.length, changeSamples: series.length, meanChange: mu, variance: variance, volatility: variance === null ? null : Math.sqrt(variance), digitCounts: freq, digitProbabilities: freq.map(n => sample.length ? n / sample.length : null) };
  });
  const lagAutocorrelation = [1, 2, 3, 5, 10].map(lag => {
    if (changes.length <= lag + 1) return { lag, value: null, samples: 0 };
    const xs = changes.slice(lag), ys = changes.slice(0, -lag), mx = average(xs), my = average(ys);
    const numerator = xs.reduce((sum, x, i) => sum + (x - mx) * (ys[i] - my), 0);
    const denominator = Math.sqrt(xs.reduce((sum, x) => sum + (x - mx) ** 2, 0) * ys.reduce((sum, y) => sum + (y - my) ** 2, 0));
    return { lag, value: denominator ? numerator / denominator : null, samples: xs.length };
  });
  const sorted = [...intervals].sort((a, b) => a - b);
  const medianIntervalMs = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  const lastPrice = ticks.at(-1)?.quote ?? null;
  const repeatedDigits = ticks.length > 1 ? ticks.slice(1).reduce((n, t, i) => n + (t.digit === ticks[i].digit ? 1 : 0), 0) : 0;
  return {
    symbol: ticks.at(-1)?.symbol ?? null, samples: ticks.length, scale, lastPrice, counts,
    probabilities: counts.map(n => total ? n / total : null), evenOdd: { even: total ? even / total : null, odd: total ? (total - even) / total : null },
    overUnder: { under: total ? under / total : null, over: total ? (total - under) / total : null },
    transitions, transitionProbabilities, streak, longestStreak, repeatedDigitRate: total > 1 ? repeatedDigits / (total - 1) : null,
    directions, directionProbabilities: Object.fromEntries(Object.entries(directions).map(([k, v]) => [k, changes.length ? v / changes.length : null])),
    changeSamples: changes.length, meanChange, varianceChange,
    rolling, lagAutocorrelation, intervals: { samples: intervals.length, meanMs: average(intervals), medianMs: medianIntervalMs, minMs: sorted[0] ?? null, maxMs: sorted.at(-1) ?? null },
    updatedAt: Date.now(),
  };
}

export function jensenShannonDistance(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return null;
  const eps = 1e-12, m = a.map((x, i) => ((x || 0) + (b[i] || 0)) / 2);
  const kl = (p, q) => p.reduce((sum, x, i) => x > eps ? sum + x * Math.log2(x / Math.max(q[i], eps)) : sum, 0);
  return Math.sqrt(Math.max(0, (kl(a, m) + kl(b, m)) / 2));
}
