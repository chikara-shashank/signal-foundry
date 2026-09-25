# Strategy selection and results

The dashboard's **Strategies & results** panel lists every installed strategy,
including disabled strategies and strategies with no fills. Each switch controls
new entries immediately. The global pause and all existing allocation, freshness,
account and daily-loss gates still apply. Enabling a strategy does not force a trade.

Selections are saved in the account/mode SQLite database, in `strategySettings`.
The first start seeds them from `STRATEGIES` (or the registry's explicit defaults).
After that, the saved selection wins over environment defaults. An empty initial
`STRATEGIES=` starts with all strategies off. New registry entries added to an
existing installation start off. No application restart is needed to switch an
installed, available strategy on. Market universe, risk limits and provider
configuration continue to come from their existing configuration paths.

Switching off invalidates in-flight worker/model approvals and requests cancellation
of pending entry orders. Uncertain outcomes are reconciled before cancellation;
cancellation intent survives re-enabling and restart. A cancellation can race a
fill. Fully filled parent orders and their protective legs are not cancelled by the
switch. Existing positions retain normal stop, target, time and session exits,
including noise-area trailing exits. A partially filled entry that is cancelled
uses the engine's existing `partial_entry_canceled` protective exit behavior.

The panel shows cumulative retained local fill history. Realized net P/L includes
the exited portion of partial trades and recorded or estimated per-order trading
fees. Win rate is profitable fully closed trades divided by all fully closed
trades, using net P/L; breakeven trades are not wins. No closed trades displays a
dash, not 0%. Open P/L is shown separately before fees, with fresh bid marks or
reconciled broker marks, and is unavailable when the book cannot be reconciled.
External holdings and model/cloud charges are excluded. Historical strategies
without an installed handler remain visible but cannot be enabled. These metrics
do not establish an out-of-sample edge or future profitability.

## Adding a strategy

1. Give it a stable, unique ID in `src/strategy-registry.js`, with a readable name,
   description, trigger (`bar`, `quote` or `session`) and `defaultEnabled: false`.
   Never reuse or rename an existing ID to mean a different strategy; fills and
   selections are attributed by ID.
2. For bar/quote strategies, implement its numerical checks in
   `src/strategy-setups.js`. The registry rejects missing evaluators at startup.
   The worker list and dispatch lists derive from the registry, and all worker
   strategies are loaded even when disabled. Review candidate construction in
   `src/strategies.js` for any distinct stop/target, lifespan or feature requirements.
   Keep account, cost and execution gates in `Engine.checkEntry`.
3. For stateful session strategies, wire its lifecycle and availability check in
   `src/main.js` and `StrategyControls.unavailable`, following `NoiseArea`. Call
   `engine.submitCandidate` for entries; never submit directly to the broker.
   Keep exit evaluation active for owned positions while entries are disabled.
   Do not turn past decision marks into fresh entries when enabling.
4. Add meaningful setup, execution-cost and disabled-entry/continued-exit tests.
   Validate separately on unseen dates before enabling trading. The momentum
   scanner/replay remains research-only until it has an approved execution handler.

UI rows, history aggregation, settings storage and API validation are generated
from the registry; they do not need a new hard-coded checkbox per strategy.

## API and deployment

- `GET /api/strategies`: authenticated registry, saved revision and per-strategy results.
- `POST /api/strategy-settings`: authenticated JSON body with `strategy`, boolean
  `enabled`, and the `expectedRevision` from the last read. Stale revisions return
  HTTP 409. Unknown IDs/invalid shapes return 400. Same-origin checks and body limits
  match the existing dashboard controls. Changes are journaled as
  `strategy_settings_changed`.
- Build and restart the existing Compose service with `docker compose up -d --build`.
  Keep its existing `trading-data` volume; do not delete/recreate the volume or run
  a second paper engine against the same account. Reload the dashboard after the
  service is healthy. The initial migration preserves the configured selections.
