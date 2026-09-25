# Breakout giveback and equity discovery — v1.11.0

The September 25 audit matched all 49 closed range-breakout and failed-breakout trades in the paper dashboard snapshot at 13:45:59 ET. Range breakout: 23 closed, 5 wins, -$13.654508 estimated net. Failed breakout: 26 closed, 8 wins, -$8.475220 estimated net. Both lost before fees as well. Combined: -$22.129728, excluding model/cloud costs.

Of the 36 losing trades, at least 17 had a historical bid observation with positive estimated proceeds after fees and exit slippage. A TSLA failed-breakout entry at 09:43:01 ET on September 25 bought one share at $371.51. A 09:56:00 bid of $376.76 implied approximately +$5.06 after modeled costs. It eventually exited at $368.55 at 10:43:05, approximately -$3.03 net. Its original stop was $367.07 and target $380.59. The one-hour time exit, rather than an adaptive profit rule, ended this trade.

This is evidence of giveback, not an executable hindsight return. We selected the highest completed minute close within each held interval, then checked the first valid historical quote in the following two seconds. Quotes were requested only for trades whose selected close was positive after estimated fees and which eventually lost. Seventeen is a confirmed lower bound, not exhaustive maximum favorable excursion. Candle highs were not treated as fills. Latency, queue position, price movement, cancellation and market impact could change execution. The full quote path and original receipt times were not archived by the old engine, so this analysis cannot establish what the new policy would have earned.

## Why profits reversed

The existing entry rules detect a local setup but do not establish that it persists for an hour. The original range/failed-breakout exits used a fixed initial stop and target, session-end exit, daily-loss exit or 60-minute holding limit. Stops did not advance after gains. A close back through the entry's broken/reclaimed range did not invalidate the trade. Twenty-six of the 49 reviewed trades exited through native or software stops; 11 had a recorded holding-time exit, five session-end, five native targets, and two exit reasons were unavailable in the bounded dashboard order history. Mean holding times were approximately 33 and 31 minutes respectively.

Some entries also had less than 1:1 modeled net reward/risk despite nominal 2R targets: spread, entry price movement and execution costs consumed the apparent reward. A green mark near zero can still be below round-trip break-even.

## Frozen forward paper policy

For new equity entries only:

- Range breakouts must close in the upper 35% of their candle and no more than one ATR above the previous range high. Failed breakouts must also close in the upper 35% of their reclaim candle. Existing trend, volume and VWAP checks remain applicable.
- Both require at least 1:1 modeled reward/risk after spread, fees and slippage.
- R is actual average entry price minus the original stop. After an observed bid reaches +1R and clears modeled costs, a software floor arms. It is the greater of cost-adjusted break-even plus 0.1R and the highest observed bid minus 0.75R. It only rises within an unchanged fill segment.
- A fresh, completed post-fill one-minute bar closing below the entry range level minus 0.15 entry ATR triggers invalidation. Range breakout uses the entry's prior range high; failed breakout uses its prior range low. These levels do not roll forward after entry.
- After 15 minutes from the fill, exit if the highest observed bid has never gained 0.25R. Missing observations cannot certify the unseen path; this is a rule based on observed progress.
- The original broker bracket remains until an exit trigger. The trigger is persisted immediately; the coordinator waits for native-leg cancellation and reconciled available quantity before a market exit. A software floor is not a replacement broker stop or guaranteed profit. Existing native brackets remain the outage protection.

An older open entry without a frozen exit policy keeps its existing rules. New settings do not silently rewrite its experiment. Quote peaks and adverse marks are retained, with at most one second between routine persistence, plus immediate persistence on arming or triggering. An exit trigger survives a rebound or restart. Later partial entry fills begin a new cost-basis segment. Dollar excursions become unavailable after observed partial exits, avoiding comparisons against the wrong quantity. Actual realized P/L always comes from fills.

Configuration: `BREAKOUT_PROTECTION=on`, `BREAKOUT_ARM_R=1`, `BREAKOUT_TRAIL_R=0.75`, `BREAKOUT_NO_PROGRESS_MINUTES=15`, `BREAKOUT_MIN_NET_REWARD_RISK=1`. Turning protection off affects newly created policies; owned trades keep their frozen policy. Settings, strategy code and universe policy are part of the experiment hash.

Do not judge this policy from the old 49 trades or a perfect sale at their peaks. Use subsequent unseen sessions, include all wins and losses, retain full execution/cancellation timing, and compare net expectancy, giveback, profit factor, drawdown and forgone recovery after exits. Review only after at least 20 new sessions and 100 closed trades per strategy; these counts alone do not establish significance. Before live eligibility, replay receipt-ordered quotes through the portfolio engine with delayed executable fills and stressed costs, then independently review execution and uncertainty. Live strategy entry remains blocked. No profit claim or automatic exposure increase is implemented.

## Entire eligible universe, bounded execution shortlist

