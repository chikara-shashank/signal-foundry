# Signal Foundry — technical requirements and design

Version 1.0 · implementation contract

## Architecture

Node.js 24.13+ ESM, built-in HTTP/fetch/WebSocket/worker threads, SQLite WAL with FULL synchronous durability. No third-party runtime packages. This keeps installation deterministic and the initial dependency surface small. The Node SQLite interface remains experimental in the pinned runtime; upgrades require tests. One Docker service hosts the dashboard, a market-data receiver, six isolated numerical workers, Jev evaluation, and a serial account coordinator. SQLite is a local persistent-volume database, never a shared network filesystem. Replicas must remain one.

```
Alpaca bars + quotes -> validated shared features -> six worker threads
                                                  -> candidate records
                     Jev typed evaluations <------+
                               |
                     serial portfolio coordinator
                     durable intent -> broker adapter
                               ^          |
                               +-- reconciliation
Dashboard / audit / replay <------ SQLite
```

## Contracts

Quote: symbol, UTC event time, bid, ask. Bar: symbol, start time, OHLCV; considered available only after its one-minute interval ends. Feature snapshots include a monotonically increasing symbol version. Candidate: stable ID, strategy/version, symbol, created/expires timestamps, entry reference, stop, target, features. No model may modify these numeric execution fields.

Order intent: stable client order ID, candidate ID, side, quantity, limit, status, requested time, broker ID, raw normalized outcome. Persist SUBMITTING before HTTP. HTTP failure after a write is ambiguous; look up by client ID, retain reservation, and pause entries until resolved. Do not blindly retry POST. GET retries occur through the next reconciliation cycle. Cancel requests do not release reservations until terminal broker acknowledgment.

Order states include RESERVED, SUBMITTING, UNKNOWN, NEW, PARTIALLY_FILLED, FILLED, CANCELED, EXPIRED, REJECTED. A filled entry is terminal as an order but its position remains allocated. Protective child orders are associated with the parent. Uncertain order outcomes and inconsistent managed quantities pause entries. Dedicated policy also blocks external positions; shared paper policy reserves their symbols/option underlyings, excludes their P/L from agent limits and never adopts them.

Entry fills also retain reservations until reported position quantity and a persistent gross cash-flow upper bound reconcile. This includes canceled partial fills. Broker endpoints are not an atomic snapshot; the gross cash bound excludes exact fee/corporate-action accounting and is a conservative discrepancy check, not a full ledger. Unexpected positive cash adjustments pause entries for investigation.

## Concurrency and persistence

Each strategy has a bounded worker queue; all receive the same immutable features. Candidate processing is bounded and serial at allocation. Recheck quote freshness, mode, operator pause, price drift, current account snapshot, and capacity after any model call. Reconciliation, exits, and order commits share a mutex; model calls and feature calculation do not hold it. Quotes continue updating during network calls.

SQLite stores bars, candidates, intents, simulated positions/cash, equity checkpoints, model reservations, audit events, settings, and an engine lease. A transactional renewable lease prevents concurrent coordinators on the same database. Failure to renew or database failure terminates the process. A lease does not prevent a second deployment using a different disk: use exactly one deployment per account and do not manually trade engine-owned symbols. Shared paper-account constraints are specified in [SHARED-ACCOUNT-AND-JEV](SHARED-ACCOUNT-AND-JEV.md).

Data is partitioned by mode and account identity. Persistent configuration fingerprint records changes. Daily loss reference persists by New York calendar date; cross-day reset does not clear an operator pause. Default exposure is cash-funded and bounded by configured capital budget and actual broker cash/non-marginable buying power. New entries are blocked on account/trading restrictions.

## Market processing

One connection per selected equity feed and one crypto connection, with bounded buffering, authentication checks, reconnect backoff, and quote validation. Completed bars are persisted once; late duplicate/correction data does not retrigger an already evaluated interval. Freshness compares provider event time with local UTC, not arrival time alone. Gaps reset feature warmup. Equity session eligibility uses the broker clock, including early closes. Session end starts a managed flatten workflow; crypto remains eligible continuously. On startup reuse recent recorded bars for context; fresh quotes and account reconciliation are still mandatory.

Features: EMA9/21, ATR14, 20-bar range, relative volume, rolling 60-bar volume-weighted typical price, fully closed 5m/15m summaries. The VWAP feature is explicitly rolling, not exchange session VWAP. Minimum 30 contiguous bars; longer contexts become available as history accrues. Missing bars are not fabricated.

