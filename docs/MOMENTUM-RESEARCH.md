# Small-cap momentum research lane

This is an opt-in, broker-free research lane added to v1.7.0. It is not registered as a production strategy. It cannot submit orders, change the account, or start from the normal `npm start` command. It implements the scanner → completed-bar pullback → delayed executable-price → shared portfolio path.

## Commands

```powershell
npm run research:momentum:data -- discover data/momentum/discovery-unique-date
npm run research:momentum:data -- sample data/momentum/sample-unique.jsonl APUS,GLND 15
npm run research:momentum:data -- stream data/momentum/raw-unique.jsonl APUS,GLND 60
npm run research:momentum:data -- prepare data/momentum/prepared-unique APUS,GLND 2026-09-24
npm run research:momentum:data -- normalize data/momentum/raw-unique.jsonl data/momentum/prepared-unique/context.json data/momentum/events-unique.jsonl
npm run research:momentum -- replay normalized-events.jsonl primary.json
npm run research:momentum -- replay normalized-events.jsonl stress.json --stress
npm run research:momentum:validation -- freeze registration-input.json registration.json
npm run research:momentum:validation -- assess primary.json stress.json registration.json assessment.json
```

Use fresh output paths. Existing output/audit files are not overwritten. The data command uses existing `ALPACA_KEY` and `ALPACA_SECRET` from `.env`; it sends GET requests only to fixed Alpaca hosts. It uses the paper clock as a timing reference. It does not request account balances or orders. Discovery obtains active assets and SIP snapshots in batches, then retrieves news for a preliminary shortlist. No subscriptions are purchased.

`sample` is a bounded REST snapshot recorder, capped at 60 seconds and 20 symbols. It is useful for data availability and spread diagnostics. It is explicitly not a full tick recorder and cannot be passed off as a complete replay tape. The raw provider timestamps, conditions and round-lot quote sizes remain intact. Samples do not claim historical receipt times.

`stream` records raw SIP trades, quotes, trading-status messages, corrections and cancellations with local receipt times, a provider-clock offset and original message fields. It validates all requested channel subscriptions, preserves large trade IDs and stops on disconnect, backward clock movement or the 512 MiB file cap. Version 2 adds one-second local heartbeats, a monotonically increasing record sequence and a SHA-256 footer over the header and preceding records. Wall-clock movement is checked against a monotonic clock; drift above 100 ms stops capture. These checks detect local corruption and outages, not upstream packet completeness or malicious rewriting.

Duration is explicit and capped at 12 hours. A literal `*` requests the complete stream only when entitlement and storage capacity have been verified; it is never the default. A full-market stream can hit the file cap quickly, so storage sizing is a prerequisite for full-session capture. Connection limits may reject a second stream while the existing paper engine is running. The recorder does not stop or replace that engine. Authentication messages are not persisted. Capture is not certification of a complete holdout.

`prepare` supports one through five symbols for operational development. It fetches the exchange calendar, assets, paginated unadjusted SIP minute bars over the 30 completed prior exchange sessions, and a bounded news review queue. It averages only regular-session minute volume, using the actual calendar open/close and DST. Every prior date must have bars, and pagination must terminate. The resulting denominator still requires split/corporate-action review, and the closing-auction volume convention requires calibration. The files preserve original responses and retrieval times. The command creates a **diagnostic** context with available factual fields; it leaves float, share class, price basis, material-news classification, tick size, lot size and initial halt state unresolved. It never qualifies a stock merely because prices are available.

`normalize` needs no credentials or network connection. It joins a raw SIP recording to a receipt-ordered metadata timeline, writes normalized JSONL, and writes `<output>.manifest.json` with raw/context/output hashes, applied metadata counts and coverage failures. It rejects REST samples, reversed receipt order, malformed calendars and evidence-free facts. An aborted conversion appends a gap to its partial output so it cannot silently become a valid replay. Existing files are not replaced. Always inspect the manifest before replay.

In `primary` context mode, coverage requires a version 2 wildcard subscription acknowledged by 04:00 Eastern **including clock uncertainty**, with uncertainty at most 100 ms, continuous local heartbeats, a valid terminal digest and recording through the regular close. A local heartbeat gap over three seconds or full-market silence over ten seconds during the collection window invalidates coverage. A bounded symbol list, late start, missing footer, legacy recorder or diagnostic mode remains ineligible. These are operational checks, not evidence that Alpaca supplied every exchange event. A complete session still needs all metadata and the separately defined pilot/holdout.

## Current data boundary

Alpaca provides the price/news surfaces used here. The inspected asset response supplies no verified share float. Discovery never converts market capitalization, shares outstanding, daily volume or a missing value into float. Name-based exclusion of warrants, funds, depositary securities and similar instruments is preliminary; it never certifies common-share status. News headlines are stored with retrieval times, not automatically classified as a material issuer/SEC catalyst.

