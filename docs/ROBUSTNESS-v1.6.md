# v1.6: execution robustness and crypto economics

## Goal and evidence

Increase reliability and make the presence or absence of trading value measurable. This release does not assert profitable strategies or exchange-grade HFT. The audit found sparse crypto minute bars, substantial taker costs, repeated cold context, and no adequate evidence that a fast classifier establishes an edge.

The measured pipeline had a Jev median around 340 ms and p95 around 791 ms; broker acknowledgment was around 39/109 ms. These measurements are neither order fill latency nor a colocated exchange path. Exact figures change with the process and sample.

## Crypto profile

Real-data modes fetch the most recent 180 **provider-computed five-minute bars** from the configured Alpaca crypto location after a five-minute boundary. Pagination, OHLC validation, interval alignment, completion time and response size are checked. Failures retry after 30 seconds; no extra socket or paid model calls are needed. The first load only warms context. Only a new completed bar received within 20 seconds of its close can initiate an evaluation. REST history never replays old trade entries.

The five-minute feature history retains at most 120 actual observations, requires at least 30 and at least 95% bucket coverage, and requires the latest six observations to be consecutive. A gap longer than one absent five-minute bucket resets history. Missing buckets remain absent; volume and prices are never synthesized. Five- and fifteen-minute trends require adjacent complete aggregates. Source coverage and interval are visible in the dashboard and Jev input. Minute-bar charts remain distinct from this strategy context.

The existing bar setup families now operate on this longer crypto context. Stop distance uses 1.5 times observed five-minute ATR, with a two-distance target except VWAP reversion. Targets are never widened just to pass the cost gate. `CRYPTO_MAX_HOLD_MINUTES` defaults to 180; the existing risk, capital, spread and quote-age gates remain. The top-of-book OFI execution profile runs only on equities. This is a testable strategy hypothesis, not optimization on this audit sample.

Alpaca crypto bars include quote midpoints and can have zero traded volume. A valid zero-volume observation contributes price context, but the current setup still requires volume. A paid US equity feed does not improve liquidity or fee economics in the crypto venue. Marketable limits budget the configured taker fee on each side; a limit order is not automatically a maker trade. The dashboard shows target distance, estimated round-trip cost and an arithmetic break-even win rate. The latter assumes exact stop/target exits and is not a probability forecast.

## Execution changes

- New crypto entry limits use IOC. Exits retain GTC market orders. Never retry a POST after an uncertain response; resolve its client order ID.
- Entry intents retain the earlier of candidate expiration and the configured order TTL. Equity cancellation is asynchronous and still depends on reconciliation/broker availability; it is not an exchange-enforced expiry.
- A fresh crypto stop/target crossing is latched under the coordinator and requests coalesced reconciliation. This reduces dependence on the five-second timer; there is no guaranteed exit time during network/broker failures.
- Known venue order IDs use one nested lookup instead of a client-ID lookup followed by another request. Full 500-row open-order responses fail closed rather than assuming no omitted external order.
- A per-process rolling budget admits new entries only below 120 REST calls/minute, bounds ordinary reads at 160, and keeps room up to 180 for mutations. A 429 starts backoff. Other applications sharing the account are outside this local budget; their usage can still cause rate limiting. There is no position-count cap when `MAX_POSITIONS=0`.
- Sub-millisecond quote ordering is preserved for OFI. Late updates inside the same millisecond no longer overwrite a newer book.
- Quantity tolerance uses the fee rate frozen with the entry. Below-minimum crypto residual exits are recorded for attention rather than repeatedly submitted as invalid orders. External holdings are never adopted or sold.

## Evidence collection

`GET /api/research` requires the existing dashboard token. The new **Strategy economics** panel groups retained local closed/partial fills by strategy and asset class, including fee estimates, net P/L and sample size. Native exit records are deduplicated. Fee estimates use the rate frozen at entry/exit (or the simulator's recorded fee), rather than changing history when `.env` changes. The report's drawdown uses agent-only daily P/L in shared mode and does not mistake external holdings for strategy performance.

For Jev requests that passed the precheck and returned a typed quality score, a forward observer measures the next eligible ask after a one-second delay and the bid three minutes later for equities or fifteen minutes later for crypto. It includes configured fees/slippage, excludes missing quotes, and permits only one overlapping observation per symbol. Groups retain the configuration fingerprint and model pass/decline status. It sends no orders. Pending observations do not survive restart; completed records follow event retention and the dashboard reads at most 5,000 from seven days.

These quote outcomes do not model queue position, order-book depth, partial fills, market impact, stop/target exits or capital contention. Passing and declined candidates are selected populations, not a randomized causal experiment. Do not tune thresholds on this panel and call the result out-of-sample evidence. Crypto base-asset fees and residual balances still need reconciliation against broker activities; the scorecard conservatively leaves residual trades partial and is not a tax/accounting ledger. Agent marks may conservatively overestimate crypto fee drag before fee reconciliation.

## Critique and acceptance

1. **Data critique:** minute bars were genuinely absent at the provider, so forward fill or repeated REST requests would hide the problem. Use authoritative five-minute aggregates, explicit bounded missing coverage, fresh recent context and no historical execution. Verified read-only against both configured crypto instruments.
2. **Execution critique:** a short-lived signal could previously leave a longer-lived crypto limit. Use IOC, durable expiry and no blind submit retry; test late fills, restart, partial fills, ownership and cancellation behavior.
3. **Economic critique:** turnover and model confidence are not edge. Retain fee gating, separate realized and hypothetical evidence, label insufficient samples and preserve original financial controls. Do not manufacture optimistic net results by using maker fees for aggressive entries.
4. **Release critique:** authenticated read-only API; no secrets in logs/source; no schema deletion; no runtime-volume replacement. Browser QA uses an isolated synthetic instance. Production behavior needs a rebuilt container and an observed paper run.

Further validation requires independent held-out periods, several regimes, realistic fill and cost sensitivity, and a comparison of the same policy with/without recorded Jev decisions. Avoid selecting the best in-sample strategy from a tiny journal. No automatic capital increase or automatic live-mode promotion is included.

## Sources checked September 22, 2026

- [Alpaca crypto stream semantics](https://docs.alpaca.markets/us/docs/real-time-crypto-pricing-data): midpoint bars, timestamps, sparse activity.
- [Historical crypto bars](https://docs.alpaca.markets/us/reference/cryptobars-1): timeframes and pagination.
- [Crypto orders and fees](https://docs.alpaca.markets/us/docs/crypto-trading): IOC/GTC, fee tiers, fees in the received asset.
- [Alpaca paper trading](https://docs.alpaca.markets/us/docs/paper-trading): simulator limitations.
- [Jev model limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13): keep financial calculations deterministic.

## Activate

Rebuild from the directory containing the active `.env`:

```powershell
docker compose up --build -d --force-recreate --wait --wait-timeout 180
```

Refresh and reconnect the dashboard, then use **Strategy economics**. No new keys are required. The new crypto hold setting has a default; existing `.env` files remain valid. Journals, external-account ownership, operator pause, the saved daily-loss ceiling and Jev filter mode remain in effect.
