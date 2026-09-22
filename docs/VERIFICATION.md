# Verification record

## v1.5.1 context, deadlines and session identity

All 103 tests pass with zero failures or skips, and all JavaScript passes syntax validation on Node 24.13.0. Seven new tests cover setup-specific context, remaining time windows, pre-request expiry, abort and unknown billing, late valid responses, clock-independent session counts, and filter-approved automatic entry after fresh preflight timing. The source changes preserve existing trade and risk settings. After the user rebuilt, authenticated HTTP checks confirmed v1.5.1 ready with JEV_MODE=filter. Existing credentials/configuration and the trading journal were unchanged by source installation. The refreshed authenticated browser subsequently showed v1.5.1, filter mode, the corrected session counters, rubric and request-window metadata, and the approved AMZN trace, with no console errors observed. At 14:33 ET the run had 27 model requests, 1 passing context verdict and 26 declining verdicts; 13 other candidates skipped HTTP at preflight. The matching AMZN range-breakout entry was filled for one paper share at $255.61, with coherence 0.91, normalized quality 0.935 and about 570 ms model duration. A current NVDA request showed the new rubric and a 945 ms remaining request window. API view counters correctly excluded earlier-session records. These sampled integration results do not establish economic benefit. No order or inference was manually submitted for verification.

## v1.5 shared paper account and Jev I/O

All **96 tests pass**, with zero failures or skips, and all JavaScript passes syntax validation. New cases cover external options/underlying reservations, separate agent P/L, legacy versus agent loss halts, stale cash and external transfers, owned-quantity discrepancies, restart persistence, model prechecks and post-response rechecks, shadow versus filter outcomes, authenticated trace access, payload redaction, historical disclosure and bounded retention.

A private UI fixture with no provider access verified the shared-account panel, exact input/typed-output layout, historical-request disclosure and account/agent chart scope switching. Fixture values and responses were explicitly labeled synthetic, and were never inserted into the active trading journal.

Read-only inspection of the running v1.4.1 journal found real historical shadow-mode Jev responses, including approximately 237–606 ms HTTP durations. Those inspected candidates were rejected at allocation, so they establish API use, not profitable contribution. Exact historical HTTP inputs were unavailable. No broker orders or additional paid Jev calls were manually generated for this release verification.

Authenticated checks confirmed v1.5.0 healthy, shared paper accounting enabled, external QQQ options retained and the equity, crypto and order streams connected. Automatic AAPL and MSFT paper entries received fills while Jev remained in shadow mode. After the user recreated the container, JEV_MODE=filter was verified: a PLTR candidate reached Jev (about 591 ms) and was rejected by its model filter. No broker order or additional model inference was manually triggered for these checks. The actual authenticated dashboard displayed the new Jev I/O panel. Docker engine-pipe access remains denied to this session.

## v1.4.1 optional position-count limit

All **79 tests pass** with zero failures or skips, and JavaScript syntax validation passes. `MAX_POSITIONS=0` disables the combined open-position/pending-entry count cap and is the default for new configurations. The status API represents an unlimited count as `limits.maxPositions: null`; the exposure card labels it **No position-count cap**. Explicit positive integer caps remain supported for compatibility.

New regression checks demonstrate more than four pending entries across distinct instruments, exercise unlimited-count sizing with both held positions and pending entries, verify that reserved funds and gross/group/cash limits still block insufficient capacity, preserve same-symbol exclusions, and reject invalid count settings. The existing optional-cap and reconciliation tests continue to pass. This is a software behavior check; no provider orders were placed to exercise the change. Installing this source and setting the active `.env` to `MAX_POSITIONS=0` require a Docker rebuild/recreate before the running engine changes.

After the user rebuilt the container, authenticated checks confirmed the active **v1.4.1** paper engine returns `limits.maxPositions: null`, `/healthz` HTTP 200, and connected equities, crypto and order streams. The source installation changed only `MAX_POSITIONS` in the user's environment; other environment content and trading data were preserved. Existing external-account and daily-loss gates remained active. Docker engine-pipe access was denied to this session, so deployment was performed by the user and verified over the app's HTTP API.

## v1.4 quote streaming, short candles and measured timing

All **76 tests pass**, with zero failures or skips, and all JavaScript passes syntax validation on Node 24.13.0. New checks cover authenticated quote/bar-delta streaming, slow-client backpressure, freshness, exact 64-bit trade IDs, nanosecond ordering including corrected prints, duplicate/canceled prints, bounded history, reconnect coverage, paper binary order notifications, sanitized log fields, coalesced reconciliation, and stale browser selections/snapshots.