The primary experiment needs verified point-in-time float and security type, corporate-action-consistent previous close and prior volume, a material-news taxonomy, venue tick/round-lot definitions and complete market coverage. The context timeline can import documented manual facts or another source; missing facts reject entries. Alpaca's snapshot daily volume is not substituted for the specified cumulative volume since 04:00 or a 30-session denominator.

Each context metadata row has `symbol`, receipt `now`, and `facts`. Every fact requires `value`, `effectiveAt`, `availableAt`, and `evidence: {sourceUrl, sha256}` referencing retained source evidence. Both times must be no later than the row's receipt. Metadata obtained after a signal is applied only when it first becomes available. Hash presence records a claim of provenance; it does not authenticate an issuer or certify the operator's classification.

- `float` and `roundLot` must use `unit: "shares"`. SEC dollar-valued public float is not accepted as share float.
- `volumeBaseline` includes `sessions: 30`, `lastSession` before the target date, and `convention: "regular_session_eligible_volume"`.
- A reviewed `news` fact includes `classification: "issuer_or_sec_material"`, `sourceUrl`, `taxonomyVersion` and `reviewedBy`. A headline alone is insufficient.
- `splitBasis: {value: true, sessionDate: "YYYY-MM-DD", ...}` must identify the target session and retain review evidence. The adapter derives `splitBasisVerified`; a bare boolean is not accepted as source evidence.
- `roundLot` must be effective at the quote timestamp and no more than one day old. The adapter never assumes 100 shares; stale or missing evidence makes the quote ineligible.
- Broker `tradable` expires after 60 seconds under the scanner. A one-time preparation command does not replace intraday refreshes.

A current asset catalog is not historical universe membership. Discovery uses multiple batches at different times and is not an atomic market scan. Its output has `qualified: 0` until all research requirements are implemented and supplied. Full discovery snapshots and news are diagnostic inputs, not trade recommendations.

## Normalized tape contract

JSONL events have `kind`, monotonic millisecond `now` (first local receipt mapped to the provider reference clock), and `symbol` except global events. Timestamps cannot be reconstructed from later publication times. Retain original source files and hashes alongside the normalized tape.

Recorded session headers must include `dataContractSha256`, identifying the normalization and metadata contract. It must remain identical throughout the tape and match the prospective registration. A raw snapshot sample has no such certification and is rejected as an input tape.

| Event | Required fields and interpretation |
|---|---|
| `session` | `date`, `nextDate` (next exchange settlement session), `open`, `close`, `coverageFrom`, `coverageComplete`, `completeUniverse`, `source: recorded` or `synthetic`. Must precede that session's events. Primary coverage requires collection beginning by 04:00 Eastern, 330 minutes before the 09:30 regular open. Exact session times come from the exchange calendar, including DST and early closes. |
| `metadata` | `facts`, with field-level `value`, `availableAt`, `effectiveAt`, and retained source evidence for `listing`, `tradable`, `float`, `previousClose`, `volumeBaseline`, `news`, `tickSize`. The baseline includes `sessions: 30`, `lastSession`; news includes `classification: issuer_or_sec_material`, `sourceUrl`. `splitBasisVerified` must be true based on evidence. |
| `trade` | `ts`, `timestampNs`, `price`, `size` in shares, exact venue-qualified `id`, `eligible`, `priceEligible`, `volumeEligible`. Volume-only trades update cumulative/minute volume without changing OHLC, last eligible price, VWAP or triggering entries. Late, reversed-order or invalid eligible trades make the symbol unhealthy for the session. |
| `quote` | `ts`, `bid`, `ask`, `bidSize`, `askSize` in **shares**, `eligible`. Alpaca raw sizes are round lots: normalize with the verified instrument lot-size convention first. No default multiplier is inferred by the runner. |
| `halt` | `active: true`, `false`, or `null` for unknown. Unknown state blocks execution. |
| `correction`, `cancel` | Conservatively invalidate the symbol's pattern for the session; old decisions are never rewritten using later revisions. |
| `gap` | Invalidates session coverage and cancels new-entry eligibility. Exits retain exposure; halt status must be re-established after reconnection. |
| `coverage` | Subscription acknowledgement can only retain or reduce the session header's coverage; it cannot repair an earlier gap. |
| `invalid` | Invalidates that symbol for the session, records a data error and resets execution halt state to unknown. |
| `tick` | Advances timers, including entry expiry and time exits, even without a new trade. |

See `test/fixtures/momentum.js` for a complete **synthetic** contract example. Its observations are invented for tests and never count toward a holdout or profit claim.

The Alpaca adapter uses its documented **minute-bar** trade-condition rules for tapes A/B/C, taking the strictest rule across all conditions. Unknown codes invalidate the symbol instead of silently dropping their volume. It distinguishes tape-specific codes (for example `B`), excludes official duplicate open/close records, and includes odd-lot volume without allowing odd lots to set prices. Only regular `R` quotes are accepted for execution; slow, manual, auction, nonfirm and unfamiliar conditions are rejected. Nanosecond ordering is preserved even when two events share a millisecond. Trade IDs include tape and venue to prevent collisions across exchanges.

