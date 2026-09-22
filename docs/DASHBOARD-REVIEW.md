# Dashboard critique and corrective changes — v1.3

The previous preview was misleading: it used real ticker names with synthetic, accelerated prices and was opened on port 8091 alongside a separate Alpaca application on 8080. Its prices, evaluations and simulated fills did not describe the user's Alpaca account. The preview was stopped. No synthetic quotes are substituted for unavailable Alpaca data.

| Problem | Correction |
|---|---|
| Thousands of “evaluations” looked like Jev work or trade attempts | Label completed numerical strategy checks; show separate counts for unique setups, actual Jev requests, risk approvals, submissions and filled orders |
| No explanation for a quiet engine | Selected-instrument strategy checklist with actual values, unmet thresholds, current entry blocks and latest rejected setup |
| Jev spend alone did not establish activity | Mode and role, HTTP attempts, success/failure/skips, in-flight count and latest classifications, thresholds and latency |
| No readable operational history | Authenticated cursor-based live log with category, symbol, search and freeze controls; sampled no-setup and quote rejections |
| A large unlabeled price conflicted with bid and ask | Explicit currency-formatted midpoint, bid, ask and spread; provider timestamp and feed label; distinct execution prices |
| Connected sockets but no usable prices | Clock diagnosis, quote-rejection logging and authenticated provider clock calibration |
| Zero current positions looked like zero previous trades | Distinguish current holdings, process counters and retained filled-order totals |
| External account activity was opaque | Preserve the v1.2 reconciliation details and account-wide daily-loss explanation; never clear gates merely to create activity |

On 22 September 2026, authenticated read-only checks returned HTTP 200 for IEX quotes, SIP quotes, US crypto quotes and the Alpaca paper clock. The host clock was approximately 18 seconds behind Alpaca. The actual paper engine showed connected equity/crypto feeds, negative quote ages of approximately 18 seconds, and zero accepted quotes. Its separate entry gates included external account activity and the daily-loss halt. This establishes both a source-selection mistake in the preview and a real timing defect in the running application.

The fix keeps one trading coordinator and its journal. It does not turn numerical strategies into profitable strategies, does not place an operator test order, and does not establish Jev inference or exchange latency performance. Review actual signals, model calls and broker fills after rebuilding the real container; do not use the stopped demo's results to assess economics.
