const validActual = tick => tick?.source === 'DERIV_ACTUAL' && Number.isFinite(Number(tick.epoch));

/** Issues immutable predictions and scores them strictly against later actual observations. */
export class ForecastBook {
  constructor({ onEvaluation = () => {} } = {}) { this.forecasts = []; this.onEvaluation = onEvaluation; }
  issue({ symbol, model, actualTicks, horizon = 5, method = 'markov' }) {
    const actual = actualTicks.filter(validActual).slice().sort((a, b) => Number(a.epoch) - Number(b.epoch));
    if (!actual.length || actual.length < 10) throw new Error('At least 10 actual ticks are required to issue a forecast.');
    const snapshot = model.snapshot();
    const createdAt = Date.now(), forecastSeed = ((createdAt ^ hash(symbol) ^ this.forecasts.length) >>> 0) || 1;
    const predictions = model.predictPath(horizon, { method, seed: forecastSeed, startQuote: String(actual.at(-1).quote), startDigit: Number.isInteger(actual.at(-1).digit) ? actual.at(-1).digit : finalDigit(actual.at(-1).quote) });
    const baselineProbabilities = model.probabilities(null, 'empirical');
    const last = actual.at(-1);
    const forecast = {
      id: `${symbol}:${createdAt}:${this.forecasts.length + 1}`, symbol, source: 'LOCAL_PREDICTED',
      createdAt, issueEpoch: Number(last.epoch), issueTickId: last.id, issueActualCount: actual.length,
      modelVersion: snapshot.version, method, horizon: predictions.length, status: 'PENDING',
      scoringCount: 0, baselineProbabilities: [...baselineProbabilities], baselineDigit: baselineProbabilities.indexOf(Math.max(...baselineProbabilities)),
      predictions: predictions.map(item => ({ ...item, distribution: [...item.distribution] })),
      evaluations: [],
    };
    this.forecasts.unshift(forecast);
    return freezePrediction(forecast);
  }
  scoreActual(tick) {
    if (!validActual(tick)) return [];
    const newlyScored = [];
    for (const forecast of this.forecasts) {
      if (forecast.symbol !== tick.symbol || Number(tick.epoch) <= forecast.issueEpoch || Number(tick.arrival || 0) < forecast.createdAt) continue;
      // Exchange epochs may have gaps; scoring advances only when a new actual message arrives.
      if (forecast.lastScoredTickId === tick.id) continue;
      forecast.lastScoredTickId = tick.id;
      const step = ++forecast.scoringCount;
      const prediction = forecast.predictions[step - 1];
      if (!prediction) continue;
      const actualDigit = Number.isInteger(tick.digit) ? tick.digit : finalDigit(tick.quote);
      const predictedDigit = prediction.digit;
      const correctDigit = actualDigit === predictedDigit;
      const baselineDigit = forecast.baselineDigit;
      const actualDirection = tick.direction || 'UNKNOWN';
      const predictedDirection = prediction.direction;
      const exactPrice = String(tick.quote) === String(prediction.quote);
      const digitProbability = Array.isArray(prediction.distribution) ? prediction.distribution[actualDigit] : null;
      const distribution = Array.isArray(prediction.distribution) ? prediction.distribution : [];
      const brierScore = distribution.length === 10 ? distribution.reduce((sum, p, digit) => sum + (p - (digit === actualDigit ? 1 : 0)) ** 2, 0) : null;
      const result = {
        forecastId: forecast.id, symbol: forecast.symbol, horizonStep: step, evaluatedAt: Date.now(),
        actualTickId: tick.id, actualEpoch: Number(tick.epoch), actualQuote: String(tick.quote), actualDigit,
        actualDirection, predictedQuote: prediction.quote, predictedDigit, predictedDirection,
        exactPriceMatch: exactPrice, digitCorrect: correctDigit,
        baselineDigit, baselineDigitCorrect: baselineDigit === actualDigit,
        directionCorrect: actualDirection !== 'UNKNOWN' && actualDirection === predictedDirection,
        predictedDigitProbability: Number.isFinite(digitProbability) ? digitProbability : null, brierScore,
        modelVersion: forecast.modelVersion, method: forecast.method,
      };
      forecast.evaluations.push(result); forecast.status = 'PARTIAL';
      if (forecast.evaluations.length >= forecast.horizon) forecast.status = 'COMPLETE';
      this.onEvaluation(result);
      newlyScored.push(result);
    }
    return newlyScored;
  }
  list() { return this.forecasts.map(f => ({ ...f, predictions: f.predictions.map(p => ({ ...p, distribution: [...p.distribution] })), evaluations: [...f.evaluations] })); }
  metrics(symbol = null, horizon = null) {
    const rows = this.forecasts.filter(f => (!symbol || f.symbol === symbol) && (!horizon || f.horizon === horizon)).flatMap(f => f.evaluations);
    const metric = (values, label) => { const valid = values.filter(v => typeof v === 'boolean'); const successes = valid.filter(Boolean).length; return { label, successes, samples: valid.length, percent: valid.length ? successes / valid.length * 100 : null }; };
    const digit = metric(rows.map(x => x.digitCorrect), 'Next digit');
    const baselineDigit = metric(rows.map(x => x.baselineDigitCorrect), 'Empirical baseline digit');
    const exactPrice = metric(rows.map(x => x.exactPriceMatch), 'Exact price');
    const direction = metric(rows.map(x => x.directionCorrect), 'Direction');
    const brierRows = rows.filter(x => Number.isFinite(x.brierScore));
    const brierScore = brierRows.length ? brierRows.reduce((s, r) => s + r.brierScore, 0) / brierRows.length : null;
    return { evaluatedPredictions: rows.length, forecasts: this.forecasts.filter(f => (!symbol || f.symbol === symbol)).length, digit, baselineDigit, exactPrice, direction, digitBaseline: baselineDigit.percent, digitBaselineSamples: baselineDigit.samples, brierScore, brierSamples: brierRows.length, validationStatus: rows.length ? 'OUT-OF-SAMPLE' : 'INSUFFICIENT EVIDENCE' };
  }
  restore(records) {
    if (!Array.isArray(records)) throw new Error('Forecast ledger must be an array.');
    this.forecasts = records.filter(f => f?.source === 'LOCAL_PREDICTED' && Array.isArray(f.predictions)).map(f => ({ ...f, evaluations: Array.isArray(f.evaluations) ? f.evaluations : [] }));
    return this.forecasts.length;
  }
}
function finalDigit(quote) { const digits = String(quote).match(/\d/g); return digits?.length ? Number(digits.at(-1)) : null; }
function hash(text) { let value = 2166136261; for (const character of String(text)) value = Math.imul(value ^ character.charCodeAt(0), 16777619); return value >>> 0; }
function freezePrediction(forecast) { return Object.freeze({ ...forecast, predictions: Object.freeze(forecast.predictions.map(p => Object.freeze({ ...p, distribution: Object.freeze([...p.distribution]) }))) }); }
