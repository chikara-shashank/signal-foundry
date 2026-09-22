# Jev trading review and implementation decision

Reviewed September 22, 2026 against the running paper account, local source and primary vendor documentation. Runtime observations are samples, not performance benchmarks.

## Decision

Use Jev as a bounded contextual entry filter while the numerical workers detect setups and the coordinator owns sizing, exposure, freshness, orders and exits. The active account remains paper. A fast classification API does not establish a trading edge, and this internet-connected Alpaca application is not an exchange HFT system.

`JEV_MODE=filter` is now verified on the running v1.5 engine. A real PLTR VWAP-reversion classification took about 591 ms and vetoed its candidate: coherence 0.68 was below 0.80, while normalized quality 0.72 and the range regime passed. Earlier AAPL and MSFT automatic paper entries received fills while Jev was still in shadow mode; their execution does not establish model approval or contribution. Historical request durations inspected during this review included roughly 237–606 ms. These are individual observations, not p95/p99 or an end-to-end execution SLA.

Shadow mode allowed observation before giving an unvalidated classifier authority. It was separate from `MODE=paper`, which already allowed paper orders. Filter mode now requires a passing Jev result for ordinary strategy entries. Failure, unavailable budget or a declining answer blocks that candidate. Passing still requires a fresh allocation check. Position management and protective exits do not wait for Jev. The explicit operator paper-test action is a separate test path, not a strategy approval.

A subsequent v1.5.1 runtime check at 14:33 ET confirmed a complete model-gated trade: AMZN range breakout, coherence 0.91, normalized quality 0.935, model duration about 570 ms, one paper share filled at $255.61. At that snapshot, 27 classifications comprised 1 pass and 26 declines, while 13 candidates skipped HTTP. New-rubric NVDA samples included roughly 490–791 ms durations with 945–950 ms remaining request budgets; these observations are not a latency distribution. The refreshed browser showed the approved AMZN trace and correctly separated current-run records from history.

## What Jev can usefully contribute

The three outputs currently mean:

| Output | Decision role | What it does not mean |
|---|---|---|
| Noul coherence | Compatibility of supplied context with the defined setup; current threshold 0.80 | An 80% chance of a profitable trade |
| Choice regime | Trend, range or disorderly context; disorderly blocks | A price forecast or a hidden order-book measurement |
| Score quality | Context support on a 0–4 scale, normalized for the 0.65 threshold | Expected return, precise risk sizing or calibrated win probability |

The thresholds are inherited experimental settings. They have not been optimized or validated for net trading returns. The parser retains the provider's Choice/Score confidence, but it does not currently gate on that confidence. Adding a confidence threshold requires an explicit labeled task and evaluation; answer confidence and trading success are different quantities. [TypeSafe confidence documentation](https://docs.typesafe.ai/confidence)

The strongest concern is task fit. Jev's own model notes identify weaknesses with numerical precision, literal interpretation and large irrelevant inputs. Its suggested approach is to compute arithmetic in code and provide direct, relevant context. [Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

For this price-action application, Jev could merely restate existing numerical rules. That is a hypothesis to test, not a reason to put it in every step. Compare it against the existing rules, a transparent regime classifier and a trained tabular baseline. Model use should earn its place through better net outcomes or a demonstrated reduction in specific execution mistakes.

## Changes implemented in v1.5.1 source

- Six explicit setup definitions distinguish continuation from reversal; a VWAP reversal is no longer implicitly judged as if it required an upward trend.
- Input includes bar duration, candidate lifetime, configured maximum holding period and reference/stop/target levels. Code supplies named observations for trend alignment, volume, volatility and price relationships. Missing information remains unknown.
- Every request is tagged `setup-context-2`. Evaluate this rubric separately from old inputs; do not pool their results as one unchanged strategy.
- HTTP timeouts are bounded by the remaining candidate lifetime and, for order-flow continuation, the one-second micro-context deadline. Already expired candidates skip HTTP. A late valid answer is recorded, its known cost is settled, and it cannot approve entry. Unknown billing remains reserved after an interrupted request.
- Request timestamps are taken after preflight, rather than reusing the time before worker processing.
- Jev I/O counters identify the process by an explicit session ID. Provider clock corrections cannot make an earlier run look current. Counts in the panel describe its limited visible record window, not all historical calls.

The existing pin `jev-1.13.0`, thresholds, dollar limits, five-minute symbol cooldown and no combined position-count cap remain. This update does not introduce cached approvals, additional strategies, fractional equity brackets or higher broker throughput. Those require the work below. The user rebuilt the image, and authenticated HTTP checks subsequently confirmed v1.5.1 healthy with filter mode active. Refresh the browser to load the new I/O counter text.

