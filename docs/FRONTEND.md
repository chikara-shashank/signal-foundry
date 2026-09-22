# Trading chart, decision log and real-data setup — v1.5

The dashboard and backend are one application at http://localhost:8080. There is no separate frontend service.

## Understand what happened

The pipeline distinguishes completed strategy checks, unique matched setups, actual Jev HTTP attempts, risk approvals, submission attempts and orders with observed fills. One check applies one strategy to one instrument snapshot; thousands of checks do not mean thousands of model calls or attempted trades. Counters reset with the engine process; retained journal totals are labeled separately. Accepted orders are not fills.

Select an instrument to see each strategy's latest conditions, actual values and thresholds. Expand a row for the full checklist. Jev shows mode, request/error/skip counts, in-flight work, the latest coherence/quality/regime result and latency. Shadow mode observes; filter mode can veto; Jev never submits an order itself. These scores are not win probabilities.

The live log includes sampled no-setup checks and rejected quotes, all new candidate/model decisions, order submission attempts, observed cumulative fills and controls. Filter by category, instrument or text. Freeze pauses only the log view. No-setup and invalid-quote events are sampled at most once per strategy/instrument/reason per minute to bound journal growth; process counters include all observations. The UI keeps 500 loaded events; older retained events remain in SQLite.

Bid, ask, spread and midpoint have separate labels. The midpoint is a reference, not the latest trade or a promised fill. Each quote identifies its source, provider time and age. Synthetic demo prices are artificial and must never be interpreted as Alpaca market prices.

## Clock calibration

Real-data modes calibrate the trading clock using Alpaca's authenticated HTTPS `/v2/clock` timestamp, then advance it using monotonic elapsed time. This handles a modest host offset without rewriting quote timestamps or weakening the existing stale/future checks. Reconciliation refreshes calibration approximately every five seconds plus API time. The dashboard displays calibration status and offset from the host.

Samples with round-trip time above one second, a host offset over five minutes, invalid timestamps or a discontinuity over one second are rejected. Calibration expires after 60 seconds. New entries are blocked immediately when calibration is unreliable, including between reconciliations. Quote timestamps never calibrate the clock. Keep Windows and the Docker host time synchronized; provider calibration is not a substitute for healthy infrastructure or an HFT timing guarantee.

## Why keys alone do not show real prices

`MODE=demo` intentionally ignores market-data keys and generates synthetic accelerated prices. It also simulates its trades locally. The mode badge, source banner, execution tape and chart label now make this distinction explicit. `JEV_MODE=off` similarly leaves Jev disabled even when a key exists.

For real market data with simulated-money Alpaca orders, edit the **same project's** `.env`:

```dotenv
MODE=paper
JEV_MODE=shadow
ALPACA_FEED=iex
```

Supply that account's Alpaca paper keys and your TypeSafe key. `JEV_MODE=shadow` records model judgments; `filter` additionally gates discovered strategy entries. The operator paper connectivity test does not use Jev. Then run:

```sh
docker compose run --rm engine node scripts/doctor.js
docker compose up --build -d --force-recreate --wait
docker compose logs --tail=100 engine
```

Rebuild is necessary to install changed application source. Recreate is necessary to reload `.env`. Refresh the browser and use the dashboard token from that active `.env`.

If multiple extracted copies exist, locate the running container's project directory without printing credentials:

```sh
docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' signal-foundry-engine-1
```

Source updates exclude `.env` and databases; preserve both when updating. Never delete the Docker volume to change modes.

## Chart controls

- Select a configured instrument and 1s, 5s, 15s, 1m, 5m or 15m candles.
- Zoom with the controls or mouse wheel, move through recorded history with arrows, and return with Follow latest.
- Hover candles for OHLC/volume. Select chart markers or execution-tape events for strategy, reason, order ID and Jev context.
- Green/red triangles represent cumulative buy/sell average fills. Accepted orders appear in the tape but never masquerade as fills.
- Blue/purple dots distinguish approved/rejected candidate signals. The signal decision time is used, not the preceding bar's start.
- Current bid/ask lines and selected-position bid marks use authenticated streaming with a 100 ms push target. The heavier dashboard refreshes every two seconds, also serving as a price fallback during stream outages. A quote-only line is shown before the first candle.
- Average entry, stop, target and pending limit levels appear when available. Distant levels do not force an unreadable price scale.
- EMA9/EMA21 overlays use the selected display interval. Strategy computation remains based on its one-minute features.

The chart shows up to 240 candles. Minute intervals read recorded provider bars from the journal, with incomplete 5m/15m groups outlined. Second intervals aggregate actual received trade prints in memory; forming candles are outlined and empty intervals are omitted. These prints include reported sale conditions, so they are not official Alpaca bar aggregates. Short history resets on reconnect, and no backfill is invented. Fresh quotes can appear before the first candle and before strategy warmup completes. Older v1.0 live records without recorded fill timestamps remain in the tape with an unavailable timestamp; no chart time is fabricated.

The **Measured timing** panel separates feed age, estimated dispatch-to-draw delay, canvas update time, numerical worker time, Jev HTTP attempt time, and broker HTTP acknowledgment time. It reports median/p95 and sample counts; no measurements appear as a dash. Clock uncertainty is shown explicitly. Chart refresh rate does not establish order-execution latency. See [REALTIME](REALTIME.md) for definitions and verification.