`EQUITY_UNIVERSE=all` is the default for provider runs; demo stays static. `EQUITY_SYMBOLS` is a bootstrap list, not a restriction on discovery. `static` explicitly restores the old behavior. The broker's active asset master is refreshed daily. The scanner includes tradable US equities/ETFs listed on the supported exchanges, excluding OTC, inactive, nontradable and unsupported symbol formats. This is the Alpaca-accessible listed equity universe, not every security worldwide or every options contract.

Every five minutes while the exchange is open, all eligible symbols are screened in batches of 200 using the configured feed. Discovery is paced at no more than 80 snapshot requests per minute. Current session data, fresh uncrossed sized quotes, spread, price and dollar liquidity are required. Defaults: $2 minimum price; maximum bounded by both $2,000 and the configured position cap; $5m previous-day dollar volume; $50,000 latest-minute dollar volume; the configured spread and quote-age limits. One-exchange IEX volume is not consolidated volume.

Per-strategy coarse rankings choose 80 candidates for up to 150 minutes of history and the same completed-bar setup evaluator used by workers. Twenty percent of context slots rotate through other liquidity-qualified symbols to broaden coverage. Coarse relative activity uses previous daily volume divided by 390 as a proxy; exact strategy relative volume still uses its own prior bars. This is staged screening: exact strategy history is not loaded for 13,000 names every tick.

Up to 60 symbols stream on SIP by default; the IEX cap is 30. This application cap is distinct from the subscription entitlement. Owned positions and pending owned entries are pinned, along with the session strategy's benchmark when available. Unowned selections dwell for 15 minutes while they remain screening-eligible. Rotation unsubscribes before adding to respect stream caps, preserves existing subscriptions, and never holds the order mutex while waiting for a subscription acknowledgment. Fresh quotes and all existing allocator/risk gates still apply before any order. A complete scan is required for new entries, and stale discovery blocks entries after 15 minutes at the default cadence. Protection continues.

Optional environment settings: `UNIVERSE_REFRESH_SECONDS`, `UNIVERSE_STREAM_LIMIT`, `UNIVERSE_CONTEXT_LIMIT`, `UNIVERSE_MIN_PRICE`, `UNIVERSE_MAX_PRICE`, `UNIVERSE_MIN_DAILY_DOLLARS`, `UNIVERSE_MIN_MINUTE_DOLLARS`, `UNIVERSE_MIN_DWELL_MINUTES`. The dashboard shows attempted coverage, returned snapshots, rejections, last complete scan, selected symbols and exact matches. Each selection records a scan ID and asset-membership hash; each entry links its discovery context. Membership rotation does not create a new experiment hash, but policy changes do.

The initial read-only SIP scan on September 25 at 13:58 ET examined 13,199 eligible assets out of 14,387 active assets, received 13,197 snapshots, found 113 liquidity/quote-qualified names, evaluated 80 contexts and selected 60 in 54.6 seconds. A second pass at 14:17 ET, using the dashboard's enabled strategy list and final scanner code, again screened all 13,199 assets: 94 qualified, 80 contexts were evaluated and 60 selected in 56.1 seconds. These probes placed no orders and did not subscribe a second live feed. The synthetic browser preview also placed no orders. Company float and catalyst/news classification remain unavailable; no low-float/catalyst edge is claimed.

## Verification and deployment status

All 232 tests pass. JavaScript and release PowerShell scripts pass syntax checks, and the browser preview renders discovery coverage, the selected-stock table and per-strategy giveback counts without console errors. Tests cover durable profit triggers through a rebound/reconstruction, native-leg cancellation before selling, stale data, partial quantities, asset batch completeness, symbol rotation, pinned exposure, failed subscription handling and experiment identity.

The active port-8080 container remains v1.8.0 with the approved $2,000 daily-loss override. The v1.11.0 source is implemented but not deployed or committed: Windows denied creation of `.git/index.lock` and access to Docker's configuration/named pipe. `scripts/finish-release.ps1`, run from a normal PowerShell session with access to Git and Docker, performs the checked commit to local main and the journal-preserving deployment. It does not push to the remote. The new exit rules have no forward profitability results yet.

## Source contracts checked

Alpaca documents snapshot fields and explicitly selected feeds in its [snapshots reference](https://docs.alpaca.markets/us/reference/stocksnapshots-1). Basic data has IEX coverage and 30 streaming symbols; Algo Trader Plus supplies consolidated coverage and different limits, according to [Alpaca's market-data plans](https://docs.alpaca.markets/us/docs/about-market-data-api). Actual snapshot access with the configured SIP credentials succeeded in the read-only probe.

Alpaca's [order documentation](https://docs.alpaca.markets/us/docs/orders-at-alpaca) describes bracket behavior and cancellation constraints. FINRA explains that [stop trigger prices do not guarantee execution prices](https://www.finra.org/investors/insights/stop-orders-factors-consider-during-volatile-markets), and short reversals can trigger an exit before a recovery. These constraints are why the new floor is reported as an exit trigger and must be evaluated after actual costs.
