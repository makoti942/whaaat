export function precisionFromPipSize(pipSize) {
  const step = Number(pipSize);
  if (!Number.isFinite(step) || step <= 0) return undefined;
  for (let places = 0; places <= 12; places += 1) {
    const scaled = step * (10 ** places);
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9) return places;
  }
  return undefined;
}

export function formatQuote(raw, precision) {
  if (typeof raw === 'string') {
    if (!Number.isInteger(precision) || precision < 0 || precision > 12 || !/^-?\d+(?:\.\d+)?$/.test(raw)) return raw;
    const negative = raw.startsWith('-');
    const unsigned = negative ? raw.slice(1) : raw;
    const [whole, fraction = ''] = unsigned.split('.');
    const exactFraction = fraction.length >= precision ? fraction : fraction.padEnd(precision, '0');
    return `${negative ? '-' : ''}${whole}${precision ? `.${exactFraction}` : ''}`;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return String(raw ?? '');
  if (Number.isInteger(precision) && precision >= 0 && precision <= 12) return raw.toFixed(precision);
  return String(raw);
}

export function extractDigit(quote) {
  const digits = String(quote).match(/\d/g);
  return digits?.length ? Number(digits[digits.length - 1]) : null;
}

export function tickIdentity(symbol, epoch, quote) {
  return `${symbol}:${Number(epoch)}:${String(quote)}`;
}

export function mapHistory(symbol, prices, times, precision) {
  const output = [];
  const length = Math.min(prices.length, times.length);
  for (let i = 0; i < length; i += 1) {
    const epoch = Number(times[i]);
    const quote = formatQuote(prices[i], precision);
    if (!Number.isFinite(epoch) || extractDigit(quote) === null) continue;
    output.push({
      symbol,
      source: 'DERIV_ACTUAL',
      quote,
      epoch,
      arrival: Date.now(),
      digit: extractDigit(quote),
      id: tickIdentity(symbol, epoch, quote),
    });
  }
  return output;
}
