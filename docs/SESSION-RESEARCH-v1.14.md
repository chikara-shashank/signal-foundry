# Session scheduling, crypto selection and closing-news research

Research and implementation review, September 25, 2026. Source release: 1.14.0.

The implementation separates fast equity trading, continuous crypto trading, and slower closing/news research. The overnight experiment uses **engine allocation**, as requested. Its combined entry budget is **9.5%**, leaving a margin below 10%. This is an operationally bounded paper experiment; no positive trading expectancy has been established.

## Operating schedule

| New York time | Equity behavior | Research / crypto behavior |
|---|---|---|
| Before 09:00 | Fast stock feed, stock discovery, warmup and options capture off | Crypto continues; slow news intake and bounded news classification continue |
| 09:00–09:30 | Stock stream and historical warmup available; regular stock entries blocked | Yesterday's watchlist receives streaming priority |
| 09:30–15:15 | Existing equity strategies scan and trade through their normal risk checks | Crypto remains independent of stock-scanner freshness |
| From 15:15 | One broad preclose research scan, followed by minute-bar confirmation | News classifications prioritize held stocks and closing candidates |
| 15:30–15:55 | New closing-strength/news carry entries may qualify | All carry holdings and pending buys share the allocation budget |
| 15:55–16:00 | Carry entry gate closes; ordinary day positions retain their flattening rules | GTC carry protection remains attached |
| From 16:00 | Equity WebSocket scheduled off; fast equity work stops | Closing scan starts after a two-minute settlement delay; news continues; crypto continues |

This uses `America/New_York`, including daylight saving, rather than a fixed UTC−5 offset. Alpaca's actual exchange calendar supplies holidays and early closes. On a 13:00 close, fast equity work ends at 13:00 and postclose research starts after that close. No carry entry is opened on early-close days because the requested 15:30 window does not exist. Calendar data is refreshed every six hours and becomes unusable for stock entries/fast data after 24 hours.

