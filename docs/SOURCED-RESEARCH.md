# Sourced research and recorded-policy comparison

Implemented September 27, 2026. This adapts the useful separation of evidence,
thesis and opposing case in TradingAgents to Signal Foundry's existing Jev and
Alpaca integration. It does not import TradingAgents, require Python, or introduce
another model subscription. No external code was copied.

## Runtime behavior

`RESEARCH_CONTEXT_MODE` supports `off` and `shadow` only. It defaults to shadow in
paper/shadow engine modes and off in demo/live; demo and live reject an explicit
shadow setting. Research requires the existing Jev key and a non-off `JEV_MODE`.
There is deliberately no research `filter` mode or automatic promotion.

The background service selects at most four equities from managed symbols and the
existing next-session watchlist. It uses the latest four relevant Alpaca articles
per company, captured with publication, revision and observation times, source
links, article digests, completed-bar context and the managed portfolio snapshot.
It never fetches data inside candidate approval or protective exits. The broad
numerical scanner remains responsible for finding trading setups.

Jev performs two typed classification passes. The first marks each source as
supporting, contrary, irrelevant or unclear and classifies the company catalyst.
The second independently tests the proposed case against the same evidence.
Source references are assembled from supplied IDs, not generated links. Narrative
text is deliberately a short deterministic description, with the actual linked
headlines shown alongside it; this provider path is not a free-form LLM essay.
Both passes require adequate confidence and consistent per-source answers before
their research hypothesis is marked passing. Scores are not win probabilities.

Research does not place, veto, resize or close orders. It attaches the currently
available research reference to new numerical candidates and resulting entries.
The prior adverse-news gate and existing Jev entry filter are separate and retain
their behavior. The accepted $2,000 saved daily-loss override and the engine-based
overnight cap are untouched. Options execution and crypto strategies are unchanged.

## Budgets, expiry and recovery

Defaults:

```dotenv
# Defaults automatically in paper/shadow; never set shadow for demo/live.
RESEARCH_CONTEXT_MODE=shadow
RESEARCH_CONTEXT_DAILY_CALLS=8
RESEARCH_CONTEXT_SYMBOLS=4
RESEARCH_CONTEXT_TTL_MINUTES=60
```

One pass is attempted per 15-second poll at most. Eight calls allow four complete
two-pass reviews, fewer if failures consume reservations. Both passes share the
existing pinned Jev model, monthly spending ledger and RPM limits. Research leaves
one concurrency slot, four RPM slots and one maximum-request dollar reservation
for other model work. It is still an additional consumer of the shared budget.
Timeouts/unknown billing retain their reservations. Failed jobs back off five
minutes. A saved thesis resumes at the critic after restart without repeating the
successful first pass. An interrupted, unconfirmed HTTP call is not assumed free.

Packets expire after one hour by default, and no later than the oldest source's
36-hour news window. Revised sources invalidate current context. Stale/incomplete
news intake suspends its availability; unchanged evidence can resume after a
complete fresh poll without another model call. These availability intervals are
recorded for replay. Model results are stamped at completion; they cannot be used
before that time or after evidence expiry. Portfolio checks always use the actual
current book, not this research snapshot.

Immutable `research_records`, `research_calls`, `research_invalidations`, the
`research_coverage` availability timeline, and
completed candidate `model_reviews` survive ordinary event/UI-trace pruning.
`research_jobs` holds restart checkpoints. These tables are included in existing
SQLite backups. Review/export/archive long-running journals to manage disk growth.
Pending forward quote markouts now also survive restarts; missed observation
windows are marked missing instead of reconstructed from later prices.

## Review and export

The Research tab's Sessions & tomorrow section includes **Thesis & opposing
evidence**, with links, objections, observation/expiry times, cost and explicit
unknowns. `/api/research-context` requires the usual dashboard authentication and
is read-only. No credentials are exported to the browser or model request body.