## Latency and throughput audit

The relevant chain is quote delivery → strategy scan → preflight → Jev → allocation recheck → broker acceptance → fill. A UI refresh interval and model response time cover only parts of it.

The order-flow worker scans at a configured 250 ms per symbol, requires at least 20 best-quote observations spanning a second, and accepts micro context no older than one second. Its candidate lasts two seconds; its maximum holding period is three minutes. Other workers use completed one-minute bars and have ten-second candidate lifetimes. A 237–606 ms model call consumes about 24–61% of a one-second freshness allowance before broker submission, if that allowance was full at the start. The old 1,500 ms model timeout could outlive it.

TypeSafe advertises roughly 70–500 ms responses. Its current model reference lists $0.042 per million input tokens, free output tokens, and 1,200 requests per minute, with limits explicitly subject to change. The application deliberately uses a lower 120 requests/minute, two concurrent requests and a $60 monthly budget. Provider capacity does not remove broker or strategy constraints. [Launch description](https://typesafe.ai/blog/introducing-system-one-models-and-jev), [current model reference](https://docs.typesafe.ai/models)

Alpaca's published trading API default is 200 requests/minute/account; its support page is dated December 2022, so account-specific terms should be confirmed before capacity expansion. Purchasing market data alone does not establish a higher trading API entitlement. [Published trading API limit](https://alpaca.markets/support/usage-limit-api-calls)

Source inspection found four base REST requests per reconciliation, plus two per managed equity bracket parent. With a nominal five-second interval, the planning demand is approximately `48 + 24 × managed bracket parents` requests/minute: six parents imply 192 requests before submissions, cancels and event-triggered reconciliations. Actual cycles also take network time, so this is a capacity estimate, not a measured rate. The current $2,000 gross/$500 position settings limit some combinations, but smaller positions can still produce many parents. The current broker client has no shared request-budget scheduler.

Before increasing turnover, use order-stream updates plus periodic REST recovery, avoid redundant parent lookups, and introduce one account-wide scheduler that reserves capacity for protective actions and recovery. An entry must expire while waiting rather than enter from a stale queue. Test reconnects, partial fills, cancel races, lost submission responses and HTTP 429 behavior. Removing a position-count cap does not create unlimited API capacity.

Direct exchange access is a different infrastructure tier: Nasdaq documents participant-oriented OUCH order entry and dedicated hardware options. This app does not have that path. [Nasdaq OUCH](https://www.nasdaqtrader.com/Trader.aspx?id=OUCH)

## Strategy priorities for this account

| Strategy family | Current status | Sensible next evaluation |
|---|---|---|
| Trend pullback and range breakout | Implemented numerical long setups | Compare fixed Jev filtering against rules alone; add measured market/sector alignment and time-of-day context |
| Failed breakdown and VWAP reversion | Implemented long reversals | Separate range/reversal labels from trend-continuation labels; measure adverse excursion and recovery after costs |
| Volatility expansion | Implemented compression/breakout conditions | Test volatility and volume baselines by session segment; reject shocks using code |
| Order-flow continuation | Implemented top-of-book proxy | Measure predictive decay at 10/30/60/180 seconds using bid/ask outcomes and observed latency; keep only horizons with plausible net edge |
| Cross-asset lead/lag and statistical relative value | Research candidates, not implemented here | Require synchronized data, out-of-sample testing and account-compatible hedging; current engine is long-only |
| Queue-position market making or latency arbitrage | Not supported by current data/execution | Requires richer venue/book data and execution control; Jev speed cannot reconstruct missing information |

Order-flow research supports investigating the relationship between supply/demand imbalance and price changes. It does not establish that this implementation can trade those relationships profitably. Cont, Kukanov and Stoikov study price impact; Cont, Cucuringu and Zhang also distinguish contemporaneous effects from short-lived lagged predictability. [Price impact paper](https://arxiv.org/abs/1011.6402), [cross-impact paper](https://arxiv.org/abs/2112.13213)

Two practical limits currently explain missed trades. Whole-share equity brackets must fit inside $500, so an instrument trading above $500 cannot qualify for even one share. Fractional orders exist at Alpaca, but the current order path does not support fractional brackets; that would need a separately verified order/exit design. [Alpaca fractional trading](https://docs.alpaca.markets/us/docs/fractional-trading)

Crypto's configured fee assumption is 25 basis points per side, or 50 basis points round trip before spread and slippage. Very small scalps are economically incompatible with that assumption. The code already checks a reward/cost buffer; actual fee schedules and achieved fills still determine realized costs. Do not lower cost assumptions simply to increase the number of signals.

## Proposed architecture for more frequent decisions

1. Compute streaming price/volume/volatility/spread facts in code. Use only observable data and label any top-of-book proxy accurately. Keep data validation, clocks and stale-feed rejection ahead of inference.
2. Ask Jev for context eligibility on a completed bar or a material regime change, initially no more often than every 30–60 seconds per symbol outside invalidation events. Evaluate related typed questions together. This cadence is a test design, not an implemented setting or a proven optimum.
3. Store the result as a short-lived context permission keyed by symbol, strategy family, model version, rubric and source snapshot. Invalidate it on expiry, a shock, a spread/liquidity change, a feed gap or conflicting fresh evidence. Never reuse an old order-flow snapshot as approval for a new microstructure trigger.
4. Let the existing fast numerical workers identify actual entries using current data and a still-valid context permission. Recheck account state, ownership, cash, costs and exposure immediately before submission. Missing permission blocks model-dependent entries. Exits must remain independent of the model.
5. Route order operations through the broker scheduler and record queue time, HTTP acknowledgment and observed fills separately. Keep a single persistent coordinator per account; do not duplicate the trading engine across cloud instances.

Potential additional context includes sector/market returns, spread relative to its normal range, realized volatility, relative volume by time of day and feed/halt status. Compute these features first. Jev should interpret their compatibility with a setup, not calculate them or invent unavailable observations.

## Cost envelope

Illustration only: **2,000 billed input tokens per request** at $0.042/million means $0.000084/request. Actual logged input tokens determine cost.

| Hypothetical cadence | Calls/month | Model cost |
|---|---:|---:|
| 13 equities once/minute for 6.5 hours × 22 sessions, plus 2 crypto symbols once/minute for 30 days | 197,940 | $16.63 |
| Same universe twice/minute | 395,880 | $33.25 |
| One request/second continuously for 30 days | 2,592,000 | $217.73 |
| Ten requests/second continuously | 25,920,000 | $2,177.28 |

These are calculations, not proposed increases to the existing $60 cap. At that illustrative payload the cap buys about 714,000 requests, averaging about 16.5/minute over 30 continuous days. Uncertain failed calls consume conservative reservations. Paid data, infrastructure and transaction costs are additional. No fresh cloud/data price quote is implied by these totals.

## How to establish that Jev is worth using

Freeze numerical rules and compare three variants on identical chronological data: rules alone, Jev on each eligible candidate, and the proposed cached contextual permission. Compare a simple statistical baseline as well. Log rejected candidates and evaluate their counterfactual outcomes; otherwise vetoes can look helpful merely because their missed winners disappear from the report.

Use separate training/tuning and held-out time periods, with purging for overlapping future labels. Evaluate by strategy, instrument and market regime. Keep prompt/model versions distinct. Apply observed inference/order latency, bid/ask execution, fees and conservative slippage. Report net expectancy, trade count, drawdown, turnover, adverse/favorable excursion, missed opportunities, expired candidates, failure rates and model cost. Quantify uncertainty across independent days rather than treating every adjacent tick as an independent sample.

Measure p50/p95/p99 for each processing stage and the entire quote-to-ack path. Test whether predictive value survives its measured delay. A semantic score's calibration should use a clearly labeled semantic task; do not relabel its confidence as a probability of financial success. Promote a strategy only when its held-out economic evidence beats the baseline with sufficient precision for the intended risk budget. No fixed number of successful paper trades proves that.

Alpaca explicitly excludes several real-world effects from paper simulation, including queue position, market impact and latency-related slippage. Therefore paper fills validate integration and accounting but cannot establish an HFT execution edge. [Paper simulation limitations](https://docs.alpaca.markets/us/docs/paper-trading)

## Recommended sequence

Run the now-active filter mode and install the v1.5.1 observability/deadline changes. Next build the comparative evaluation and broker request-budget work. Only then test cached contextual permissions and additional features. Expand turnover or infrastructure spending when measurements identify a specific bottleneck and the strategy survives costs. Alpaca's separate Elite routing documentation describes higher-limit and DMA facilities; eligibility is distinct, and its advanced instructions are accepted but not simulated in paper trading. That is not an immediate upgrade recommendation. [Alpaca Elite routing](https://docs.alpaca.markets/us/docs/alpaca-elite-smart-router)
