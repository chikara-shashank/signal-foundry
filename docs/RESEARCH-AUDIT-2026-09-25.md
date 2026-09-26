# Implementation audit and published-strategy research — v1.17.0

**No new strategy passed a promotion test.** The implementation is more modular, a real noise-area entry inconsistency is fixed, and two additional hypotheses are available with their switches off. The equity replay does not justify enabling minute VWAP trading. QQQ noise-area has a small positive result only under low-cost assumptions. An executable historical backtest of our options spreads remains blocked by missing data; published options-index history is reported separately.

The running service was observed at v1.16.0 on port 8080, paper mode, unpaused, with the approved $2,000 daily-loss ceiling. This work did not deploy, restart it, change its settings, or send an order. Ledger/Copper styling is preserved.

## Implementation findings and remedies

| Finding | Consequence | Remedy / remaining work |
|---|---|---|
| Noise-area displayed a VWAP entry check but entered solely on the upper band. It could accept a price already below its own exit line. | Displayed qualification and actual trading disagreed. | Both use the shared `noiseSignal` function. Price must exceed the upper band and be at least session VWAP. This consistency repair is not evidence of higher returns. |
| Noise-area could fall back to a minute up to five minutes old and compute VWAP from incomplete session history. | A scheduled decision could use the wrong observation or incomplete volume. | `sessionContext` requires unique, contiguous completed minutes from the session open. Missing history fails closed. Typical-price VWAP is explicit and shared with replay. |
| Options rules, quote/contract validation, accounting, replay and polling were entangled. | New hypotheses risked duplicating financial accounting and weakening validation. | Separate policy/registry, context, pricing, state transitions, replay, manifest and service modules. Preserve existing imports through thin re-exports. |
| Existing options experiment was already blocked by code drift on the active service. There was no operator migration path. | Its controls could remain unavailable indefinitely after an upgrade. | A compare-and-swap action archives a previous **flat** ledger and creates an all-off experiment. Open/pending shadow positions prohibit migration. No automatic reset, discarded history, or broker mutation. |
| Fingerprints did not yet cover the newly extracted dependencies. | Refactoring could accidentally leave new logic outside experiment identity. | Include all extracted execution modules and common validation utilities in fingerprints. Old tapes remain tied to their original version; replay them with that version. |
| Confirmed unused `positive` import and unused `CONDITION_SOURCE` export. | Dead declarations and audit exceptions obscured real warnings. | Remove both declarations; retain the source URL as a comment. Remove obsolete audit exceptions. No journals, backups or research history were deleted. |
| Release helper had a hard-coded Ledger/Copper commit message. | Later releases would receive a misleading description. | Accept `-Message`; default to the package version. |
| Earlier studies sometimes used a signal-generating close as the reference fill and mixed theoretical notional results with feasible allocations. | Results could overstate execution or hide untradeable one-share positions. | New replay uses subsequent opens, delay/cost sensitivity, integer lots, cash carry-forward, stop-risk sizing and separate signal diagnostics. Preserve and label the old report as an archived diagnostic. |

The review covered the strategy registry, worker/features path, session handlers, scanner/pinning, history restoration, entry gates, position exits, options capture/pricing/state/replay, persistence, authenticated controls, experiment hashes and release tooling. Validation: all 306 tests passed; JavaScript syntax validation passed. The static audit found no missing imports, unreachable modules, unused imports, single-use exports or duplicate files. Existing regression tests exercise reconciliation, external holdings, protective exits, pyramiding, calendars, recovery and dashboards. This is not a formal proof of every execution path. The account coordinator remains sizeable; arbitrary extraction of its order mutex and ownership transitions would add risk without a demonstrated behavior improvement.

## Primary research reviewed