A separate paused shadow process consumed real IEX NVDA/SPY quotes, trades and minute bars. Browser checks verified one-second and fifteen-second candles, symbol switching, streaming bid/ask, and the final timing layout. Sampled browser update cadence was approximately 108 ms median and 113 ms p95 against a 100 ms scheduling target. Measured delivery ranges include clock uncertainty; unobserved Jev and broker-submission durations remain unavailable. A read-only paper trading WebSocket check authenticated and confirmed the trade-updates subscription. No broker orders or Jev inference calls were generated by this verification. See [REALTIME](REALTIME.md) for definitions and limitations.

The active source was copied with all source/browser/test files hash-matched, the `.env` hash unchanged, and original changed files backed up under `work/active-source-before-v1.4`. Trading journals and Docker volumes were untouched.

The user rebuilt the v1.4 image and reported an initial unhealthy result. Subsequent authenticated checks of the actual port-8080 deployment confirmed **v1.4.0**, `/healthz` HTTP 200, SIP equities/US crypto/trading-order streams connected, and one-second NVDA candles. Twelve sampled SSE frames had fresh quotes and a trusted clock, with median arrival spacing approximately 100 ms. The app was alive but new entries remained blocked by external account activity and a previously triggered daily-loss halt. Docker's named-pipe access remains denied to this session, so the health-check history/root cause and Docker's current health status could not be independently inspected. No cloud deployment, full-universe market-open load test, or long-running soak was performed.

## v1.3 decision visibility and quote provenance

All **62 tests pass**. New coverage checks numerical evaluations versus setup matches, exact unmet thresholds, real model request counts versus skips, model error redaction, sampled logs with complete counters, fill deduplication, log cursor/filter/auth bounds, host skew correction, clock expiry/discontinuity/RTT rejection and immediate entry blocking if time calibration becomes unreliable. See [dashboard review](DASHBOARD-REVIEW.md) for the critique and observed production symptoms.

Authenticated read-only calls verified Alpaca SIP/IEX latest quotes, US crypto latest quotes and the paper clock on 22 September 2026. The host was about 18 seconds behind the provider; the existing paper engine discarded quotes as future-dated. The stopped demo on 8091 was generating unrelated synthetic prices. It must not be used to assess this account or its market-data plan. No provider-paper or real-money order was submitted by these checks. Docker named-pipe access was denied to this session; deployment and stream behavior must be verified after the actual container is rebuilt.

An isolated, paused shadow run also verified authenticated **SIP and US crypto WebSocket subscriptions** with real quotes for the 15 configured symbols and completed one-minute bars. With calibration, observed SPY quote age was approximately 40–130 ms in sampled checks, versus a host-clock age near −18 seconds. These are sampled feed ages, not an order-execution or strategy-latency benchmark. The browser rendered the actual bid/ask/midpoint, provider/source/age, clock offset, warmup state, Jev-off state, process pipeline and log. This test used a separate local simulator with entries paused and Jev disabled; it was stopped after verification. The actual paper container still requires rebuilding.

The active source was updated to v1.3 and its `.env` changed only from `ALPACA_FEED=iex` to `ALPACA_FEED=sip` after entitlement checks. Other environment content was verified identical; database files and Docker volumes were untouched. Original changed source files were backed up under the workspace `work/active-source-before-v1.3` directory.

## v1.2 risk controls and P/L

All **51 tests pass**, including persistent daily-loss edits, immediate entry blocking after a lower ceiling, a halt preserved after raising it and restarting, conflicting dashboard edits, auth/origin/body-size checks, external-holdings details without adoption or liquidation, bid-marked position P/L, matched entry/exit P/L, quote history without fabricated candles, and P/L history extrema/date/staleness. Syntax validation passes. The synthetic demo was exercised in the browser: the daily-loss setting saved, the entry-gate value and performance panel updated, candle/fill connectors rendered, and the P/L lines showed changing equity and open-position marks. Synthetic results are not market performance.

The active source folder was identified as `C:\Users\shash\OneDrive\Documents\signal-foundry-source` and updated in place, with the environment-file hash verified unchanged and source backups in the workspace `work` directory. The running v1.0 dashboard showed two external QQQ option positions and no locally journaled orders, explaining its external-activity gate. It also had zero usable quotes despite connected sockets; v1.2 adds provider timestamp diagnostics. Docker API access remains denied to this session, so the user must rebuild/recreate the container to load these changes. Provider-paper trades have not been submitted by this verification.

## Provider diagnostic fix

