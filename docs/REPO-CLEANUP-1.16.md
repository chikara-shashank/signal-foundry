# Repository cleanup / v1.16

The review covers application, browser, script, test, deployment, fixture and
documentation files. Credentials, runtime journals, backups and Git internals
are deliberately outside its scope. `npm run audit` prints current counts and
findings, verifies relative module targets, follows entrypoint reachability,
flags one-use named imports/exports and compares file content hashes.

## Changes

- Removed unused options/replay/test imports. Shared browser HTML escaping and
  DOM lookup replace repeated copies in six view modules; precision-specific
  number formatting remains local where its behavior differs.
- Moved the imported research report builder from `scripts/research.js` to
  `src/research-report.js`, with all replay/report/test callers updated.
- Replaced hardcoded component colors with semantic theme variables and expanded
  minified CSS into editable rules. The cached canvas palette avoids computing
  styles for every quote update.
- Reused performance panels across Live and Performance instead of duplicating
  DOM, chart instances, request coordination or filter state.
- Ten designs share one application. The standalone gallery is generated from
  current sources instead of maintaining ten dashboard copies.
- Added repeatable audit and gallery-generation commands. The release helper
  runs the audit after syntax checks and tests, before committing/deploying.

## Intentionally retained

`src/strategies.js` has an unused `positive` import, and
`src/momentum-conditions.js` exports `CONDITION_SOURCE` provenance without a
runtime consumer. These files participate in frozen strategy/normalization code
fingerprints. Removing these lines during a presentation release would change
experiment identities despite unchanged trading behavior. They are explicit
remaining findings, to revisit when deliberately versioning those experiments.

Replay, recovery, setup and research commands have active CLI, test, documentation
or CI uses; lack of an HTTP-server import is not evidence that they are dead.
Historical research documents preserve decisions and methodology. They were not
removed simply because a newer UI exists.

## Verification and limits

The full suite passes 295 tests, including campaign accounting, executable replay,
protection/recovery, sessions, API authorization and the public asset graph.
Browser verification covers the ten layouts, shared performance filters, chart
palette switching, the native chooser, other dashboard views and narrow screens.

The static audit reports no broken relative imports, unreachable JavaScript
modules or duplicate files. It is conservative: independently executable scripts
and tests are roots, identifier counting is not semantic dataflow analysis, and
CSS/dynamic strategy branches still require human review. This is not a claim
that every branch has production coverage or that no further cleanup is possible.
No strategy logic, trading parameters, credentials, broker state or journal data
is changed by this release.