Halt state begins unknown. CTA status `3` and UTP status `T` indicate trading resumption; UTP quotation-only status `Q` does not. The adapter uses status codes, not a reason code mentioning a future reopening. A delayed or reversed resumption cannot reopen execution. A fresh broker `tradable: true`, a trade, or an empty halt list is not silently treated as proof of current halt state.

The integrated scanner requires a verified tick size in addition to the original filter. Once per second it ranks eligible stocks; the replay streams the complete scan decisions to `<report>.audit.jsonl` and retains only the last 100 scans in the report. On-demand metadata/status updates can trigger an additional scan. Input tapes allow reconstruction of all intermediate state.

## Strategy and execution behavior

The original hypothesis is retained in `momentum-experiment-v0.json`. The implementation uses completed trade-derived bars, a green new-high impulse after five prior bars, and a 1–3-bar pullback with at most 50% retracement, lower average volume and a final close above received-trade session VWAP. A subsequent received trade must break the completed pullback high. No unfinished candle's eventual high or volume enters a decision.

The integrated lane adds an explicitly conservative **one entry attempt per symbol/session**, including an order that expires unfilled. This is stricter than the earlier design's one filled entry. Record this choice in the implementation registration before evaluating unseen dates. A new tick-size regime resets the pattern; invalid or crossed latest quotes invalidate entry use of the preceding quote.

Entries are capped marketable limits with 1,000 ms arrival delay and 1,000 ms expiry after arrival. Available simulated size is capped at 10% of displayed shares. A partial entry cancels its remainder. Exits use delayed bid prices, can gap through the stop, and retain partial exposure. Each distinct bid price supplies only its size cap less shares already consumed; repeated unchanged quotes do not fabricate new liquidity. This is an intentionally conservative depth proxy, not a matching engine. Stress uses 3,500 ms delay and one adverse venue tick per execution. Spreads are embedded in executable prices and not deducted twice.

The portfolio reserves pending orders, shares the $3,000 exposure and $500 position limits, sizes to at most $10 planned stop risk, and latches a $30 daily entry halt on bid-marked equity loss. A halt does not guarantee a maximum realized loss. Cash-account proceeds remain unsettled until the supplied next exchange session. Limited-margin simulation may reuse proceeds without borrowing. External account reservations can be supplied programmatically; the CLI's $10,000 portfolio is hypothetical and does not import the running account's positions.

Quote marking is allowed outside regular hours, but fills are not. Open positions and pending orders remain visible at tape end; no final liquidation is invented. Fees on partial sell orders conservatively forgo the SEC notional waiver when final aggregate proceeds are not yet known. This can slightly overestimate fees; single-execution fee waivers use the known notional.

## Fees and registration

The current fee helper is the independently checked Robinhood listed-equity snapshot for 2026-04-04 through 2026-09-24. Other dates fail explicitly. Refresh and document the applicable dated fee schedule **before** recording the implementation hash and beginning the prospective experiment. A subsequently announced fee change requires a documented cost-model amendment and full repricing; it must never be used to select a favorable strategy variant.

`freeze` requires 120 future chronological exchange-calendar dates, ten completed pilot dates, an explicit operating-cost budget per session, pilot/report/calendar/data-contract hashes, float source, news taxonomy version, fee convention and operational signoff. It writes an immutable-by-convention file with an integrity digest; this is not a third-party timestamp or proof of when research occurred. These evidence hashes are supplied by the operator and require review, rather than being certified merely because a field is populated.

The replay records code, design and canonical line-input hashes. `assess` checks the registered code, matching input tapes, exact primary/stress scenarios and exact holdout dates, minimum 200 completed primary trades, complete liquidation and data coverage. It subtracts the registered daily operating cost and applies a five-session block bootstrap with 5,000 resamples. Positive lower net bounds and positive stress P/L are gates for execution-calibration review, never automatic deployment. Annual or monthly profitability is not assumed.

No prospective registration is created by default. The data, pilot and cost prerequisites must exist first. A price-only run is a diagnostic and must not be represented as a valid low-float test.

## Verified provider contracts

- [Alpaca snapshots](https://docs.alpaca.markets/us/reference/stocksnapshots-1)
- [Alpaca stock stream, conditions and size units](https://docs.alpaca.markets/us/docs/real-time-stock-pricing-data)
- [Alpaca minute-bar aggregation rules](https://docs.alpaca.markets/us/docs/market-data-faq)
- [Alpaca condition-code API](https://docs.alpaca.markets/us/reference/stockmetaconditions-1)
- [Alpaca news endpoint](https://docs.alpaca.markets/us/reference/news-3)
- [Robinhood fees](https://robinhood.com/us/en/support/articles/trading-fees-on-robinhood/)

Run `npm test` and `npm run check` before integration. The suite checks causal signal construction, incomplete metadata/coverage, shared capacity, delayed quotes, gaps through stops, partial exposure, settlement, daily-loss latching, registration tampering, provider normalization, timestamp precision, recorder integrity, calendar conversion and read-only provider access. It does not certify market profitability.
