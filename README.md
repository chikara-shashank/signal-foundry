# Signal Foundry

Version 1.13 adds a [trade-return timeline](docs/TRADE-RETURN-CHART.md): time versus net return percentage, entry/exit markers, open-position bid marks, ticker/status filters and persistent forward observations. Additions and partial exits count together; stale prices and missing historical paths are explicitly labeled.

Version 1.12 adds opt-in [controlled additions to winners](docs/PYRAMIDING.md) for the two equity breakout strategies. The switches default off. Separate fill lots retain coordinated protection, combined positions count once in win rates, and paired executable-quote replay measures incremental net P/L and drawdown. This is a paper experiment with no established profitability.

Version 1.11 adds [full-universe equity discovery and breakout profit protection](docs/BREAKOUT-DISCOVERY.md). Provider runs screen all eligible listed stocks and ETFs, rotate a bounded streaming shortlist, and retain subscriptions for owned positions. New range-breakout and failed-breakout entries get versioned profit, invalidation and no-progress exits. These are forward paper experiments; the older losing results are retained separately by experiment version.

Version 1.8 adds persistent per-strategy switches and a **Strategies & results**
panel with realized net P/L, win rate, closed trades and separate open P/L.
Installed strategies can be enabled without restarting; switching off preserves
exit management and historical results. See [strategy controls and extension guide](docs/STRATEGY-CONTROLS.md).

The opt-in [small-cap momentum research lane](docs/MOMENTUM-RESEARCH.md) adds point-in-time screening, causal pullback replay, capital/settlement constraints and prospective validation gates. Run it through `research:momentum`; it is broker-free and is not enabled by `npm start`.

A local-first, autonomous price-action and quant research system for US stocks/ETFs and BTC/ETH spot. Six strategy worker threads share one portfolio authority. Jev evaluates setup coherence, market context, and contextual quality. Every order has a durable journal and risk checks.

**Start in demo, then Alpaca paper. The software includes live execution, but its strategy parameters have no established profitable edge.** It is a single-account research release, not a certified unattended trading product. See [verification](docs/VERIFICATION.md) for exactly what was exercised.

## First run — Docker

Requirements: Docker Desktop in Linux-container mode (or Docker Engine + Compose on Linux). Node 24.13+ is optional for the setup helper; the container alternative below needs only Docker.

From this directory:

```powershell
node scripts/setup.js
docker compose up --build -d --wait
```

Without Node, PowerShell:

```powershell
docker run --rm -v "${PWD}:/app" -w /app node:24.13.0-bookworm-slim node scripts/setup.js
docker compose up --build -d --wait
```

On macOS/Linux, replace the volume argument with `-v "$PWD:/app"`.

Open **http://localhost:8080**. Paste `DASHBOARD_TOKEN` from the newly generated `.env` into the login form. The demonstration uses synthetic accelerated data, no provider calls, and no real money. Six workers, rejection reasons, positions, orders, and controls are visible. Only qualifying setups generate orders; an empty portfolio is normal. The synthetic demo lacks dense quote-size observations, so it does not demonstrate the order-flow module's edge.

Version 1.5 adds shared paper-account accounting (`ACCOUNT_POLICY=shared`) and a live Jev input/output panel with exact future request bodies, typed responses, skipped-call reasons and final entry decisions. External holdings stay separate; account and agent P/L have explicit scopes. See [shared-account behavior and Jev I/O](docs/SHARED-ACCOUNT-AND-JEV.md).

Version 1.4.1 disables the combined position/pending-entry count cap by default (`MAX_POSITIONS=0`). Dollar exposure, cash reservations, same-symbol and loss controls still apply. Existing installations must also set `MAX_POSITIONS=0` in their `.env` and rebuild/recreate the container.

Version 1.4 adds a 100 ms target quote push, 1s/5s/15s trade-print candles, measured timing cards, and broker order-stream notifications. The decision pipeline, Jev activity, strategy checklists, live log, P/L and risk controls remain available. See [dashboard and real-data setup](docs/FRONTEND.md), [timing definitions and limitations](docs/REALTIME.md), and [the dashboard critique](docs/DASHBOARD-REVIEW.md). Adding keys does not change `MODE=demo`; select `MODE=paper` and recreate the container for real prices with paper-money orders. Rebuild the image when installing a source update.

