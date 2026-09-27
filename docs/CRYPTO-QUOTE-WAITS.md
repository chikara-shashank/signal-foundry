# Crypto quote waits · 1.18.1

Provider crypto bar signals may wait for an accepted executable quote until their original candidate expiry (currently ten seconds after detection). Quotes still must pass the configured freshness and bid/ask validation. Waiting does not extend the signal, change its features or target, reserve capital, or approve an order.

The `CryptoQuoteWaits` module owns the bounded, in-memory wait set and expiry timers. Every wake returns to the full entry check: current strategy generation, universe, snapshot, account, ownership, broker budget, price movement, spread, fees and allocation. A quote that ages during model evaluation can cause another wait within the same deadline; the same candidate does not pay for another model request. Submission still repeats the full check under the portfolio mutex.

Waits do not hold the account mutex. Crypto history dispatches symbols concurrently, and detected crypto candidates proceed independently, so a missing quote does not delay another symbol or strategy. Repeated quotes cannot submit the same candidate twice. Expiry works even if no more data arrives. Pause/cancel/flatten, strategy changes and shutdown cancel pending waits. After a restart, journaled waits are rejected as interrupted and never replayed into orders.

The Live view shows current waits plus expired, spread-blocked and cost-blocked signal counts since restart, along with detected, approved and other-blocked totals. Approval is not a fill. Waiting events appear in the decisions log. No thresholds, fees, position sizing, allocation or daily-loss limits change in this release.

This repairs execution timing. It does not establish a profitable crypto strategy or make sparse/zero-volume bars tradable.