In paper/live modes, broker order-stream notifications enter the log and trigger reconciliation after a coalesced 250 ms delay. The five-second reconciliation loop remains as a fallback. A notification may concern an external order; ownership, chart fill markers and positions still require the existing coordinator's reconciliation.

## External account activity

The reconciliation panel lists positions without a matching local entry, holdings whose quantities differ from the local fill journal, and unmatched open broker orders. Dedicated policy blocks external holdings globally. Shared paper policy permits unrelated external holdings but reserves their symbols and option underlyings; unmatched open orders and managed-quantity conflicts still block new entries. Configured strategies support equities and BTC/ETH spot; existing option contracts are external holdings. The account-positions table labels ownership explicitly. The engine does not adopt, close, or reset those holdings through a dashboard setting. If another instance created the orders, restore its matching journal; otherwise reconcile the external activity separately in the brokerage account. Do not delete the trading volume to clear this gate.

## Jev I/O and account scopes

Use **Jev I/O** in the pipeline links for live request bodies, validated responses, measured latency/cost, skipped-call reasons and the actual final entry decision. Historical rows disclose missing original request payloads. The panel refreshes every two seconds; freezing the view does not pause trading.

Under `ACCOUNT_POLICY=shared`, external holdings appear as monitored separately. Agent exposure, estimated P/L and cash ceiling have their own panel. The P/L chart offers **Agents only / Entire account**; the daily-loss line appears only on the active risk scope. See [shared-account operations](SHARED-ACCOUNT-AND-JEV.md).

## Position count

`MAX_POSITIONS=0` disables the combined open-position and pending-entry count limit. The dashboard exposure card reports **No position-count cap**, and `/api/status` exposes `limits.maxPositions: null`. Positive integer values from 1 through 50 opt back into a count cap. A fresh configuration defaults to zero; an existing explicit value remains effective until changed and the container recreated.

This does not permit unlimited dollar exposure or duplicate allocations to the same instrument. Per-position, gross and group dollar limits, actual cash and buying power, pending reservations, cooldowns, reconciliation and daily-loss gates still apply. The configured instrument universe and one-allocation-per-symbol rule also bound simultaneous positions.

## Editable daily loss ceiling

Under Entry gates, enter a dollar amount and choose **Save ceiling**. The authenticated endpoint accepts $1–$100,000 with at most two decimals, persists the override in the mode/account journal, and audits changes. The saved dashboard value takes precedence over `DAILY_LOSS_USD`; changing the environment default does not erase the override. Conflicting edits from another tab are rejected.

Lowering the ceiling beneath the currently observed daily loss immediately blocks entries; cancellation and managed-position exit handling run on the next reconciliation. Once triggered, the halt remains for that New York date, even if the ceiling is raised or Resume is pressed. Dedicated-policy daily loss uses account-wide change from the first account equity observation that date, including external holdings and cash transfers. Shared-policy daily loss uses only the agent ledger from its first valid observation that date, with estimated trading fees and external activity excluded. It is not a per-strategy realized-profit counter.

## Live P/L visualization

The price chart connects matched entry and exit fills, with green/red connectors for gross gains/losses before fees. Current-position shading and an open-P/L readout use a fresh bid mark and the last reconciled quantity; stale quotes fall back to the labeled broker position mark. Order acceptance alone never creates a fill marker.

The account-performance panel plots daily equity change and unrealized P/L across all holdings, including external positions. Paper/live figures come from broker reconciliation; demo/shadow figures come from the local simulator. Account history is sampled at most every five seconds and persists across restarts. The panel refreshes every five seconds; actual broker reconciliation takes five seconds plus API processing time. It shows the latest six hours within the New York date and breaks lines across missing observations. Cash transfers can change the equity line; neither line asserts strategy profitability. Legacy history without unrealized P/L leaves that series unavailable instead of inventing values.

## Paper connectivity trade

In **paper mode only**, the execution tape exposes **Send paper test trade**. It is an explicitly tagged operator test, not an alpha signal:

- At most one equity share, capped by the configured position limit, or $25 crypto notional. A symbol with a share price above the limit is rejected.
- Fresh quotes, account readiness, market session, spread/cost, capacity, daily loss and operator pause checks remain mandatory.
- No historical strategy warmup or model classification is required for this connectivity test.
- At most one new request per minute; an ambiguous HTTP result retries the same request ID instead of placing another trade.
- The existing coordinator attempts an exit after 60 seconds. Equity protective legs must cancel and reconcile before an independent sell; completion can take longer and must be verified in the tape and brokerage account.
- The endpoint is rejected in demo, shadow and live modes, including when called outside the UI.

Automatic strategy entries still require real qualifying setups. Manual paper tests are labeled `operator_paper_test`; separate them when assessing strategy results. Real-money order execution is not part of this demonstration.

## Feed diagnosis

The source banner shows mode, execution destination, session state and feed status. A successful account check does not establish streaming entitlement. Provider subscription/authentication errors now survive the reconnect display. The feed detail includes the most recently received market timestamp and its age at receipt to distinguish a connected socket from timely data. IEX and SIP have different entitlements; do not select a paid feed without its subscription. Stock quotes depend on market activity, while supported crypto is continuous. No missing data is fabricated.

Provider reference: [Alpaca real-time stock data](https://docs.alpaca.markets/us/docs/real-time-stock-pricing-data) and [stream authentication/errors](https://docs.alpaca.markets/us/docs/streaming-market-data).
