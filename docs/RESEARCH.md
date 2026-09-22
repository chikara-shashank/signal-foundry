# Research protocol

The six strategies are explicit hypotheses. Their parameters and Jev rubric have not been fitted, calibrated, or shown profitable. Technical tests demonstrate software behavior, not alpha. See QUANT_STRATEGIES.md for data requirements and papers reviewed.

## Replay

`fixtures/synthetic.jsonl` is a deterministic artificial market. Run:

```sh
node scripts/replay.js fixtures/synthetic.jsonl baseline-report.json
```

Each JSONL line is a quote or bar with `symbol`, UTC epoch-millisecond `now` (when observable), and `ts` (provider event/bar-start time). Quote fields: bid/ask. Bar fields: open/high/low/close/volume. Input must be sorted by `now`; a bar cannot be processed before `ts+60000`. Include actual quotes after the decision time if fills are to be evaluated. Replay does not invent missing quotes or fill on the same observation that generated an order. Stocks in imported replay must already be filtered to your intended historical sessions. The simulator's session clock is permissive; it is not a historical holiday calendar.

Real-time journal `market_sample` events retain one bar plus its contemporaneous quote. They are useful for feature audits, but are **not** a complete tick recording. They cannot reproduce intraminute stop paths or queue behavior. Purchase/import appropriately licensed quote history for higher-fidelity execution research. No historical-data download or licensing entitlement is implied by this repository.

## Model comparison

Use `JEV_MODE=shadow` on a fixed configuration to collect model answers alongside candidate events. Export with `npm run report -- report.json`, which also produces `report-candidates.json`. A replay can apply those recorded answers without making new API calls:

```sh
node scripts/replay.js SAME_EVENTS.jsonl rules-report.json
node scripts/replay.js SAME_EVENTS.jsonl jev-filter-report.json report-candidates.json
```

Candidate IDs include strategy/version/symbol/bar timestamp. Missing Jev records fail closed in the filtered replay. Ensure identical features, timestamps, universe, limits, and cost assumptions between runs. A difference in the number of trades is part of the result; compare net portfolio outcomes and opportunity cost. The replay must use a separate untouched evaluation period after rubric/threshold selection. An optional numerical ML baseline is a future research extension; no trained predictor ships here.

## Promotion evidence

Record number of independent trades and days, per-strategy net P&L, time under water, tail losses, drawdown, turnover, fill/cancel rates, missed signals, and results split by regime. Cluster inference by day/session rather than assuming all trades are independent. Keep a register of attempted parameter/model variants to expose selection bias. Use chronological walk-forward validation and a final untouched period; do not shuffle overlapping observations.

The generated report includes counts, estimated fees, trade results, recorded equity drawdown, model outcomes, rejection reasons, and open positions. It is descriptive and does not perform a statistical significance test, correct multiple comparisons, certify profitability, or reconcile a tax ledger. Stock regulatory fees and crypto fee deductions need comparison with actual broker activities. Simulated slippage and spread are assumptions; market impact and queue position are not modeled.

Graduate one frozen strategy to a small live pilot only after sufficient independent evidence, engineering validation, and an explicit capital decision. Check realized execution against simulation. Evaluate monthly system surplus after infrastructure/data/model cost. Never increase position size just to cover operating expenses. Spend more only when a measured bottleneck or validated experiment justifies it.