```powershell
docker compose logs --tail=100 -f
docker compose stop
```

The persistent Docker volume survives stop/down. Do not remove it when orders or positions exist. Do not run multiple deployments against the same trading account.

## Connect your keys

Edit `.env`:

```dotenv
MODE=paper
ALPACA_KEY=YOUR_PAPER_KEY
ALPACA_SECRET=YOUR_PAPER_SECRET
ALPACA_FEED=iex
ALPACA_CRYPTO_LOCATION=us
JEV_MODE=shadow
TYPESAFE_API_KEY=YOUR_TYPESAFE_KEY
```

Use `JEV_MODE=off` to run without TypeSafe. `shadow` records Jev judgments while rules drive allocation; `filter` additionally requires its configured thresholds. Off and shadow are explicit baseline variants. Default thresholds are research settings, not validated win probabilities.

Use `ALPACA_FEED=sip` only with the appropriate data entitlement. IEX supports the small default universe; the broader SIP plan is preferable for consolidated volume research. Match crypto location and account availability to your state; remove crypto with `CRYPTO_SYMBOLS=` if unavailable.

```powershell
docker compose run --rm engine node scripts/doctor.js
docker compose up -d --force-recreate
```

Doctor performs read-only credential/account checks; it does not send an order. In paper mode the application sends simulated-money orders to Alpaca. For real market data with **no broker orders**, use `MODE=shadow`.

Since v1.6.1, equity minute bars are restored at startup (last 150 minutes) and short intraday stream gaps (up to 30 minutes) are repaired from Alpaca's historical bars for the same feed before continuity is checked. Every restore is recorded as a `bar_backfill` event; minutes without trades stay absent and nothing is interpolated. If historical bars are unavailable, expect roughly 30–45 minutes of continuous streamed bars before feature contexts are ready. Feed disconnects are recorded as `feed_disconnect` events, and reconnect backoff resets after a healthy session. Stocks follow the broker's regular-market clock, including early closes; spot crypto runs continuously. The process remains up across weekends.

## Included

- Six genuine worker threads: rolling range breakout, trend pullback, failed downside breakout, VWAP reversion, volatility expansion, and quote-triggered order-flow continuation.
- Best-quote imbalance, normalized OFI, microprice, transparent volatility regimes, and a synchronized pairs-research scanner.
- Shared numerical features; immutable candidate snapshots; strict stale-data and price-drift gates.
- Jev Noul/Choice/Score integration, pinned model, deadlines, rate controls, persistent monthly cost reservations.
- Cash-funded sizing, stop-risk budget, notional/group/position caps, persistent daily-loss latch, symbol cooldown.
- Alpaca equity bracket entries and crypto software exits; partial-fill and cancellation workflows.
- Persistent order intents, client-ID reconciliation, ambiguity pauses, ownership checks, and restart recovery.
- Token-protected dashboard, controls, health endpoint, authenticated metrics, rotating Docker logs, daily database backups.
- Interactive 1m/5m/15m charts, distinct signal/order/fill events, execution details, feed diagnosis, and a size-limited paper connectivity trade with a timed exit attempt.
- Replay, synthetic fixtures, candidate exports, research reports, tests, and AWS/GCP Terraform templates.

## Local development and tests

No third-party npm packages are required. Node.js 24.13.0 is the tested runtime. `node:sqlite` is experimental in this runtime; its warning is expected.

```powershell
npm run check
npm test
npm start
node scripts/replay.js fixtures/synthetic.jsonl replay-report.json
npm run report -- research-report.json
```

`npm start` loads `.env`. Docker supplies environment variables through Compose. Runtime databases are separated as `demo.sqlite`, `shadow.sqlite`, `paper.sqlite`, and `live.sqlite`; each also binds to an account identity.

## Documents

- [Goals and PRD](docs/PRD.md)
- [Chart and real-data setup](docs/FRONTEND.md)
- [Technical design](docs/TRD.md)
- [Four critique rounds](docs/CRITIQUE.md)
- [Operations and live-mode runbook](docs/RUNBOOK.md)
- [AWS and GCP deployment](docs/CLOUD.md)
- [Research and promotion protocol](docs/RESEARCH.md)
- [Walk-forward backtest, September 2026](docs/BACKTEST-2026-09.md)
- [Published intraday strategies, September 2026](docs/INTRADAY-RESEARCH-2026-09.md)
- [Quant strategies, HFT capability boundaries, and current research](docs/QUANT_STRATEGIES.md)
- [Verification and remaining checks](docs/VERIFICATION.md)
- [Provider references](docs/SOURCES.md)

