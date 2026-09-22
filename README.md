# Signal Foundry

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

Expect roughly 30–45 minutes of continuous bars before all feature contexts are ready after a cold start or gap. No historical backfill is silently substituted. Stocks follow the broker's regular-market clock, including early closes; spot crypto runs continuously. The process remains up across weekends.

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
- [Quant strategies, HFT capability boundaries, and current research](docs/QUANT_STRATEGIES.md)
- [Verification and remaining checks](docs/VERIFICATION.md)
- [Provider references](docs/SOURCES.md)

## Live mode

Live mode requires `MODE=live`, live Alpaca credentials, the exact `EXPECTED_ACCOUNT_ID`, and `LIVE_ACK=I_ACCEPT_REAL_MONEY_RISK`. Crypto also requires `LIVE_CRYPTO_ACK=I_ACCEPT_SOFTWARE_EXIT_OUTAGE_RISK` or an empty crypto universe. These are explicit operator choices; the application never promotes itself from paper to live. Start by reading the runbook and completing provider paper checks.

Native equity stops can slip, and bracket children activate only after full entry fill. Crypto exits depend on this service, current market data for price triggers, and connectivity. A single VM is not highly available. Pausing new entries preserves position management; stopping the container does not close positions.

## Jev decision-mode review

See [the September 22 Jev trading review](docs/JEV-TRADING-REVIEW.md) for verified filter behavior, v1.5.1 context/deadline changes, broker throughput limits, cost calculations and the evaluation plan for higher-frequency strategies.
