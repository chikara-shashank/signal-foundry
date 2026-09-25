# Trade-return timeline · v1.15

Use **Performance** in the dashboard navigation, or open `/#trade-return-panel`. Time is horizontal, percentage return is vertical. All timestamps are New York time, including dates for multi-day windows. Resolution defaults to one minute, with five- and fifteen-minute summaries available. Zoom and pan controls include a one-minute minimum viewport.

- Blue triangles: entry at the 0% reference. Trading costs mean the actual post-entry return can already be negative.
- Filled diamonds: final exits, green for positive and red for negative return.
- Filled circles with an outer ring: active positions at a fresh bid. Hollow circles marked **(last)**: last recorded observations, not current valuations.
- Solid lines: observations saved by the running engine. Dotted connectors link known endpoints and are not reconstructed price history. Outages remain breaks.
- Select a trade in the table to isolate its path and see its cumulative entry, addition and exit fill records. The table is keyboard accessible and provides exact figures without relying on colors or mouse hover.
- Filter to a ticker, closed trades or active/settling positions, over 24 hours, 7 days or 30 days. Old active positions remain included, but entry markers outside the window are not moved to a false timestamp.

## Accounting basis

For each explicitly linked campaign:

`net = filled sell proceeds + remaining quantity × fresh bid − filled buy costs − entry/exit fees − estimated fees to sell the remainder`

`return % = 100 × net / (filled buy costs + entry fees)`

Partial exits remain in total P/L, and additions increase the capital denominator. This is a trade-level return on cumulative deployed capital, not a portfolio return or time-weighted return. Repeated unrelated trades in the same ticker remain separate. Native bracket exit records are deduplicated against the order journal.

Closed returns use final recorded fill prices. Active returns require fresh quotes and reconciliation of the owned quantity. An unfilled order is not a trade. Overfills, replacements and broken ownership links are unpriced pending review. External holdings and options-lab research are outside this chart's stock/crypto fill journal. Fees are reported where available, otherwise estimated; model/cloud expenses are excluded. This is not broker-certified accounting or a guarantee of execution at the displayed bid; exit slippage is not included.

## Historical coverage and limits

The engine attempts to save observations every 10 seconds after successful reconciliation. Fast price moves between observations can be missed; this is not a tick replay. The chart refreshes every 5 seconds and may display a newer bid mark than the most recent saved point. Reading the API never sends broker requests or writes history.

The SQLite `trade_marks` table is created automatically on startup. It survives restarts and is included in normal database backups. Observation retention follows `RETENTION_DAYS` (30 by default); fill records remain in the long-lived audit journal. API range selection is bounded to 1, 7 or 30 days. Up to 100 campaigns are returned, prioritizing active campaigns, with a visible truncation message if needed. Per campaign, observations are grouped into clock-aligned 1, 5 or 15 minute intervals before limiting the response to the latest 3,000 intervals. Each interval retains its last actual valuation, observed high/low range and missing-data flag. The UI discloses the cap; a coarser resolution covers more history. Fill timestamps and current endpoint valuations keep their original precision. See [dashboard module details](dashboard.md).

Pre-upgrade trades have entry/exit endpoints only unless forward observations were recorded while they remained open. Earlier intratrade paths are not fabricated from candles or the final position size. Unknown fill timestamps remain unknown. New entries retain their first observed fill time, so subsequent partial fills do not move the entry reference forward. Historical records without that field use the known cumulative-fill timestamp, which can describe completion or observation of the latest cumulative fill rather than the first partial execution. Focused details disclose this limitation.

Chart-collection errors are surfaced in the panel and do not disable position management. The panel marks cached active values on a dashboard disconnect. Authentication and same-origin dashboard policies apply to `GET /api/trade-performance?days=1`.

## Verification and release

The test suite covers fee arithmetic, positive/negative closes, duplicate native fills, partial exits, scale-ins, stale quotes/reconciliation, malformed executions, unknown timestamps, retention/restart durability, minute aggregation/extrema/gaps, viewport boundaries, API authentication/bounds, public module loading and engine integration. UI verification uses isolated synthetic data and does not submit provider orders.

Run `node scripts/check.js` and `node --test --test-concurrency=1 test/*.test.js`. The existing `scripts/finish-release.ps1` workflow commits source to local main, then builds and deploys the container on port 8080 with an online journal backup, rollback image and preservation of the approved $2,000 daily-loss setting.