Export from a journal or verified backup; this command opens SQLite read-only,
uses a single read transaction, never runs the engine, and refuses to overwrite:

```powershell
npm run research:export -- C:\path\to\paper.sqlite C:\path\to\research.json
```

For Docker, use an exported/backup SQLite file. Do not run a second paper engine
against the mounted account journal to obtain an export.

## Four-policy experiment

```powershell
npm run research:compare -- C:\path\to\tape.json C:\path\to\calendar.json C:\path\to\research.json C:\path\to\comparison.json C:\path\to\settings.json
```

The last settings argument is optional, but matching the frozen production
settings is necessary for a meaningful experiment. This comparison currently
supports the six equity worker strategies, not session/carry strategies, crypto
or options. For example, settings can explicitly select `range_breakout`.

The existing schema-1 equity tape must contain receipt-ordered quotes with
displayed bid/ask sizes, completed bars (including sufficient warmup), and
heartbeat events; its `now` is the observation clock, not a timestamp invented
from today's data. Calendar coverage must have been known before the tape starts.
Research export does **not** produce this market tape. Minute chart history or a
current headline query cannot reconstruct it. Jev matching requires the original
candidate timestamp, semantic feature snapshot, request digest, pinned model,
rubric and thresholds. Divergent or absent recordings become missing coverage.

The four independent portfolios use identical initial capital and risk settings:

1. `rules`: numerical triggers and existing portfolio/price gates.
2. `jev`: recorded per-candidate Jev results, applied only after observed latency.
3. `context`: an already-available sourced thesis as an experimental entry filter.
4. `critic`: the thesis plus an already-completed opposing-case review.

Research-filter modes exist only in the offline adapter. Market events continue
while recorded Jev results are pending; entry gates rerun at completion, and late
results cannot revive expired candidates. No model or market HTTP calls occur.
Source revisions invalidate the related thesis and critic together. Missing
answers reject candidates and are counted explicitly, rather than acting as passes.

Reports include closed trades, win rate, realized net P/L, recorded model costs,
marked P/L, open positions/pending orders, model coverage, and baseline winners
and losers skipped by each policy. The existing daily drawdown statistic remains
a within-day observed measure before model costs; it is not full-period drawdown.
Closed-trade expectancy excludes partial closures; realized P/L includes realized
portions. Open exposure and accounting discrepancies prevent a complete comparison.

All recorded research attempts inside the tape window, including failed attempts
with reserved costs, are charged once to the applicable policy. Pre-window
research costs are excluded and identified. This replays a fixed research schedule;
it does not claim to simulate how a changed portfolio would schedule future model
work. Skipped baseline trades are diagnostics, not additive achievable profits.

## Validation and remaining evidence

Synthetic tests verify timing, complete filled trades, opportunity costs,
evidence integrity, revisions, schema rejection, budgets, recovery, authenticated
UI reads and escaping. Synthetic profits establish no predictive edge.

Before changing entry behavior: freeze source/config/prompt versions and date
ranges; preserve prospective raw inputs and answers; compare on unseen dates;
repeat with adverse execution assumptions; evaluate net expectancy and drawdown
with uncertainty across days; inspect missed winners and missing coverage. A newer
model analyzing an old date can retain training-data knowledge even with correctly
dated source documents, so prospective shadow evidence is preferred.

No historical profitability claim, automatic strategy enablement, or live
qualification is produced. Future SEC fundamentals, complete earnings calendars,
consensus surprises, calibrated outcome retrieval and options context remain
separate additions. The current implementation uses only available Alpaca news;
missing sources are explicit, never fabricated.

Design references: [TradingAgents workflow](https://github.com/TauricResearch/TradingAgents/blob/main/tradingagents/graph/setup.py),
[structured proposals](https://github.com/TauricResearch/TradingAgents/blob/main/tradingagents/agents/schemas.py),
[decision-only backtest scope](https://github.com/TauricResearch/TradingAgents/blob/main/tradingagents/backtest.py).