## Live mode

Live mode requires `MODE=live`, live Alpaca credentials, the exact `EXPECTED_ACCOUNT_ID`, and `LIVE_ACK=I_ACCEPT_REAL_MONEY_RISK`. Crypto also requires `LIVE_CRYPTO_ACK=I_ACCEPT_SOFTWARE_EXIT_OUTAGE_RISK` or `CRYPTO_UNIVERSE=off`. These are explicit operator choices; the application never promotes itself from paper to live. Start by reading the runbook and completing provider paper checks.

Native equity stops can slip, and bracket children activate only after full entry fill. Crypto exits depend on this service, current market data for price triggers, and connectivity. A single VM is not highly available. Pausing new entries preserves position management; stopping the container does not close positions.

## Noise-area session strategy (v1.7)

Adding `noise_area` to `STRATEGIES` enables a long-only version of the noise-area breakout, the only published intraday rule that stayed positive after realistic costs in [the September 2026 tests](docs/INTRADAY-RESEARCH-2026-09.md) (QQQ: +3.4 bps per trade over 10.7 years).

How it works:
- Each session it loads the trading calendar and 14 prior sessions of 30-minute bars for `NOISE_AREA_SYMBOL`.
- At every :00 and :30 from 10:00 to 30 minutes before the close, it buys above the upper band and exits at the first check below max(upper band, session VWAP).
- Positions use a fixed `NOISE_AREA_NOTIONAL_USD`. The bar strategies leave that amount free while it is flat.
- A far `NOISE_AREA_STOP_BPS` bracket stop protects against outages. The normal session-end exit flattens anything left.
- Every check is recorded as a `noise_area_decision` event and shown in the strategy checklist.

Known gaps:
- Short signals are recorded but not traded, because the engine cannot hold agent short positions yet.
- Jev is not consulted for this strategy.
- In `shared` accounts an external holding in the symbol or its options reserves it, and the strategy then records `external_symbol_reserved` instead of trading.

## Jev decision-mode review

See [the v1.6 robustness review](docs/ROBUSTNESS-v1.6.md) for the revised five-minute crypto profile, IOC entries, request budgeting, strategy economics and forward Jev outcome measurements. The [earlier Jev review](docs/JEV-TRADING-REVIEW.md) explains the classifier's limitations. Neither release establishes profitable trading or exchange-grade HFT.
Options research is available in v1.9.0: three independently switchable, defined-risk spread hypotheses, OPRA/SIP collection, a separate hypothetical ledger, delayed bid/ask replay and frozen experiment hashes. No options orders are sent to Alpaca. See [research, rules, limitations and commands](docs/OPTIONS-RESEARCH.md). Options controls start off and require paper/shadow mode plus the relevant data access; existing stock strategy controls are unchanged.
# v1.10 audit remediation

See [the remediation and deployment guide](docs/AUDIT-REMEDIATION.md) for request-budget protection, durable execution incidents, version-filtered strategy results, broker-activity accounting, recovery tools and the remaining research/execution gaps. `scripts/deploy-paper.ps1` preserves the approved $2,000 paper daily-loss limit and verifies the new release before resuming entries. This release does not qualify any strategy for live trading or connect options broker orders.

## Session scheduling and next-session research (v1.14)

Provider equity fast data runs 09:00–16:00 New York time on actual exchange sessions; regular stock execution starts at 09:30 and early closes shorten the window. Crypto runs continuously using the global top 25 by market cap intersected with Alpaca tradable USD pairs. Use `CRYPTO_UNIVERSE=off` to disable new crypto buys; empty seed symbols no longer disable ranking.

The new Sessions & tomorrow panel shows the calendar, crypto selection, closing-pattern/news watchlist and carry allocation. Closing strength + news is a separately switchable paper/shadow strategy, with entries at 15:30–15:55, GTC brackets, a three-future-session deadline and a combined 9.5% engine-allocation cap including pending buys. Existing day trades keep their exits. Research evidence, exact thresholds, settings, tests and limitations are in [the v1.14 research and implementation review](docs/SESSION-RESEARCH-v1.14.md). No profitability or live qualification is claimed.