The usual US regular trading session begins at **09:30**, so 09:00 is a preparation window. Bracket orders do not support extended hours; their allowed time-in-force values include DAY and GTC. This implementation uses regular-session execution with GTC carry brackets. [Alpaca order documentation](https://docs.alpaca.markets/us/docs/orders-at-alpaca)

“Off” applies to fast equity price collection and execution. Account/position reads and broker order notifications must remain available for crypto and for existing protection. Reconciliation remains about five seconds when crypto or unresolved orders need it; otherwise it slows to twenty seconds. Stable stock-parent detail refreshes slow to five minutes off-hours. Urgent order discrepancies still trigger reads. Slow news, calendar, closing snapshots and history requests are intentional research exceptions.

## What the available data actually supports

A read-only run against the configured provider on September 25, approximately 16:47–16:49 ET, exercised the new modules:

| Check | Observation |
|---|---|
| Active asset metadata | 14,460 assets returned across equities and crypto |
| Closing scan coverage | 13,199 eligible listed stocks and ETFs screened |
| Detailed closing history | 60 stocks selected for minute-bar analysis |
| Matching closing patterns | 2, before any news qualification |
| News intake | 1,251 normalized recent articles; pagination complete |
| Next actual exchange session | Monday, September 28, 2026 |
| Global top-25 crypto available on Alpaca | 11 USD pairs |
| Provider orders / paid model calls in this probe | 0 / 0 |

The two price matches are observations, not profitable trades or validated recommendations. The broad scan does not run expensive full-history checks on every asset: it screens all eligible assets, then investigates a bounded shortlist. The real provider probe took approximately 98 seconds. No account journal was copied or replaced.

Alpaca's news service supplies Benzinga articles and historical coverage. Our existing account returned this data successfully, so a separate news subscription is unnecessary for this implementation. This does not establish access to reliable stock float, a complete future earnings calendar, analyst consensus, or consolidated real-time volume. [Alpaca news documentation](https://docs.alpaca.markets/us/docs/historical-news-data)

## Continuous crypto, restricted to global leaders

The selection is **global ranks 1–25 intersected with active, tradable Alpaca USD pairs**. It is not the top 25 of whatever Alpaca happens to support. Coin identities are checked against provider IDs so a ticker collision cannot silently select another token. Unknown identities are excluded. No rank-26 substitute fills an unavailable slot.

The observed eligible pairs were BTC, ETH, USDT, XRP, USDC, SOL, HYPE, DOGE, LINK, ADA and BCH, each against USD. This list is an observation, not a hardcoded trading universe. Stablecoins remain in the global ranking; ordinary volatility, reward, spread and fee checks can reject them. Membership never forces a buy.

Alpaca crypto operates continuously and exposes tradability through its asset metadata. CoinPaprika supplies identity, rank, market cap and update time; its public ticker endpoint includes the leading assets without an additional key. Ranking refresh is hourly, failed requests retry after five minutes, and a verified cached snapshot expires after six hours. A newly fetched rank snapshot must have recent provider timestamps. CoinPaprika prices are never used as executable Alpaca prices. [Alpaca crypto documentation](https://docs.alpaca.markets/us/docs/crypto-trading), [CoinPaprika ticker documentation](https://docs.coinpaprika.com/api-reference/tickers/get-tickers-for-all-active-coins)

A coin that drops out of the top 25 stops qualifying for new buys. Owned positions and unresolved orders remain subscribed for protection. Failed subscription changes block new buys until acknowledged. `CRYPTO_UNIVERSE=off` also retains owned crypto for management while denying new crypto entries. The former stock-scanner freshness gate no longer blocks crypto.

## Closing-pattern hypothesis

The broad screen requires an eligible stock, at least the configured minimum price and liquidity, a positive daily move below 15%, a reasonably strong daily close location, and sufficient time-adjusted volume. Minute-bar confirmation then requires:

- At least 50 contiguous completed observations in the last hour; no fabricated gap fills or future bars.
- Price in the top 20% of the observed range, above the hour's VWAP and at least as high as the prior twenty closes.
- An approximately 0.3%–4% advance over that observation window.
- Average volume in the latter half at least 1.2 times the first half.

These thresholds are engineering choices for a falsifiable experiment. They were **not fitted to the two matches** found by the provider probe. The scanner records its observation time and pattern version. The next session's top watchlist stocks receive up to ten stream slots after owned positions and other required instruments. Their historical context is warmed too; streaming an unfamiliar ticker without enough history previously could leave it unusable.

Academic evidence on intraday momentum supports studying the close, but its horizon matters: Gao and coauthors study first-half-hour information predicting the *same day's last half-hour* in market ETFs. That is not evidence that an individual stock closing strongly will keep rising tomorrow. Our carry rule is therefore a separate hypothesis. [Market Intraday Momentum, author working paper](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2440866)

## News and Jev

Every fifteen minutes, the desk requests all-ticker news over the preceding 36 hours, rereading the window to notice revisions. It retains bounded headline/summary records with article ID, source link, publication time, revision time, first local observation of that version and digest. Intake is limited to sixty pages, paced at about one request per second. Incomplete or unavailable intake blocks new carry trades and is visible on the dashboard.

Jev classifies relevance, direction, materiality and explicitly reported hazards. News text is passed as untrusted data. It cannot authorize orders, change budgets or edit strategy controls. Response types, probabilities, model identity and token usage are checked. A favorable carry thesis requires high relevance, favorable direction, high materiality and confidence, and no identified binary/financing hazard in the supplied articles. “None identified” does not certify that no event exists.

At most four new classifications run per pass and twenty-four per New York date, sharing the existing Jev request and monthly-dollar budget. Before a normal session, spending stops at four daily news calls; during the closing session it stops at sixteen, preserving at least eight for after-close work. Successful identical evidence is cached. Revisions invalidate it. Uncertain HTTP outcomes retain their cost reservation. The model's confidence is a classification score, **not a win probability**.

Fresh adverse classifications mark a stock “avoid” and veto new equity longs. They can also invalidate an existing carry thesis, with its exit queued for regular hours. Other existing intraday positions retain their established exit rules. Positive news without price confirmation creates a watch item, not an order.

The literature is mixed and narrower than a simple sentiment rule:

| Research | Relevant finding and implementation implication |
|---|---|
| Glasserman and coauthors, *Does Overnight News Explain Overnight Returns?* | News topics have predictive associations with returns, but the forecasting design uses multi-year topic exposure and year-ahead returns. It does not validate next-day headline scalping. We use classification as bounded context, not a learned profit forecast. [Paper](https://arxiv.org/html/2507.04481v1) |
| Boyarchenko, Larsen and Whelan, July 2026 update | The previously documented 02:00–03:00 ET equity-futures drift averaged near zero in the 2021–2025 follow-up sample. This is a different instrument/window from our carry rule, but direct evidence that a published overnight effect can fade. [New York Fed research](https://libertystreeteconomics.newyorkfed.org/2026/07/the-disappearing-overnight-drift/) |
| *Retail Investors’ Contrarian Behavior Around News, Attention, and the Momentum Effect* | The study connects retail contrarian trading after large earnings surprises with momentum and earnings drift. We lack trustworthy consensus estimates and therefore do not label ordinary positive earnings wording an earnings surprise. [NBER working paper](https://www.nber.org/papers/w34086) |
| Christensen, Timmermann and Veliyev, 2026 version | Earnings information often produces immediate jumps; the studied post-announcement strategy is consistent with efficient pricing after 2016. A slower headline reader cannot assume the apparent information remains tradable. [Paper](https://arxiv.org/abs/2601.08962) |

## Overnight allocation and exits

The default equity base is conservatively bounded by the configured engine capital, engine capital plus managed-book P/L, and current account equity. Unrelated holdings or deposits cannot raise it above the engine allocation. An invalid book or account blocks new carry allocation. For a $10,000 engine without losses, the shared cap is $950; the default per-position cap is $350, also bounded by existing position, risk, gross, group, cash and buying-power limits.

All open carry lots and the unfilled portions of carry buy orders count. Filled portions count once as holdings. Exposure uses a conservative price no lower than the recorded entry cost where applicable. Reservations are persisted under the same order mutex before a network request, preventing competing signals from each consuming the same free budget.

The strategy is `close_strength_carry`, shown as **Closing strength + news** in the existing switches and per-strategy results. For this requested paper/shadow feature, a missing setting is seeded on by `OVERNIGHT_ENTRIES`; a previously saved off choice stays off. Turning it off cancels new-entry intents while maintaining existing positions. Carry is unavailable in real-money mode and cannot pyramid or override sizing.

Default exits are a broker GTC bracket, a stop distance of the greater of 1.5 observed ATR and 1% of price, and a target two stop distances above the reference. Setups needing more than a 3% initial stop are rejected. Carry positions must exit by five minutes before the third future exchange-session close, or earlier for stop/target, adverse news, lost protection, allocation reduction or the daily loss gate. Ordinary day trades are never relabeled as carry trades.

A final submission check prevents stock entries outside the permitted window. Stock exits preserve native protection off-hours and during the last thirty seconds before closing rather than initiating a late cancellation-and-market-exit sequence. At the next valid regular session, latched exits continue through the existing cancellation acknowledgment and quantity-reconciliation process.

A gap, halt, outage or unrealized-equity change can push marked exposure above the cap despite a valid entry reservation. No allocation fraction or stop guarantees otherwise. The engine blocks further carry buys, cancels remaining carry buy intents and queues reductions in owned carry positions for the next executable regular session. It cannot promise a continuous mark-to-market value below 10% while equity execution is deliberately closed. The approved **$2,000 daily-loss limit is preserved** by the deployment workflow and existing saved journal setting.

## Validation and remaining evidence

The automated suite passes **291 tests**, including the 31 new session, ranking, news and carry tests. Coverage includes DST, holidays, early closes, incomplete news, identity collisions, subscription failure, warmup/history suppression, late submissions, competing reservations, partial fills, GTC requests, off-hours protection, adverse news, carry deadlines, manual toggles and authenticated read-only dashboard data. The isolated browser preview renders the new panel and saves the carry toggle. These are correctness checks, not return estimates.

Order experiment IDs include code and configuration hashes covering the new policy modules. Each carry intent freezes its original news and price thesis, holding deadline and fee assumptions. Ranking snapshots and news observations are dated. Preserve daily verified backups and export records beyond the default journal retention before running a long experiment.

The proposed promotion standard is at least sixty exchange sessions and one hundred fully closed carry trades, with settings frozen before observing outcomes. Insufficient qualifying trades means insufficient evidence; do not loosen filters simply to reach a quota. Analyze net executable returns, bid/ask and adverse slippage, gap losses, daily drawdowns, model/operating costs and portfolio overlap. Require positive performance under increased cost assumptions and day-clustered uncertainty estimates, plus a separate untouched date period. Passing a sample-size threshold alone does not qualify the strategy.

Compare with a matched price-only research portfolio and a no-trade baseline before crediting Jev with added value. Do not backtest today's top-25 list across old dates or run a current model over historical headlines and call that a clean historical holdout. Neither point-in-time historical crypto ranks nor an executable counterfactual news portfolio was generated in this implementation. Live strategy qualification remains blocked.

## Configuration and release

Provider defaults are `CRYPTO_UNIVERSE=top25`, `OVERNIGHT_ALLOCATION_FRACTION=0.095`, `OVERNIGHT_POSITION_FRACTION=0.035`, and `OVERNIGHT_MAX_SESSIONS=3`. Use `CRYPTO_UNIVERSE=off` to stop new crypto entries; an empty `CRYPTO_SYMBOLS` no longer disables automatic ranking. `OVERNIGHT_ENTRIES` defaults on only for paper/shadow. The research API is authenticated at `/api/session-research`.

The release also preserves the already-developed per-trade return chart. `scripts/finish-release.ps1` validates the tree, commits source to local main and invokes the established paper deployment on port 8080. It retains the existing trading-data volume, takes an online SQLite backup, tags a rollback image, preserves the $2,000 limit and verifies protection before resuming. It does not push to a remote. Do not start a second broker writer or replace the active journal with a different local database.
