# Realtime display and timing — v1.4

## Behavior

Authenticated server-sent events push the selected instrument's quotes and changed short candles with a **100 ms target interval (10 Hz)**. This is a scheduling target, not a latency guarantee. The canvas draws on the browser's animation frame. Background tabs disconnect; visible tabs reconnect. Each browser retains a bounded quote/candle history and falls back to two-second dashboard polling during a stream failure. Eight simultaneous quote streams are allowed per engine. Slow clients are skipped and disconnected after five seconds of sustained backpressure.

The existing Alpaca market-data sockets now subscribe to trade prints as well as quotes and minute bars. There is no additional market-data socket per dashboard or strategy. The order stream uses a separate trading endpoint. Dashboard pushes do not generate provider model requests or brokerage orders.

## Candle meaning

The 1s/5s/15s views aggregate received trade prints by provider timestamp. Open/close use event ordering, including nanoseconds within the same millisecond. Integer provider trade IDs remain exact. Duplicates are ignored, corrections replace the original print at its original time, and cancellations remove prints. Missing intervals remain missing. No quotes are converted into pretend trades.

These display aggregates include reported trade sale conditions and **are not a reproduction of Alpaca's official eligible-sale bar rules**. The one-minute provider bars remain the strategy input. In particular, Alpaca crypto provider bars can include quote midpoints; this is disclosed in the minute-chart note. EMA overlays use whichever display interval is selected.

Trade history is held in memory for at most one hour, with a total configured cap of approximately 200,000 prints divided across instruments (minimum 1,000 per symbol). The visible chart keeps the latest 240 nonempty buckets. Truncation excludes incomplete leading buckets. Reconnect or an unresolvable correction clears affected history rather than asserting complete coverage. After restarting, short candles begin with new received trades. None of this changes numerical strategy thresholds, provider-bar warmup, Jev mode or entry gates.

## Measurements

Backend measurements retain the latest 1,000 observations per metric; browser measurements retain 120. Counters and distributions reset with their process or browser selection. A dash with zero samples means no measurement, not zero latency.

| Display | Measurement and interpretation |
|---|---|
| Feed age at receipt | Estimated provider event-to-engine delay using the calibrated Alpaca clock. Includes provider/transport processing and clock uncertainty. |
| Dispatch → draw | Estimated engine frame timestamp to completion of the browser draw callback. Uses a separate monotonic browser/server clock calibration; displayed as a range reflecting half the calibration round-trip time. Excludes physical screen presentation. |
| Canvas update | Browser draw callback duration. |
| Push cadence | Time between browser draw callbacks. Distinct from market-event age and order latency. |
| Strategy worker | Completed numerical worker round-trip duration as measured by the coordinator. |
| Jev HTTP attempt | Measured classifier attempt duration, including failures, only when a setup actually requests classification. Skips do not produce a sample. |
| Broker HTTP acknowledgment | Successful broker submission round-trip duration. Failed submissions are recorded separately. A successful response does not mean an order filled. |

Clock calibration has uncertainty from transport asymmetry and service timestamp behavior. Feed-age measurements and browser delivery estimates must not be interpreted as exchange-grade timing. There is no measured end-to-end Jev-to-fill latency until a qualifying setup, model request, order submission and observed fill occur.

## Broker events

The paper/live trading WebSocket authenticates and listens to `trade_updates`, including paper binary JSON frames. It performs no order submission. Recognized notifications are sanitized into the journal, appear in the log, and request the existing mutex-protected REST reconciliation after a coalesced 250 ms delay. The normal five-second reconciliation loop continues during outages. Browser metadata refresh is accelerated on a new event, subject to a one-second throttle.

An event can belong to external account activity. Stream payloads do not establish managed ownership, release reservations, adopt holdings, or directly set chart fills. Reconciliation remains authoritative for local order/position state. External activity and existing risk halts continue to block entries.

## Verification on 22 September 2026

- A paused, isolated shadow run consumed real IEX NVDA/SPY quotes, trade prints and provider bars. It used no broker order adapter and disabled Jev; the user's SIP paper deployment continued separately.
- The browser rendered one-second trade candles and timing cards. Sampled push cadence was about **108 ms median and 113 ms p95**, with canvas work around 1–2 ms. These observations are a local Windows smoke test, not a full-universe market-open load test or a cloud guarantee.
- A separate read-only check authenticated the real Alpaca paper trading stream and confirmed the `trade_updates` subscription. No provider order or fill was generated by these checks. No measured Jev inference or broker submission latency is claimed.
- Regression coverage includes data correction/cancellation, exact IDs, nanosecond ordering, stale data, authenticated SSE, backpressure, selection changes, binary broker events and reconciliation coalescing. See [VERIFICATION](VERIFICATION.md).

Provider specifications: [stock streaming](https://docs.alpaca.markets/us/docs/real-time-stock-pricing-data), [crypto streaming](https://docs.alpaca.markets/us/docs/real-time-crypto-pricing-data), [trading stream](https://docs.alpaca.markets/us/docs/websocket-streaming).