Doctor now reports each Alpaca account, clock, assets, and Jev models check separately. It preserves HTTP status codes and reports known DNS, TLS, and timeout failures without printing credentials, provider bodies, raw exception messages, or account IDs. Independent checks continue after a provider failure. Four focused diagnostic tests pass, covering read-only GET requests, HTTP 401/403 isolation, secret redaction, a closed session, demo mode, and an account blocked for trading. JavaScript syntax and a demo CLI run also pass. These checks do not establish that the user's provider credentials or Docker runtime work; the active deployment is a separate project copy and Docker API access remains denied in this session.

## v1.1 chart update

The full suite now passes **42 tests, 0 failed, 0 skipped**, plus JavaScript syntax and Compose configuration validation. Added coverage checks candle completeness, chart authentication/input bounds, accepted-order versus fill distinctions, unknown timestamp handling, key-presence diagnostics, paper-test idempotency/size/timed exit, and server-side exclusion of real-money mode.

The chart-enabled Node preview was exercised in the browser: candle/volume rendering, symbol and interval switching, simulated buy/sell events, clickable event inspection and no browser error logs. Source and fill markers remained explicitly labeled synthetic. The paper-test lifecycle was tested against a mock broker, not a credential-backed Alpaca account.

The user's running app at port 8080 was inspected and showed DEMO mode and Jev OFF. Its dashboard token differed from the original workspace copy, whose provider keys were empty; the active project directory remains to be identified. No provider orders were sent. Docker engine access from this environment was denied, so rebuilding the user's running container still requires access to its actual project and Docker daemon. The v1.0 record below describes earlier checks and limitations.

Date: 22 September 2026. Environment: Windows, Node.js 24.13.0, Docker CLI 29.4.3. No trading or model-provider credentials were supplied. No real or provider-paper orders were sent; no cloud infrastructure was created.

## Completed here

| Check | Result |
|---|---|
| `node --test --test-concurrency=1 test/*.test.js` | **35 passed, 0 failed, 0 skipped** |
| `node scripts/check.js` | All source, script, test and browser JavaScript files passed syntax validation |
| Synthetic replay | 540 events; 4 candidates; 4 order intents; 2 closed simulated trades; 0 remaining positions |
| Demo doctor | Configuration valid; no provider keys required |
| `docker compose config --quiet` | Passed with a workspace Docker client configuration directory |
| Local application | Started the current implementation with six worker threads and SQLite persistence |
| Browser | Authenticated dashboard rendered, six workers appeared, pair diagnostics appeared, pause and resume changed state, no browser error logs observed |
| Failure regressions | Lost POST response, unknown order, delayed cash/position visibility, canceled partial fill, late fill after flatten, protective-leg cancellation, external holdings, restart, lease collision and model/schema failures covered |

Synthetic counts are a software smoke test, not an investment backtest. Replay runs the same strategy/risk logic with inline strategy evaluation; worker-thread behavior is covered separately. Replay latency figures are local execution measurements, not broker/exchange performance.

## Not completed here

- **Docker image build and container runtime:** Docker Desktop did not expose a running Linux engine. The named pipe `dockerDesktopLinuxEngine` was absent; host startup logs showed access-denied errors reading Docker configuration. Compose syntax validation does not establish that the image starts successfully. Start Docker Desktop in Linux-container mode, then run the commands below.
- **AWS/GCP provider validation or deployment:** Terraform was not installed; an attempted download from HashiCorp failed TLS authentication. Templates were reviewed as source, but no `terraform init`, provider validation, plan or apply succeeded. Do not interpret the templates as an account-tested deployment.
- **Alpaca/TypeSafe authenticated integration:** payload/response mocks and official documentation were used. Real stream subscriptions, entitlements, rate limits, paper fills, fee activities and Jev inference need checks using your keys.
- **Long soak, market-open load, outage recovery and restore drill:** unit/regression coverage is not a 24/7 production soak. Reconnect, database backup restoration and container replacement must be exercised on the target host.
- **Strategy economics:** no licensed historical-data study, walk-forward statistical validation, live latency benchmark, proprietary HFT replication, or profitable edge is asserted.

## Remaining target-host sequence

```sh
node scripts/setup.js
docker compose config --quiet
docker compose up --build -d --wait --wait-timeout 120
docker compose logs --tail=100
```

Inspect the demo, then configure paper credentials in `.env`. Run `docker compose run --rm engine node scripts/doctor.js` before recreating the service. Observe warmup, order/cancel/partial-fill behavior, restart recovery and the external heartbeat. Follow [RUNBOOK](RUNBOOK.md) for those checks and [CLOUD](CLOUD.md) for provider-specific plans.

The supplied GitHub Actions workflow runs syntax/tests/replay and a Docker startup check when placed in a repository with Actions enabled. That workflow has not been run on GitHub during this build.