| Research | Implementable idea and assessment |
|---|---|
| [Gao, Han, Li & Zhou, *Market Intraday Momentum*, JFE 2018](https://profiles.wustl.edu/en/publications/market-intraday-momentum/) | The opening half-hour helps explain the closing half-hour. A statistically detectable relationship need not pay the spread. Existing repository tests of this idea were negative after costs; no additional production strategy is justified. Publisher abstract/bibliographic record reviewed. |
| [Zarattini, Barbon & Aziz, *A Profitable Day Trading Strategy for the U.S. Equity Market*](https://concretumgroup.com/wp-content/uploads/2026/02/A-Profitable-Day-Trading-Strategy-For-The-U.S.-Equity-Market.pdf) | Five-minute opening ranges, same-time relative volume, price/liquidity/ATR filters and the top 20 active names. Selection is integral to the hypothesis. The repo's earlier 100-liquid-stock study is not a replication of the paper's much broader universe. Tight intraminute stops require quote/trade replay. Keep the market-wide discovery scanner, but do not call its shortlist a point-in-time universe backtest. |
| [Zarattini, Aziz & Barbon, *Beat the Market*](https://concretumgroup.com/wp-content/uploads/2026/02/Beat-the-Market.pdf) | Prior-session, time-of-day noise bands and half-hour decisions reduce turnover. The paper examines both directions and volatility sizing; this engine supports a capped long-only adaptation. The VWAP entry consistency repair is an explicit implementation choice. Tested below without the paper's leverage. |
| [Zarattini & Aziz, *Volume Weighted Average Price*](https://concretumgroup.com/wp-content/uploads/2026/02/Volume-Weighted-Average-Price.pdf) | Hold in the direction of price relative to regular-session VWAP, changing direction after completed minute closes. Added `vwap_trend` as a long-only paper/shadow hypothesis, with the engine's risk gates, five-minute entry cooldown, emergency protection and early session exit. These adaptations are material. Our replay rejects promotion. |
| [Zarattini & Pagani, *Improving Performance with Fast Alphas*, 2026](https://concretumgroup.com/wp-content/uploads/2026/02/Improving-Performance-with-Fast-Alphas-A-Tactical-Overlay-for-Intraday-Trend-Trading.pdf) | The authors study using short-lived reversal information to delay trend execution, including exit timing. This motivates a future paired execution experiment rather than another high-turnover scalper. The note assumes no slippage in its illustrated fee calculation; it does not establish our retail fill economics. Not added to the frozen test after seeing its results. Never delay a mandatory risk exit to seek a better price. |
| [Bondarenko, *Historical Performance of Put-Writing Strategies*, 2019](https://cdn.cboe.com/resources/spx/bondarenko-oleg-putwrite-putw-2019.pdf) | Selling index insurance can earn a volatility premium, with material drawdowns and equity exposure. Gross premium collected is not profit. This supports researching the existing put-credit sleeve, not assuming a defined-risk SPY spread inherits the results of a collateralized SPX index. |
| [Ang, Israelov, Sullivan & Tummala, *Understanding the Volatility Risk Premium*, 2018](https://www.aqr.com/Insights/Research/White-Papers/Understanding-the-Volatility-Risk-Premium) | Author overview: the premium compensates sellers for adverse-market exposure. A richer IV than backward-looking realized volatility is a hypothesis, not an arbitrage or calibrated forecast of future volatility. The current 1.25 ratio remains explicitly unvalidated. |
| [Israelov & Nielsen, *Covered Calls Uncovered*, FAJ 2015](https://www.aqr.com/-/media/AQR/Documents/Insights/Journal-Article/Covered-Calls-Uncovered.pdf) | Decomposes covered-call returns into equity, short volatility and an embedded timing exposure. Motivates measuring direction and volatility separately. The added `call_credit` is a bearish, defined-risk engineering companion to `put_credit`; it is not a replication of this paper's hedged covered-call strategy. |

Research from strategy vendors and asset managers has commercial context. We use the rules as hypotheses and test our implementation, rather than importing their headline returns.

## Equity replay actually run

The [frozen protocol](RESEARCH-PROTOCOL-2026-09-25.md) precedes the new comparisons and records the subsequent accounting correction. Cached Alpaca SIP minute data cover December 2015 warmup through September 22, 2026. There are 2,676 complete SPY sessions and 2,687 complete QQQ sessions; 42 and 31 calendar sessions respectively were missing/incomplete, including the requested September 23 boundary absent from the cache. Counts include warmup. Exclusion dates, input SHA-256 hashes, code/protocol fingerprints and every comparison are in [the machine-readable result](research/published-2026-09-25.json). A fresh SIP API spot-check matched the cached September 1 opening bar; this checks one sample, not every historical observation.

Three prespecified rule variants × two ETFs × three cost scenarios were evaluated. `noise_legacy` is an ablation of the VWAP entry check using the otherwise corrected replay, not a reconstruction of every old live behavior. The windows are 2016–2023, 2024–2025 and 2026. **They are retrospective windows, not a pristine unseen holdout**: previous research already used much of this archive. A fresh prospective experiment starts September 28.

The following numbers are average **net basis points per signal trade**, including signals that cannot fit the $500 allocation. One basis point is 0.01%. They are not account returns. Low costs include half the assumed spread plus 1 bp slippage on each side; engine costs use 3 bps slippage plus a 1 bp fee per side. Adverse adds 6 bps slippage, fees and another minute of delay. These are price-bar approximations, not verified executable fills.

| Strategy / ETF | 2024–25 signals | Net bps, low costs | Net bps, engine costs | 2026 signals | Net bps, low costs | Net bps, engine costs | Net bps, adverse + delay |
|---|---:|---:|---:|---:|---:|---:|---:|
| Noise / SPY | 234 | -0.60 | -6.60 | 70 | -1.64 | -7.64 | -13.12 |
| Noise / QQQ | 201 | +4.34 | -1.66 | 81 | +1.82 | -4.18 | -9.56 |
| VWAP / SPY | 3,845 | -1.95 | -7.95 | 1,311 | -2.24 | -8.24 | -14.61 |
| VWAP / QQQ | 3,775 | -1.81 | -7.80 | 1,311 | -1.92 | -7.92 | -14.24 |

**Allocation matters:** the standardized study's $500 integer-share limit produced zero executable lots in 2026 for either ETF. The signal diagnostic is retained, but account P/L is zero because the study places no funded trades. Production noise-area has a separate fixed-notional setting; this study does not silently enlarge the new VWAP strategy's cap or claim to reproduce that noise allocation. In 2024–2025, capped QQQ noise made $26.28 at low costs over 109 funded trades and approximately -$0.13 at engine costs over 108. The low-cost daily block-bootstrap 95% interval includes zero (-$0.070 to +$0.201 per session). This does not establish a reliable edge.

All scenarios, dollar P/L, win rates, funded/zero-lot counts, daily-close drawdown and five-session block-bootstrap intervals are retained. Intervals are not adjusted for multiple comparisons. Continuous quote latency, queue position, corporate-action corrections, live vetoes, simultaneous strategies, external symbol reservations and broker failures remain outside this isolated replay. Adjusted historical prices also affect old integer-lot eligibility. Do not use this report as portfolio qualification.

## Options: benchmark evidence and the missing execution backtest

I downloaded the official [PUT history](https://cdn-api.cboe.com/api/global/us_indices/daily_prices/PUT_History.csv) and [BXM history](https://cdn-api.cboe.com/api/global/us_indices/daily_prices/BXM_History.csv), then calculated descriptive returns for January 4, 2016–September 25, 2026:

| Published index | Observations | Annualized index return | Daily-close maximum drawdown |
|---|---:|---:|---:|
| PUT — collateralized put writing | 2,698 | 8.46% | 28.93% |
| BXM — covered calls | 2,695 | 7.95% | 30.26% |

These are published index-level results with no additional investor-cost adjustment. They are **not our spread backtest, not day-trading returns, and not returns available from a $100 spread-risk budget**. Unequal observation counts and gap diagnostics are retained in [the benchmark analysis](research/options-benchmarks-2026-09-25.json). The index evidence supports investigating a compensated risk premium; it does not establish a superior return to passive equities or validate our trend filter/hedge strikes.

[The data probe](research/data-check-2026-09-25.json) confirmed current OPRA quote access (HTTP 200), historical-trade endpoint access, and HTTP 404 from the probed historical options-quote endpoint. [Alpaca's documentation](https://docs.alpaca.markets/us/docs/historical-option-data) describes history from February 2024 and distinguishes actual OPRA quotes from indicative derivatives. [Historical trades](https://docs.alpaca.markets/us/reference/optiontrades) do not provide the simultaneous bid/ask and point-in-time chain required by this strategy. Current Greeks must not be backfilled into historical decisions.

The active service reports 143 archived frames but its old experiment is quarantined. Docker-volume reads were denied by this environment, so those frames were not retrieved or treated as a backtest. The new recorder captured one real **closed-market** observation and both primary/adverse replay paths processed it: zero eligible sessions and zero trades. This is a plumbing check only. Synthetic regression tests exercise spread accounting and fill latency; their P/L is not investment evidence.

The new `call_credit` strategy uses the existing 21–45 DTE window, 0.20–0.35 absolute short delta, IV >= 1.25× prior realized volatility, non-bullish daily trend, an OTM short call and a higher-strike long call. It shares the existing $100 per-spread / $200 total risk caps and one-reservation-per-underlying constraint. Options remain quote-shadow only, including the existing strategies. Assignment, exercise, dividend exposure, reliable multi-leg fills and broker reconciliation are still missing for actual execution. The options lab's independent $100 daily gate does not change the equity engine's $2,000 setting.

## How to use and reproduce this work

```powershell
Set-Location 'C:\Users\shash\dev\signal-foundry'
npm run check
npm test
npm run audit
npm run research:published
npm run research:options:benchmarks
npm run research:data-check
```

The equity command uses the existing cache and makes no network calls. It writes the full result and signal trade ledger under `data/research`. The benchmark command downloads only if its local CSV is absent. Neither starts a trading engine. The data-check command is intentionally pinned to the September 2026 research snapshot.

After separately deploying v1.17.0, the strategy controls include **Session VWAP trend** (off), and Options lab includes **Call credit — volatility premium** (off). A flat obsolete options experiment can be archived with the clearly labelled button. Existing open/pending experiments cannot be reset through that control. The old code version is required to reconcile or replay their intact tapes.

The immediate research priority is a continuous OPRA recording across complete sessions, with immutable checkpoints and independent adverse-cost replay. Seek at least the configured 60 prospective sessions and 100 closed trades, but treat those as minimum sample gates, not evidence of profitability. For equities, measure actual realized entry/exit friction on existing qualified setups before allocating more capital. Neither lowering modeled costs nor increasing position size is evidence of an edge.