Quant extension: rolling VWAP deviation, directional efficiency, volatility ratio, compression and a transparent regime heuristic. Best-quote prices/sizes update five-second bounded OFI/depth/microprice state. One order-flow worker can scan at a configurable 250ms per-symbol throttle, with a two-second candidate TTL and a one-second microstructure freshness recheck. Bar strategy workers are not rerun on every quote. Pair diagnostics synchronize timestamps, fit only prior log prices, and never enter the order path. Broker reconciliation and software-exit management run on a five-second loop plus request time, not a sub-second execution SLA.

## Risk and execution

Per-trade dollars at stop, per-position notional, aggregate gross notional, asset-class group cap, optional position-count cap (disabled with MAX_POSITIONS=0), daily equity loss, symbol cooldown, spread, estimated round-trip costs, minimum reward/cost ratio, and slippage tolerance. Use asset metadata for crypto lot and price increments, integer shares for equity brackets. Only buy-to-open and sell-to-close. Live mode requires dedicated policy. Shared paper mode sizes against owned exposure, pending reservations, a conservative agent cash ceiling and actual broker cash/buying power. Its daily loss uses owned fills and marks with estimated fees, excluding external holdings. Exit quantity uses reconciled available position quantity, including crypto fees.

Alpaca equity entry uses a marketable limit with bracket take-profit and stop. Entry TTL cancels unfilled orders. Canceled partial entries trigger managed reduction. Normal equity protection prefers active native legs; timed/session/operator exits cancel native legs, wait for acknowledgment, reconcile quantity, then sell. Never send an independent sell while a potentially active native sell remains. Crypto uses simple limit entries and software stop/target/time exits; live crypto opt-in explicitly accepts outage exposure. Protective orders and account-level limits cannot guarantee bounded losses during gaps/outages.

## Jev

From v1.5 the coordinator prechecks candidate eligibility before a paid call, then rechecks immediately before submission. SQLite `model_traces` captures sanitized exact request bodies, validated answer fields, status/usage/cost and errors; authenticated list/detail routes link traces to the candidate decision. In-flight traces interrupted by restart retain an unknown billing reservation. UI polls every two seconds. History without exact HTTP input is explicitly labeled.

POST /v1/systemone with pinned jev-1.13.0 and all three typed questions: Noul setup coherence, Choice context classification, Score contextual quality. Normalize Score against returned level indices. Strict response validation, deadline, concurrency cap, request/minute cap, and persistent conservative budget reservations. Timeout/429/schema failure rejects filter-dependent entries; shadow/off behavior is explicit. Unknown-billed requests retain their reservation. Record actual reported usage when available. Budget estimates are not a provider billing guarantee; account billing remains authoritative.

No research LLM in the execution path. Optional future LLM analysis can consume exported records offline; this release makes no paid general-LLM calls.

## Security and operations

Dashboard binds to localhost on host through Docker. Bearer token required for API data and controls; token entered in the browser stays in session memory. No credentials in static files, JSON status, events, or errors. Same-origin controls, bounded bodies, CSP, no arbitrary URL proxies, hardcoded provider HTTPS hosts. API limits candidate/event counts. Health endpoint discloses liveness only. A watchdog exits a stalled engine so Docker restart can recover; a healthcheck alone does not restart a container. Graceful shutdown stops entries and preserves native exits; it does not claim to flatten during process termination.

Cloud: single AWS EC2 or GCP Compute Engine VM, encrypted disk, private dashboard reached through SSH/SSM/IAP tunnel; never Cloud Run/Lambda autoscaling. Boot installs Docker, source is copied separately, secrets supplied on host or from the cloud secret store. No keys in Terraform, VM metadata, or source archive. Nightly consistent SQLite backup with bounded retention; copy off-host using the documented cloud commands. Infrastructure billing alerts are separate from model caps.

## Validation

Unit/property-like boundary tests: invalid numerics, stale timestamps, feature lookahead, strategy conditions, cost and sizing boundaries, budgets, lease collisions. Integration tests: broker timeout after acceptance, partial fills, cancellation races, restart, duplicate IDs, external positions, model failure, account mismatch, API authentication. Deterministic replay and HTTP/demo smoke tests. Docker build/run and credential-backed integration status must be reported truthfully.
