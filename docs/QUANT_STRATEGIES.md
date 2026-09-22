# Quant and HFT capability map

Added after the owner's request to cover HFT techniques and current quantitative research. The system can exploit testable price/flow patterns when they survive costs. It does not possess every firm's proprietary strategy. Sub-second model inference is one component of a much longer observation-to-fill path.

## Executable modules

All six modules use the same portfolio, cost, session, freshness, and recovery gates. Each is a research hypothesis, enabled explicitly through the `STRATEGIES` environment list. No return or win-rate estimate is assigned to a rule by fiat.

| Module | Data | Trigger | Intended holding period |
|---|---|---|---|
| range_breakout | Closed bars, current quote | Range break, volume confirmation, aligned multi-timeframe trend | Minutes–hour |
| trend_pullback | Closed bars, current quote | Pullback/reclaim within an observed uptrend | Minutes–hour |
| failed_breakout | Closed bars, current quote | Downside range probe rejected back upward | Minutes–hour |
| vwap_reversion | Closed bars, current quote | Negative rolling VWAP deviation in a low-efficiency range plus reversal | Minutes–hour |
| volatility_expansion | Closed bars, current quote | Prior compression, volume expansion and upward range break | Minutes–hour |
| order_flow_continuation | Repeated bid/ask prices **and sizes**, warm bar context | Positive normalized best-quote OFI, depth imbalance, microprice skew and momentum | Up to 3 minutes |

The order-flow module can scan between bar closes. Default per-symbol scan throttle is 250ms. It needs at least 20 valid observations spanning one second, fresh microstructure state, and a non-shock trend context. This throttle is not a measured end-to-end latency guarantee. Worker and submission latencies are recorded for measurement; Jev-dependent candidates expire if inference exceeds the signal's useful lifetime. Local numerical gates remain mandatory.

The feature engine includes a trend/range/shock regime heuristic, volatility ratio, rolling VWAP z-score, and directional efficiency. Regimes are transparent rules, not a trained hidden Markov model. Microprice is the depth-weighted best-quote price; it is not a guaranteed future midpoint. IEX-only flow is exchange-specific, not market-wide order flow. Consolidated L1 also cannot reconstruct individual queue positions or participant intent.

## Implemented research scanner

Synchronized SPY/QQQ and BTC/ETH observations are analyzed with a rolling log-price hedge-ratio fit. The latest observation is excluded from fitting, then scored against the historical residual distribution. Results include beta, residual z-score, and a descriptive AR(1) half-life where defined.

These results are **research-only**. Correlation and a residual z-score do not establish cointegration. A pair trade needs two-leg capital reservation, short/borrow eligibility, joint execution/failure recovery, and validated hedge stability. Those facilities are not implemented in this long-only release, so the scanner never emits an unhedged order masquerading as arbitrage.

## HFT families and required capabilities

| Family | Status here | Missing prerequisite |
|---|---|---|
| Best-quote order-flow continuation | Implemented experimental module | Must establish predictive value after actual latency/costs |
| Multi-level OFI / queue-reactive alpha | Research extension | Sequenced L2/MBO history, book reconstruction, venue-specific tests |
| Inventory-aware market making | Not implemented | Two-sided quote lifecycle, adverse-selection/queue simulator, venue economics |
| Cross-venue arbitrage / lead-lag | Not implemented | Multiple synchronized venues, funded inventory, fees, independent-leg recovery |
| ETF/index/futures relative value | Pair diagnostics only | Appropriate instruments, hedge execution, basis/dividend/borrow models |
| Auction-imbalance strategies | Not implemented | Auction feeds, cutoff-aware order handling, auction-specific simulation |
| Options volatility/dispersion | Not implemented | Options chains/Greeks, surface calibration, multi-leg/assignment risk |
| Funding/basis carry | Not implemented | Eligible derivatives venues, funding/borrow/liquidation models |
| Latency-race / queue-position strategies | Outside this deployment | Direct exchange feeds/order access, colocation, far lower end-to-end latency |
| Learned execution / LOB reinforcement learning | Offline research candidate | Realistic simulator, training data, frozen model and out-of-sample execution evidence |

Nasdaq's direct OUCH order-entry environment supports exchange participants and price-time matching; it is materially different from a retail REST broker path. [Nasdaq OUCH](https://nasdaqtrader.com/Trader.aspx?id=OUCH)

## Current research reviewed

- **ClusterLOB (2025):** clusters order-level events and evaluates decomposed imbalance signals. The study uses market-by-order data. Our L1 adapter does not reproduce that dataset or algorithm. A future module must first add licensed MBO storage and reconstruction. [Paper](https://arxiv.org/abs/2504.20349)
- **Order-flow response dynamics (2025):** investigates horizon and regime effects in Chinese index futures. It supports testing horizon/regime sensitivity, not assuming its fitted relationship transfers to US stocks or crypto. [Paper](https://arxiv.org/abs/2505.17388)
- **Group-aware policy optimization on LOBs (2026):** compares policy methods on an order-flow state under a simplified backtest. It is a useful research direction, not evidence that a retail deployment earns the reported returns. No trained RL policy or paper replication is claimed here. [Paper](https://arxiv.org/abs/2605.25527)
- **Foundational OFI evidence:** motivates best-quote imbalance features, while the implementation still needs predictive and execution validation. Contemporaneous price impact alone does not establish a profitable forecasting strategy. [Cont, Kukanov, Stoikov](https://arxiv.org/abs/1011.6402)
- **Selection-bias control:** log all attempted variants and apply appropriate multiple-testing correction before selecting winners. No unimplemented statistical certification is reported as passed. [Deflated Sharpe Ratio](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2460551)

## Admission rule for future quant models

Every addition must specify required data, timestamp/label conventions, turnover and fee assumptions, training/evaluation periods, all trials attempted, a frozen artifact/version, calibration, and an execution/failure model. Use unseen chronological data and live shadow observations. No agent downloads a paper and turns its headline result into a live strategy automatically. Model confidence and novelty are not substitutes for net expected-return evidence.
