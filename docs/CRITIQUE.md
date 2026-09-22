# Design and implementation critique log

These are successive local review passes, not independent external audits. Findings are tied to changes and tests. No finite review makes a trading system bulletproof.

## Round 1 — strategy and product, before implementation

| Finding | Severity | Resolution |
|---|---|---|
| Jev confidence could be mistaken for win probability | High | Separate contextual scoring from risk math; do not publish expected returns from uncalibrated confidence. |
| Too many markets/adapters obscure validation | Medium | One Alpaca adapter for US equities and BTC/ETH spot; long-only v1. |
| $500 budget confused with capital | High | Separate operating cost, capital, fees, and engineering effort throughout requirements. |
| Unlimited parallel agents amplify correlated exposure | High | Numerical worker threads (expanded from three to six), one serialized account authority, aggregate and group caps. |
| Always-on mistaken for always-trading | Medium | Crypto continuous eligibility, equity broker-clock/session gate. |
| Paper gains interpreted as edge | High | Replay/shadow/paper are engineering/research stages; live economics remain unverified. |

## Round 2 — failure and security review, before implementation

| Finding | Severity | Required change |
|---|---|---|
| HTTP timeout can hide an accepted order | Critical | Persist intent before send; client-ID reconciliation; retain reservation and fail closed. |
| Cancel success is not cancellation completion | Critical | Wait for terminal status before releasing capacity or selling independently. |
| Multiple workers can double-spend cash | Critical | Shared coordinator mutex plus durable reservation before network I/O. |
| Restart can clear loss limits/model spend | High | Persist baselines, pauses, budget reservations, and unresolved intents. |
| Bracket stops activate only after full entry fill | High | Partial-entry expiry management; record temporary exposure and test canceled-partial reduction. |
| Crypto lacks the same bracket protection | High | Separate live-crypto acknowledgment; software exits, explicit outage limitation. |
| Unknown account positions could be liquidated | Critical | Dedicated account, account-ID check, external-position entry pause, manage only recorded ownership. |
| Dashboard remotely accessible with controls | Critical | Loopback publish, token auth, same-origin validation, cloud tunnels. |
| Healthy HTTP server can mask stalled trading engine | High | Separate engine heartbeat and watchdog process exit. |
| SQLite replicas can corrupt operational assumptions | High | One replica, persistent disk, transactional lease, no network filesystem. |

## Round 3 — implementation and adversarial validation

| Finding | Severity | Implemented resolution and evidence |
|---|---|---|
| A POST can succeed while its HTTP response is lost | Critical | Simulated accept-then-timeout test proves client-ID lookup recovers the order without a second submission. |
| Filled order status can precede position/cash visibility | Critical | Keep filled and terminal-partially-filled reservations until quantity and cash-flow checks reconcile. Three delayed-visibility tests plus immediate-fill allocation test pass. |
| Flatten can race an entry fill after cancellation request | Critical | Persist an exit-after-fill marker; test confirms the late fill retains the operator reduction request. |
| Independent exit can race bracket children | Critical | Query nested protective legs; cancel and wait for terminal acknowledgment before independent sell. Payload and cancellation tests pass. |
| Manual additions to a managed symbol could be sold by the bot | Critical | Detect quantity above owned fills minus exits; mark ownership ambiguous and skip liquidation. Regression test passes. |
| Partial entry cancellation can leave exposure | High | Preserve actual filled quantity and reduce only the reconciled available holding. Regression test passes. |
| Restart can replay old synthetic time or lose operator state | Medium | Persist demonstration time/price state; restart tests cover timeline, ownership, pause and daily-loss latch. |
| Reused model confidence could bypass freshness checks | High | Recheck quotes, candidate expiration, feature version, pause and allocation under the coordinator lock after model evaluation. |
| HTTP control can be invoked without authorization or cross-origin | Critical | Token and origin tests pass; no provider credentials are exposed in API status. |
| Silent authenticated feed can stay connected without data | High | Active-market inactivity timeout reconnects after 90 seconds. Freshness gates block earlier; external heartbeat stops on unhealthy quotes. This timeout needs credential-backed fault injection. |
| Latency fields could mix worker and prior model time | Medium | Capture worker-batch duration immediately after worker completion; report worker/model/submission percentiles separately. |
| Budget reports could be confused with verified bills | Medium | Persistent conservative model reservations; provider billing remains authoritative. Trading report fees are explicitly estimates. |

Final local suite: **35 tests passed** with no skips, plus syntax check, deterministic replay, dashboard browser checks, and Compose configuration validation. See [verification](VERIFICATION.md) for boundaries.

## Round 4 — quant and HFT scope review

| Finding | Resolution |
|---|---|
| Fast classification was being treated as exchange-level execution speed | Document the full observation-to-fill path; no HFT SLA. Quote scans are throttled at 250ms, while reconciliation/software exits run every five seconds plus I/O. |
| Best-quote data could be mistaken for a reconstructed order book | Label imbalance/OFI/microprice as L1 proxies. Require valid sizes and sufficient observations; test sign, freshness and minimum history. |
| A pairs score could be presented as executable arbitrage | Keep the synchronized prior-window regression scanner research-only; test that the current observation is excluded from fitting. |
| Adding recent papers could imply replicated results | Cite primary papers and list data/simulator requirements. No MBO clustering, trained RL policy, or proprietary strategy replication is claimed. |
| Six strategies could imply six independent bets | All share group/gross/position/cash gates and a symbol cooldown. No independence assumption or automatic capital scaling. |
| Synthetic gains could be presented as validation | Ship an explicitly artificial fixture and separate descriptive reports from promotion evidence. No profitable edge has been demonstrated. |

Residual release constraints: actual Alpaca/TypeSafe contracts and account permissions need key-backed validation; Docker runtime and cloud plans remain unverified in this environment; crypto protection depends on host/network availability; SQLite audit growth requires disk monitoring; account cash adjustments/dividends/deposits require investigation; no independent security or quant audit has occurred. These are open operational boundaries, not passed checks.

## v1.1 review — visibility and paper execution

- User-visible mode confusion: configured keys do not imply live prices. Added explicit data/execution labels and actionable running-mode diagnostics.
- Polling replaced clickable tape nodes, making selection unreliable. Reuse keyed event buttons and preserve inspector selection across refreshes.
- Order acceptance could be mistaken for execution. Only positive filled quantities with known fill/observation times receive fill markers; older unknown times are not fabricated.
- Missing minutes could look like full aggregated candles. Incomplete 5m/15m groups are outlined and documented.
- Manual testing could bypass strategy/risk boundaries. Paper connectivity tests are distinctly labeled, bounded to one share/$25 crypto, idempotent, throttled, and forbidden by the API and engine in live mode. Model/strategy qualification is intentionally not required for a connectivity test; all account/capacity/freshness/session checks remain.
- Container fixture was excluded by a broad `.dockerignore` rule. Added a specific inclusion for the supplied synthetic fixture, while retaining secret/runtime exclusions.
