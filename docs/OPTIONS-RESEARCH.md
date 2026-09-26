> The original v1.9 experiment is documented below. v1.17 adds a fourth, bearish call-credit hypothesis, modularizes the simulator and provides a guarded flat-experiment migration. See [the updated audit and actual research results](RESEARCH-AUDIT-2026-09-25.md). Old tape hashes and historical results remain tied to their original implementation.

Options strategy lab — September 25, 2026

The first options implementation is a **quote-based shadow experiment**, separate from the equity engine and Alpaca orders. The research priority is a defined-risk put credit spread; call and put debit spreads test a directional intraday hypothesis. None is established as profitable. The existing account's external options positions are never imported into this ledger or managed by this module.

The strongest evidence found concerns diversified, collateralized index option writing over long periods. It does not establish that short-horizon ETF spreads, technical filters, or our exact implementation earn an excess return. Bondarenko's Cboe study reports 1986–2018 annualized returns of 9.54% for PUT versus 9.80% for the S&P 500, with lower volatility but a 32.7% maximum drawdown. In its 2006–2018 comparison, monthly PUT returned 5.97%, weekly WPUT 4.51%, and the S&P 500 7.59%. Collecting more frequent premium was not a shortcut to higher total return. These are historical benchmark results, partly backfilled, not a retail account forecast. [Study and methodology](https://cdn.cboe.com/resources/education/research_publications/PutWriteCBOE19_v14_by_Prof_Oleg_Bondarenko_as_of_June_14.pdf).

AQR's study across 11 equity indexes decomposes covered-call returns into equity exposure, short-volatility exposure and equity timing. Its results support investigating a volatility risk premium while questioning the value of incidental equity timing. Its transaction-cost section explicitly reduces gross results for implementation costs. That supports separating a volatility hypothesis from our directional breakout hypotheses; it does not validate our IV/RV threshold. [Covering the World](https://www.aqr.com/-/media/AQR/Documents/Journal-Articles/Covering-the-world-global-evidence-on-covered-calls.pdf).

