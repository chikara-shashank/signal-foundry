# Signal Foundry — product requirements

Version 1.0 · 22 September 2026 · US own-account deployment

## Goal and success criteria

Build a reproducible, observable trading laboratory that can graduate to a small autonomous account. Six parallel strategy workers inspect shared price/volume and best-quote features. One account authority controls orders. Jev's contribution must be measurable; profitability is an experimental outcome, never a release assertion.

| ID | Goal | Acceptance criterion |
|---|---|---|
| G1 | Easy first run | Docker Compose starts a deterministic demonstration with no credentials; real-data modes require only environment configuration and provider entitlements. |
| G2 | Parallel discovery | Six registered strategies run in separate worker threads on immutable snapshots; order-flow continuation can scan between bar closes. |
| G3 | Controlled autonomy | Every entry passes freshness, execution-cost, allocation, optional position-count, session, and loss gates. Unknown order outcomes block further entries. |
| G4 | Recoverable operation | Decisions and order intents persist before submission; restart reconciles broker orders and positions before enabling entries. |
| G5 | Measurable Jev value | Noul, Choice, and Score outputs, version, latency, cost, request body, skip reason and final entry outcome are visible against each candidate. Exact requests are captured from v1.5 onward; historical context is labeled. Off/shadow/filter modes are explicit. |
| G6 | Affordable operation | Plan approximately $350/month, under $500 infrastructure/model budget; persistent model budget reservation prevents repeated spending after restart. |
| G7 | Reviewable release | PRD, TRD, four critique rounds, adversarial tests, local runbook, AWS/GCP templates, and a verification report ship with source. |

Planning allocation, excluding trading capital, trading fees and engineering labor:

| Category | Monthly planning amount |
|---|---:|
| VM compute allowance | $80 |
| Disk and snapshots | $30 |
| Consolidated equity data option | $99 |
| Jev budget cap | $60 |
| Monitoring and off-host backup allowance | $20 |
| Contingency | $61 |
| Total | **$350** |

Only the data-plan amount is a checked published price; the cloud/operations amounts are planning allowances, not current quotes. The default IEX feed can reduce data cost during engineering tests. Jev's code enforces its own configured cap; it does not cap cloud or broker bills. See SOURCES and CLOUD for the assumptions.

## User and scope

One technically capable owner, one Alpaca account, one active engine. Dedicated ownership is the default; a shared paper-account policy may isolate pre-existing external holdings using an explicit agent ledger. Equities during regular sessions and spot crypto around the clock, subject to venue availability. Start with a small configurable liquid universe; scale to 50 only after feed/load measurements. Long positions only, no leverage, short selling, options, derivatives, market making, or customer account management. Running 24/7 does not mean US stock orders execute outside their session.

Modes: **demo** uses synthetic quotes/bars and local fills; **shadow** uses Alpaca market data with local simulated execution; **paper** routes to Alpaca paper; **live** routes to Alpaca live only with explicit acknowledgment and expected account ID. State is isolated by mode and broker account. A live configuration is not evidence of strategy profitability.

## Strategies and hypotheses

1. Rolling range breakout: close exceeds a prior range with relative volume and positive trend context.
2. Trend pullback: a retracement tests the fast average within a rising trend, then closes back above it.
3. Failed downside breakout: price probes a prior low and closes back into the range. This is the long-only reversal variant.
4. Rolling VWAP reversion: a negative deviation in a range regime begins reversing toward its volume-weighted reference.
5. Volatility expansion: a compressed range expands with volume and directional confirmation.
6. Order-flow continuation: fresh best-quote imbalance/OFI/microprice context supports a short-horizon trend continuation. Requires quote sizes and adequate event density.

Synchronized relative-value diagnostics are a research-only scanner. No two-leg arbitrage execution or HFT-grade exchange access is claimed. See QUANT_STRATEGIES.md for the expanded capability matrix and recent research requirements.

Use closed one-minute bars, rolling VWAP proxy, ATR, EMA, range levels, and completed five/fifteen-minute aggregates. Features are computed numerically. Parameters are fixed in a versioned configuration, not edited by a live LLM. Initial parameters are research hypotheses and have no fitted success probability. A reward/cost gate is explicitly not an expected-value estimate.

## Required flows

- Configure mode, universe, fee assumptions, capital budget, and risk limits.
- Inspect feed freshness, workers, positions, order states, rejected candidates, model budget, and account readiness in a local dashboard.
- Pause/resume new entries without disabling exits. Cancel pending entry orders separately. Flatten managed positions through an explicit control.
- Replay recorded or imported events in timestamp order. Fills cannot occur on the observation that generated the order.
- Export an audit trail and a research report. Review rules-only versus Jev-filtered candidate outcomes before promoting a model.
- Restart the engine without silently clearing daily loss limits, pending orders, operator pause, or model spending.

## Operational acceptance

No order on stale/crossed/invalid quotes, no duplicate candidate after restart, no capital reuse while an outcome is ambiguous, no credential in the dashboard/log, no model dependency for exits, no automatic live-mode switch, no web-exposed control port by default. Account mismatch and missing live acknowledgment are startup failures. Cloud VM uses persistent disk, restart policy, restricted inbound access, rotating logs, backups, and documented restoration.

Live crypto software exits require a separate acknowledgment: Alpaca crypto lacks the equity bracket flow used here. A host/network outage can delay those exits. Equity brackets also do not guarantee a stop execution price, and partially filled entries can temporarily lack active bracket children. These limitations must appear in setup and the dashboard.

## Financial and research acceptance

An initial release is accepted on engineering tests and provider paper validation, not P&L. Promotion requires untouched chronological evaluation, realistic fees/spread/slippage, drawdown limits, multiple market conditions, and sufficient independent observations. Report open exposure, sample size, gross and net results, and cost assumptions. Track infrastructure costs separately from trading returns. No autonomous parameter optimization or automatic capital scaling.

## Delivery assumptions

The owner provides data entitlements, eligible account access, and cloud credentials. Deployment files do not create paid resources until explicitly run. A single-VM deployment is budget conscious but not highly available. Restoring a backup always requires broker reconciliation. Native-provider integrations require account-backed testing; mock tests cannot certify an account's permissions.
