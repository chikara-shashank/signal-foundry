# Dashboard views

The dashboard opens on **Live**. Its six views share the same authenticated,
in-memory session and engine status. Changing tabs never changes trading state.

| Tab | Contents |
| --- | --- |
| Live | Feed health, account and agent totals, trade-return timeline, account/agent P/L, open positions, price chart, execution tape, timing, market watch |
| Operations | Entry controls, execution funnel, external holdings, protection/accounting, workers, risk limits, paper execution test |
| Strategies | Strategy toggles/results, options lab controls, numerical checks, Jev classification context |
| Research | Sessions, closing/news research, tomorrow's watchlist, stock discovery, order-flow and relative-value diagnostics |
| Performance | Individual trade returns, account/agent P/L, strategy economics and forward observations |
| Logs | Decision/execution log, Jev input/output, candidate journal, activity and order journal |

Tabs support Arrow Left/Right, Home/End, browser Back/Forward, and existing section
hash links such as `#trade-return-panel`. Only the active tab is exposed to keyboard
navigation and screen readers. Status remains current across tabs; tab-specific
requests run only while that tab is selected. The browser quote stream closes when
leaving Live or hiding the browser document. This does not change provider feeds
or engine position management.

## Shared performance and appearance

Live and Performance move the same pair of chart panels between their view hosts.
There is one set of filters, chart state, request throttles and accessible IDs.
Switching views preserves ticker, position status, day window, resolution and P/L
scope. Both views refresh the same data; hidden views do not create extra polls.

The header **Light** and **Dark** buttons select **Ledger** and **Copper**.
Ledger is the default, including the initial HTML before JavaScript loads. The
choice stays in browser local storage; the older prototype preference is not
reused. `?design=copper#view-live` can link directly to the dark theme. Invalid
or non-selected prototype IDs fall back to Ledger in the working application.
The theme chooser contains only these two selected designs. Authentication stays
in tab memory; appearance never calls a trading endpoint or changes strategies
or risk settings. The standalone gallery retains all ten studies for comparison.

All six views use shared color variables, including the canvas charts. Panels
collapse to a single reading column on smaller screens; wide tables scroll within
their panels. Keyboard focus remains visible and the native chooser dialog
supports Escape and returns focus to its trigger.

Run `npm run designs -- path/to/dashboard-designs.html` to generate a standalone
comparison from the actual dashboard markup, CSS and chart modules. The artifact
uses a deterministic in-memory fixture, never loads `.env`, disables trading
controls and disallows network connections inside its previews. Live/Performance
navigation, return filters and chart interaction work offline. Other application
views and unsupported price intervals are explicitly disabled in the artifact;
they remain available in the authenticated application. The file contains only
fictional values, not a snapshot of the Alpaca account.

## Minute trade returns

`GET /api/trade-performance?days=1&interval=1` accepts day windows of 1, 7 or 30
and minute intervals of 1, 5 or 15. The default/minimum chart resolution is one
minute. The UI offers zoom, pan, Fit trades and a one-minute viewport shortcut;
horizontal tick spacing never falls below one minute.

Raw observations remain recorded by reconciliation, at most once per ten seconds.
The read-only chart query groups these into clock-aligned intervals **before** its
3,000-interval per-trade response cap. It returns the last actual timestamp/value,
observed high/low, sample count and gap flag. Thin vertical lines show interval
highs/lows; no intraminute ordering is inferred. The current interval is provisional.
Missing observations remain gaps, and a late confirmed exit excludes marks after
the actual exit timestamp. Exact fill timestamps and live endpoint valuations are
not rounded. Longer histories can require a coarser resolution; truncation is
explicitly disclosed. No missing historical prices are invented.

Returns and table P/L retain their existing basis: engine-owned campaigns,
including additions, partial exits and estimated trading fees. External holdings
and the hypothetical options lab remain excluded. Chart requests never place
orders, alter stored fills, or create observations.

## Module boundaries

- `app.js`: authentication, shared refresh coordination and the live market chart.
- `dashboard-tabs.js`: accessible routing and view visibility; optional history-free routing for offline previews.
- `dashboard-design.js` / `design-catalog.js`: appearance selection and the ten design definitions.
- `dashboard-designs.css` / `chart-palette.js`: shared theme tokens, layouts and cached canvas palettes.
- `performance-panels.js`: one pair of performance panels shared by Live and Performance.
- `dashboard-controls.js`: operator actions, editable risk state, paper test request identity.
- `dashboard-status.js` / `dashboard-format.js`: status rendering and common formatting.
- `account-performance.js` / `research-results.js`: dedicated historical-result views.
- `trade-performance.js`: return filters, loading state and the accessible table.
- `trade-return-chart.js` / `return-timeline.js`: canvas drawing and pure time/viewport math.
- `src/trade-performance.js`: campaign accounting and response assembly.
- `Store.tradeMarkBuckets`: read-only interval aggregation of retained observations.

The former count-based thinning path was removed. Public modules are served from
an explicit allowlist; adding a module requires registering it in `src/server.js`.
The asset-graph test catches missing registrations without exposing private files.
