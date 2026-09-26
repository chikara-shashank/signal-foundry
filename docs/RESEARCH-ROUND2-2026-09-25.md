# Research round 2: what survives contact with this engine?

**Implemented in source, default off. No new strategy qualifies for activation.** This round adds monthly equity trend following and a four-leg options experiment, but the funded recent equity results are negative and executable historical options data are missing. Positive academic or index returns are not evidence that this particular implementation will make money.

The code is v1.18.0. This research run did not deploy, enable a strategy, submit a broker order, increase the overnight allocation, or change the approved $2,000 paper daily-loss limit. Existing uncommitted v1.17 changes were preserved.

## Published evidence, including contrary findings

| Source | Evidence and implication for this project |
|---|---|
| [Faber, A Quantitative Approach to Tactical Asset Allocation, 2007; updated 2013](https://mebfaber.com/wp-content/uploads/2016/05/SSRN-id962461.pdf) | Monthly 10-month moving-average timing across asset classes; its aim includes reducing downside exposure. The paper evaluates signals and execution at the same monthly close. We use already completed months and later execution, three US equity ETFs, no leverage and no interest on cash. Our bracketed, small-capital strategy is a further adaptation. The paper is not a day-trading result. |
| [Moskowitz, Ooi and Pedersen, Time Series Momentum, JFE 2012](https://www.aqr.com/Insights/Research/Journal-Article/Time-Series-Momentum) | Evidence across 58 futures/forward markets, using an instrument's past returns. This motivates a 12-month comparison, but their multi-asset, long/short, volatility-scaled portfolio is materially different from cash-funded ETF longs. |
| [Hurst, Ooi and Pedersen, A Century of Evidence on Trend-Following Investing, 2017](https://www.aqr.com/insights/research/journal-article/a-century-of-evidence-on-trend-following-investing) | Extends trend-following evidence back to 1880 across global markets. Useful evidence of breadth, not a promise that a narrow ETF rule with tight stops inherits those results. |
| [Huang, Li, Wang and Zhou, Time Series Momentum: Is It There?, JFE 2020](https://down.aefweb.net/WorkingPapers/w717.pdf) | Contrary evidence: questions asset-level predictability and pooled-regression significance, and finds similar performance from a strategy that does not require return predictability. This is why our reports include buy-and-hold rather than equating positive returns with alpha. |
| [Daniel and Moskowitz, Momentum Crashes, JFE 2016 / NBER working paper](https://www.nber.org/papers/w20439) | Documents severe momentum losses around rebounds following stressed markets. We did not add leveraged cross-sectional stock momentum from a present-day universe; it needs point-in-time membership, corporate actions and separate crash-risk tests. |
| [Goyal and Saretto, Cross-Section of Option Returns and Volatility, university working-paper version](https://docs.lib.purdue.edu/ciberwp/55/) | Sorts stock options using historical versus implied volatility and studies straddles/delta-hedged options. Motivates testing volatility richness, but neither the existing 1.25× RV20 cutoff nor our ETF credit spreads replicate those portfolios. Reproducing it requires broad point-in-time option histories and realistic hedge costs. |
| [Israelov and Nielsen, Covered Calls Uncovered, FAJ 2015](https://www.aqr.com/-/media/AQR/Documents/Insights/Journal-Article/Covered-Calls-Uncovered.pdf) | Separates equity, short-volatility and changing equity exposures. Premium collected is not standalone profit. Covered calls and cash-secured puts also require stock/collateral far above this engine's small overnight position allowance at current SPY/QQQ prices. |
| [Cboe CNDR methodology](https://cdn.cboe.com/api/global/us_indices/governance/CNDR_Methodology.pdf) and [Cboe benchmark discussion](https://www.cboe.com/insights/posts/benchmark-indices-series-volatility-management-with-cboes-bfly-and-cndr-indices) | CNDR sells approximately 20-delta SPX calls/puts, buys approximately 5-delta wings and holds Treasury collateral. It uses monthly rolls and midpoint-based prices. Our American ETF options, narrow wings, adverse bid/ask assumptions and early exits are different. Its long history makes it useful as a countercheck; its recent-decade returns were weak. |

These papers support research into trend exposure and compensation for volatility risk. They do not support a claim of consistent daily profits, and they do not validate HFT on a retail API.

## Equity backtests actually run

Protocol: [frozen rules and amendments](RESEARCH-PROTOCOL-ROUND2.md). Fixed symbols: SPY, QQQ and IWM. No ticker/parameter search after the results. All windows are retrospective, including 2026; none is described as a pristine holdout.

Alpaca SIP returned complete daily history from January 2016: 2,697 sessions per ETF through September 24, 2026. The request for 2014 history was rejected for missing sessions. Thirteen completed months of warmup put the common test start at February 1, 2017. Both adjusted and raw daily datasets are cached and fingerprinted.

### Normalized long/cash signal comparison

Completed monthly signals, next daily open execution, 4bps per side, no cash interest, no leverage. Adjusted bars provide a total-return proxy. Fractional normalized units are used here; this table does **not** represent the engine's executable dollar returns.

| ETF | 10-month SMA CAGR | 12-month momentum CAGR | Buy-and-hold CAGR | SMA maximum daily-close drawdown | Buy-and-hold drawdown |
|---|---:|---:|---:|---:|---:|
| SPY | 8.12% | 11.71% | 15.13% | 25.81% | 33.79% |
| QQQ | 17.19% | 19.29% | 21.07% | 28.56% | 35.00% |
| IWM | 4.84% | 1.74% | 9.18% | 34.34% | 41.27% |

At 12bps/side the SMA CAGRs were 7.92%, 17.05% and 4.65%. A separate one-session delay produced 8.71%, 16.37% and 4.67%. All remain below the corresponding base buy-and-hold return. Lower drawdowns came with missed appreciation and whipsaws. These results establish neither a superior return nor the return of our protected carry implementation.

Full results: [108 symbol/model/scenario/window observations](research/monthly-round2-2026-09-25.json). The report also includes transaction counts, exposure, win rates, zero-rate Sharpe and raw-price lot feasibility. Its $950 initial-sleeve arithmetic illustration is explicitly not a rebalanced cap-compliant portfolio.

### Funded approximation of the installed adaptation

Downloaded **565,102 raw SIP five-minute bars**. Tested a combined $10,000 isolated managed sleeve, $350 default overnight position allowance, $950 aggregate overnight ceiling, $10 stop-risk budget and whole shares. The ordinary $500 position limit also remains. Entry window 15:30–15:55 New York; 2% protective stop, 6% target, 20-session deadline at 15:55; at most one entered campaign per symbol/month. Stops pay adverse gap opens and take precedence if both stop and target appear inside one bar. All end-of-study liquidations are labeled.

| Period | Base net P/L | 12bps/side stress | Five-minute entry-delay stress | Base closed trades | Base win rate |
|---|---:|---:|---:|---:|---:|
| Feb 2017–Sep 24, 2026 | $441.92 | $366.82 | $441.09 | 174 | 50.6% |
| 2017–2023 development | $472.13 | $407.97 | $471.47 | 145 | 54.5% |
| 2024–2025 retrospective validation | −$0.46 | −$7.45 | −$0.18 | 20 | 40.0% |
| 2026 retrospective final | −$29.75 | −$33.70 | −$30.19 | 9 | 11.1% |

This is the material result: the recent funded adaptation does not pass. SPY and QQQ produced **zero funded trades in 2024–2026** because the position allowance cannot buy a share; those recent results are IWM. The 2% stop / 20-session cap also changes a long-term trend strategy into a different trading strategy. A paper's impressive normalized return cannot be imported into this book by changing its label.

Full-period sampled drawdown was $80.40 at base costs; 2026 sampled drawdown was $47.01. Those are five-minute observations under low exposure, not tick-level worst losses. The full/development archive has **188 missing symbol-bars**; 2024–2026 has none. Missing paths were not invented. Therefore the older results are incomplete-path diagnostics. Dividends, taxes, corporate-action cash flows, historical quote spreads, broker fill priority, outside holdings and competing strategies are not modeled. No large raw daily split-like discontinuities (>1.5× or <0.67× prior close) appeared in the three ETF histories. That check is not corporate-action reconciliation.

Full results and data/code hashes: [funded replay report](research/monthly-funded-round2-2026-09-25.json). The full base trade ledger and daily curve are cached under `data/research/monthly/funded-base-path.json`.

## Options evidence and what was implemented

Official Cboe daily index levels, January 4, 2016–September 25, 2026:

| Published index | Annualized return | Maximum daily-close drawdown |
|---|---:|---:|
| PUT: collateralized put writing | 8.46% | 28.93% |
| BXM: covered calls | 7.95% | 30.26% |
| CNDR: collateralized iron condor | 0.77% | 19.47% |

Source files and hashes: [index-history analysis](research/options-benchmarks-round2-2026-09-25.json), downloaded from [Cboe PUT history](https://cdn-api.cboe.com/api/global/us_indices/daily_prices/PUT_History.csv), [BXM history](https://cdn-api.cboe.com/api/global/us_indices/daily_prices/BXM_History.csv) and [CNDR history](https://cdn-api.cboe.com/api/global/us_indices/daily_prices/CNDR_History.csv). No investor transaction costs were added to these published index levels. Treasury collateral and index conventions differ from our account. These are contextual benchmark statistics, not our options backtest.

Added `iron_condor` to the existing Options lab, default off, under `options-v3`. It requires:

- SPY/QQQ standard 100-share contracts, same underlying and expiry, 21–45 DTE.
- One protected OTM put credit wing and one protected OTM call credit wing; short absolute deltas 0.15–0.25; both short IVs at least 1.25× prior RV20; wing widths $1–$5.
- Existing quote-age, synchronization, spread, size, open-interest and premium/cost tests on every leg.
- Maximum risk $100 per position and $200 across pending/open positions. Four legs consume one position; risk is the wider wing minus credit, plus eight contract-side fees.
- Later synchronized quotes for entry and exit; no assumed fill at signal time; no automatic legging. Profit/loss/time exits, assignment-exposure flags and expiration blocks remain.

The recorder retains and re-quotes all four legs outside the scanner's current strike range. Replay, cost sensitivity, independent adverse-latency paths and disabled-position exits all account for four legs. This remains quote-shadow only; there is no broker options execution connection.

The previous entitlement probe found current OPRA quotes but no usable historical quote/point-in-time-chain replay source. The round-two final recorder observed the market closed, recorded one frame and made zero hypothetical trades. Deterministic replay can be checked on it, but that is a plumbing check, not a profitability test. Synthetic lifecycle tests also are not investment evidence. Older experiments remain version-quarantined; only a flat old ledger may be explicitly archived and restarted from the dashboard.

## Integration, validation and next decisions

The stock strategy appears in Strategy controls with existing profit/win-rate accounting. Its description explicitly reports failed recent funded tests. The options strategy appears in the existing Options lab with separate hypothetical accounting and a weak-benchmark/data-gap description. Both start off; existing saved selections take precedence, and live eligibility stays false.

Monthly rules, daily data and normalized/funded replays are separate modules. Carry authorization now dispatches to the correct strategy verifier while sharing the same allocation calculation and GTC protection. The exchange-calendar horizon covers the 20-session deadline. A repeated New York date-formatter allocation discovered during replay was replaced with shared immutable formatters, preserving DST behavior and avoiding large transient memory use.

Validation: **319 tests passed**, including completed-month causality, missing-history rejection, session gates, carried-position exits after disabling, shared overnight risk, whole-share affordability, gap losses, stop/target ambiguity, four-leg geometry, eight-side costs, delayed quotes and deterministic replay. Syntax and whitespace checks passed. The static audit found no missing imports, unreachable modules, unused imports, single-use exports or duplicate files across 167 JavaScript modules. This conservative audit is not proof that every branch is exercised.

The final read-only runtime check at 2026-09-26 03:45 UTC found port 8080 still serving v1.16.0, paper/shared mode, ready and unpaused, with the $2,000 daily-loss override intact. The v1.18.0 changes remain in the source working tree; no deployment or commit was performed in this round.

Recommendation: do not activate these additions based on this round. Keep the new controls for isolated experiments. Prioritize an economically faithful low-turnover equity implementation and an executable options quote archive. Cheaper equivalent ETFs or correctly protected fractional lots may address affordability without increasing the cap, but require a separately frozen test; they were not substituted after these results. Removing stops or raising risk to rescue the backtest would create another unvalidated strategy. For options, existing put-premium research has a stronger benchmark case than the condor, but actual spread expectancy, assignment handling and broker reconciliation still need evidence. No strategy has been promoted to live trading.

Reproduce from repository root:

```powershell
npm run research:monthly
npm run research:monthly:funded
npm run research:options:benchmarks
npm test
npm run check
npm run audit
```

Initial equity downloads use Alpaca credentials from `.env`; subsequent runs use the immutable dated cache. Research scripts issue read-only requests and do not start a trading engine.