The put credit spread buys downside protection while selling a higher-strike put. The protection changes the exposure and can consume the premium that made an unhedged benchmark attractive. Bull call and bull put verticals can have equivalent terminal payoffs after financing adjustments; calling one an income strategy does not create a separate economic edge. Early assignment and expiration can also create temporary stock exposure and financing needs. [OIC put-spread mechanics](https://www.optionseducation.org/strategies/all-strategies/bull-put-spread-credit-put-spread).

The directional call spread buys a lower-strike call and sells a higher-strike call. Its upside is capped, and dividend-related early assignment of the short call remains possible. The bearish counterpart buys a higher-strike put and sells a lower-strike put. Both require the directional move to outweigh price paid and execution costs. Their payoff shapes control exposure; the entry forecast still has to work. [OIC call spread](https://www.optionseducation.org/strategies/all-strategies/bull-call-spread-debit-call-spread), [OIC bear put spread](https://www.optionseducation.org/strategies/all-strategies/bear-put-spread).

I did not find evidence justifying a claim that a retail HFT-style options bot will consistently make money. Cboe describes the sharp price sensitivity of near-the-money options approaching same-day expiration. That is a reason to demand better data and execution evidence, not proof that 0DTE is universally unprofitable. [Cboe 0DTE resources](https://www.cboe.com/tradable-products/0dte). Cboe's 2024 retail study also challenges broad profitability conclusions drawn from incomplete proxies that miss multi-leg and hedged positions. Exchange-sponsored research has a commercial perspective, and neither optimistic nor pessimistic industry-wide claims substitute for our own complete ledger. [Retail study](https://cdn.cboe.com/resources/government_relations/Understanding-Retail-Investors-Dynamic-Trading-Behavior-in-the-US-Options-Market_2024.pdf).

The development choices below are engineering and research priorities, not an empirical ranking of proven returns.

| Candidate | Decision | Reason |
| --- | --- | --- |
| Put credit spread on SPY/QQQ | Implemented as the first multi-day hypothesis | Related to volatility-premium evidence, with a purchased hedge and explicit capital cap; exact rules unvalidated |
| Call/put debit spreads | Implemented as two day-trading hypotheses | Test direction from completed underlying bars; expose the cost of translating an equity signal into options |
| Covered calls / wheel | Deferred | Substantial share/cash collateral and equity downside; option premium is not the same as profit |
| Iron condors | Deferred | Four legs, additional execution costs and tail/lifecycle complexity; no demonstrated advantage for this harness |
| Naked option selling | Excluded from this implementation | Does not fit its defined-risk mandate |
| 0DTE scalping / options HFT | Deferred | Needs event-level execution, outage and lifecycle evidence beyond this REST sampling experiment |
| Earnings straddles / discretionary news options | Deferred | No tested forecast of realized moves versus implied pricing, or event-risk integration |

The account readiness check confirmed Alpaca paper options level 3 and successful OPRA requests. Alpaca supports multi-leg orders, but this release deliberately has **no options order submission path**. OPRA is requested explicitly; there is no silent fallback to the indicative feed. Alpaca describes indicative quotes as modified and indicative trades as delayed, and historical options coverage begins in February 2024. Current chain metadata is therefore not backdated into a historical strategy test. [Alpaca level 3](https://docs.alpaca.markets/us/docs/options-level-3-trading), [historical data](https://docs.alpaca.markets/us/docs/historical-option-data).

Zero commission does not remove the bid–ask spread, execution slippage or regulatory charges. Alpaca lists TAF, ORF, OCC and CAT fee categories. The lab's $0.10 per contract per side is a **conservative research assumption**, not a claim about the account's exact invoice; it should eventually be reconciled to actual confirmations. The stress calculation uses $0.65 per contract per side. Both are configurable only through a new frozen experiment version, not by changing a fee after seeing losses. [Alpaca regulatory fees](https://docs.alpaca.markets/us/docs/regulatory-fees), [current fee schedule](https://files.alpaca.markets/disclosures/BrokFeeSched.pdf).

For a numerical illustration, a one-dollar-wide credit spread with a $25 best-case gain and $75 worst-case loss needs a 75% win rate if every result is exactly one of those two outcomes and costs are zero. If all-in costs are $5 per round trip, the outcomes become +$20 and −$80, requiring 80%. A 70% win rate would lose $10 per attempt under those assumptions. Actual early exits have a distribution of gains and losses; win rate alone is insufficient.

Implemented rules are frozen in `src/options-strategies.js`:

| Rule | Put credit | Call debit | Put debit |
| --- | --- | --- | --- |
| Underlyings | SPY, QQQ | SPY, QQQ | SPY, QQQ |
| Expiry window / target | 21–45 / 30 calendar days | 7–21 / 14 days | 7–21 / 14 days |
| Signal | Prior close ≥ SMA50, spot ≥ SMA20, short-put IV ≥ 1.25× prior 20-return realized volatility | Completed five-minute close above first 30-minute high and session VWAP | Completed five-minute close below first 30-minute low and session VWAP |
| Anchor delta magnitude | Short put 0.20–0.35, target 0.25 | Long call 0.45–0.65, target 0.55 | Long put 0.45–0.65, target 0.55 |
| Spread | Same expiry, long lower put, credit ≥ 20% of width | Same expiry, short higher OTM call, debit ≤ 65% of width | Same expiry, short lower OTM put, debit ≤ 65% of width |
| Time exit | At ≤7 DTE or 14 elapsed days | After 90 minutes or 20 minutes before calendar close | Same as call debit |
| Profit/loss triggers | Half initial credit profit; loss at initial credit or max risk, whichever is smaller | Profit at 50% of initial modeled risk; loss at 40% | Same as call debit |

Entries start 35 minutes after the exchange opens and stop 60 minutes before its calendar close, including early-close days. No fixed UTC offset is used. The catalog scan selects the available expiry nearest each target, then considers one- to five-dollar widths. Missing opportunities outside those expiry/strike windows are a known bounded-universe limitation.

Every spread is one standard, unadjusted, 100-share contract pair. Maximum modeled loss including assumed round-trip fees is $100 per spread and $200 across open and pending spreads. At most two spreads may be reserved, with one per underlying, and a $100 daily loss latch that cannot clear on a same-day rebound. These are limits on a separate $10,000 hypothetical book, not permission to allocate account capital. SPY and QQQ share the same portfolio cap because they are correlated. One entry attempt per strategy/underlying/session limits repeated entries. Registry order breaks allocation conflicts, so enabling different combinations changes the experiment.

Quote gates require regular-condition, positive two-sided OPRA prices, at least five contracts displayed on each side for entry, no more than $0.20/15% quoted spread per leg, open interest of at least 100 with a dated observation no older than seven calendar days, a quote age at most five seconds and inter-leg timestamp skew at most one second. Missing Greeks, adjusted deliverables, stale underlying prices and incomplete prior-session history are rejected.

The recorder calibrates against Alpaca's clock. An intent cannot fill on the signal observation. A later observation must contain both leg quotes at least one second after the decision, continue to qualify, and satisfy the original net price limit. It expires after 90 seconds without chasing. Each buy pays ask plus one cent; each sale receives bid minus one cent. Exit decisions similarly require later quotes. The position uses a signed debit/credit cash-flow convention, the 100-share multiplier and all four leg-side fees. Stress net deducts two additional cents on every leg-side and the higher fee from the same trade path. This is a cost sensitivity check, not a complete adverse-execution re-simulation.

This REST experiment samples roughly every 30 seconds. Displayed prices are not evidence of simultaneous multi-leg fills; queue position, partial fills, auctions, intrabar movements, assignment, exercise, dividend events and broker outage recovery are not simulated fully. Captures with an open-position gap or lifecycle violation block new entries rather than invent a favorable close. Stops are triggers, not guarantees of bounded realized loss. Alpaca says assignment notifications require REST polling, and paper non-trade activities become visible the next day; expiration may automatically exercise ITM contracts. Those lifecycle states must be implemented and reconciled before broker-connected options paper execution. [Alpaca lifecycle rules](https://docs.alpaca.markets/us/docs/options-trading).

The dashboard has persistent per-strategy switches, closed net P/L, stress-cost net, win rate, closed count, open estimated net and pending count. Disabling a strategy removes pending shadow entries while preserving exit management. A global pause suppresses new shadow entries. The equity and broker journals remain separate. Settings use revision checks; an off/on edit during collection invalidates new entries from that in-flight observation. Source/policy hashes reject incompatible replay or silently mixing results after code changes. A changed experiment disables only the options lab and preserves its stored ledger for an explicit migration.

The frozen forward-test start is **September 28, 2026**. Friday's observations are plumbing checks. The dashboard counts observed sessions and fully closed holdout trades against a minimum of 60 sessions and 100 trades; these counts alone never qualify a strategy. `liveEligible` remains false. Further review must use daily marked portfolio returns, all enabled strategies and rejected opportunities, opportunity-matched equity/cash baselines, drawdowns and capital usage, not only favorable closed spreads. Estimate uncertainty with blocks of trading days rather than treating correlated trades as independent. Correct for selecting among three strategies and any later variants. Require positive expectancy after realistic costs and stressed costs, with an uncertainty interval supporting the conclusion; report an inconclusive result as inconclusive. Freeze a new version before further tuning, and reserve new unseen dates. The statistical review and broker lifecycle/execution implementation remain future gates, not completed features.

CLI examples (from the repository, Node 24):

```powershell
npm run research:options -- scan --out work/options-scan
npm run research:options -- record --seconds 300 --out work/options-recording
npm run research:options -- replay work/options-recording/tape.jsonl
```

`scan` is one read-only observation; `record` accepts 1–3600 seconds. Use a new output directory each time. The dashboard writes daily recordings to `DATA_DIR/options-research/YYYY-MM-DD.jsonl`. Pass consecutive files in chronological order to replay. The first record of each file carries an initial ledger checkpoint; state hashes detect missing intermediate observations or mismatched settings. Recordings include sampled market data and should remain private under the data provider's terms. A daily file stops recording above 500 MiB; archive these files deliberately and monitor disk space. They are not automatically pruned with stock bars.

To deploy the integrated v1.9.0 dashboard on the existing port 8080, run from the repository in a terminal with access to Docker:

```powershell
docker compose up -d --build engine
```

Keep the existing named volume and do not use `down -v`. The first integrated startup leaves all options strategies off; enable the desired shadow hypotheses in the Options strategy lab. Do not run a second paper stock engine against the same account/database. The isolated verification instance uses port 8082 and a separate local simulation database. It has no Alpaca broker execution client.
# Round-two addition

The [round-two review](RESEARCH-ROUND2-2026-09-25.md) adds a fifth, default-off iron-condor hypothesis and analyzes official CNDR history alongside PUT/BXM. The policy is now `options-v3`. Every four-leg spread uses one same-expiry put credit wing and one call credit wing; shorts have absolute delta 0.15–0.25 and IV at least 1.25 times prior RV20. Wings are 1–5 dollars; existing per-position and portfolio loss budgets still apply. Maximum terminal loss uses the wider wing less total credit plus all eight contract-side fees. Simultaneous quotes are not a guarantee of an atomic fill. Assignment/exercise may create risk outside that terminal payoff.

This differs materially from CNDR's cash-settled SPX options, approximately 5-delta hedges, Treasury collateral, midpoint marks and monthly expiration roll. Our ETF options are American, narrower, marked at adverse bid/ask with fees, and use existing early profit/loss/time exits. Published index returns are not our strategy returns. No historical executable options backtest is claimed. See the review for the full source and data-gap discussion.
