# Tick Intelligence — Deriv Market Data Lab

A browser-based research workspace for observing Deriv market data, exploring symbol-specific tick behavior, generating an independent local simulated series, and evaluating locked forecasts only against actual observations received afterward. This is a research and educational tool—not a trading system, signal service, or claim of predictive profitability.

## Live website

The permanent deployment is available at [whaaat-eight.vercel.app](https://whaaat-eight.vercel.app/). The repository's configured Vercel deployment publishes updates from `main`; GitHub Actions runs the test suite and production build as a separate CI check.

## Run locally

Requirements: Node.js 20+ and npm.

```bash
npm install
npm run dev
```

To create and serve a production build:

```bash
npm test
npm run build
npm run preview
```

## Deriv connection and data handling

- Connects directly to Deriv's unauthenticated public read-only market-data WebSocket: `wss://api.derivws.com/trading/v1/options/ws/public`.
- Requires no Deriv login, trading token, app ID, or account permissions.
- Discovers active symbols dynamically; hydrates up to 1,000 recent ticks per symbol with a maximum of three concurrent history requests; and streams ticks for the selected symbol.
- Retains displayed quote precision and records exchange timestamps separately from browser receipt times.
- Labels actual observations `DERIV_ACTUAL`; labels locally generated records separately as simulated. These streams are not merged.
- Caches actual market history in browser IndexedDB (up to 1,000 ticks per symbol in the intake cache). Extended research data—up to 10,000 actual ticks per symbol, up to 1,000 generated ticks per symbol, model snapshots, forecast records, prospective evaluations, and diagnostics—is stored in separate IndexedDB stores.
- Storage is local to the browser and origin. It is not a server database or cross-device sync; clearing browser data removes the local copy. Export research state regularly if it needs to be retained elsewhere.
- WebSocket pings, live-tick freshness monitoring, automatic subscription refresh, and capped exponential-backoff reconnection help recover a quiet/stale feed. The UI distinguishes an open socket from recent incoming market ticks.

History availability and lengths depend on Deriv's current active-symbol catalogue, API limits, network connectivity, and provider responses. Individual history failures and loaded counts are exposed in the interface.

## Research workspace

- **Overview:** selected-market stream, history readiness, and clearly separated actual and generated price traces.
- **Tick explorer:** filter actual/generated observations by symbol, source, digit, direction, time range, quote or tick ID, and forecast ID.
- **Behavior lab:** digit frequencies, conditional digit transitions, price-movement summaries, rolling windows, and distribution drift, calculated from actual records.
- **Local generator:** starts automatically once the selected symbol has enough actual training data; supports an adaptive mimic, empirical distribution mimic, repeat-last-digit baseline, and explicit low-probability pattern stress test. It runs offline or in live-learning mode, uses a Web Worker when supported, and stores generated values separately.
- **Forecast centre:** issue immutable, finite-horizon forecasts from the current actual-data model or a frequency baseline. A later actual tick is used to score a forecast; generated data never counts as an outcome.
- **Learning and accuracy:** per-symbol model readiness, version events, diagnostics, and prospective metrics with denominators and baseline comparisons. Insufficient sample sizes are shown as insufficient evidence rather than invented performance.
- **Symbol manager and settings:** per-symbol status, rolling windows, model prior strength, validation-window setting, reset controls, and JSON import/export.

## Integrity and interpretation

The model is an experimental statistical baseline, not a guarantee that tick digits or prices are predictable. Pattern stress is a local test that deliberately selects unlikely outcomes; it cannot influence Deriv or establish a break in Deriv's generator. Forecasts are frozen when issued and evaluated prospectively; no future actual tick is used to construct the saved forecast. Accuracy and calibration should be interpreted only with adequate independent observations and suitable validation. There is no trade execution, account authentication, or financial recommendation functionality.

## Tests

```bash
npm test
```

Tests cover quote formatting and displayed final digits, history mapping and symbol separation, actual-only feature analysis, independent generated records, forecast immutability, prospective evaluation, and untrained-model safeguards.

## Official API references

- [Deriv active symbols](https://developers.deriv.com/docs/data/active-symbols/)
- [Deriv tick history](https://developers.deriv.com/docs/data/ticks-history/)
- [Deriv live ticks](https://developers.deriv.com/docs/data/ticks/)
- [Deriv WebSocket documentation](https://developers.deriv.com/docs/options/websocket/)
