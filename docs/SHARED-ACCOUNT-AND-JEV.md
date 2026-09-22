# Shared account and Jev observability · v1.5

## Shared paper account

Set `ACCOUNT_POLICY=shared` alongside `MODE=paper`, then rebuild/recreate the existing Compose deployment. Keep its persistent volume and paper credentials. The default remains `dedicated`; live-money mode currently rejects shared-account policy.

External positions stay external. The engine does not import their cost basis into its journal or send orders to close them. External symbols and standard OCC option underlyings are reserved against new agent entries. For example, a QQQ option reserves QQQ while unrelated eligible instruments may trade.

Capital, gross/group/position allocation and daily-loss controls use the agent-owned book. The account's reported cash and non-marginable buying power also bound every allocation. A persisted cash ceiling incorporates known agent debits and credits; unrelated deposits or external sale proceeds do not automatically enlarge it. Pending orders continue to reserve capacity. This conservatism can leave usable broker cash unavailable to agents; changing the capital setting cannot raise the original cash anchor. There is no automatic cash-anchor reset.

Unmatched open orders, increases or reductions inconsistent with owned fills, unknown submissions, invalid account data and broker restrictions continue to block entries. Do not manually trade a symbol while the engine owns it. REST reconciliation is periodic: it cannot prove the absence of manual round trips between snapshots or guarantee that concurrent outside activity will not consume buying power. Only one Signal Foundry deployment may run against this account. Short external positions are unsupported by this release's account validation.

Agent P/L is reconstructed from journaled fills and current marks. Simulator fees are used when reported; broker trading fees are estimates. Model/cloud charges and external holdings/transfers are excluded. Each New York day's change starts at its first valid observation, not an invented midnight or market-open value. The chart provides an explicit **Agents only / Entire account** selector. Account-wide equity change still includes external activity and transfers.

A prior account-wide daily-loss halt remains in the journal. With an empty agent fill journal it does not become an agent loss halt. When migrating a previously filled agent book without prior agent accounting, an active legacy halt is carried forward conservatively. Once an agent loss halt triggers, raising its ceiling or restarting does not clear it that day. Loss halts can initiate reductions of managed positions; external positions are excluded.

## Jev input, output and decision impact

The numerical workers find setups. Before spending on Jev, the coordinator checks current account/ownership/allocation eligibility. A failed precheck records an **HTTP skipped** trace with the actual entry blockers. Eligible setups reach Jev's three typed questions: Noul coherence, Choice regime and Score contextual support. Eligibility is checked again after the model returns, before submission.

Open **Jev I/O** in the pipeline navigation. The panel refreshes every two seconds and shows up to 40 recent records across all instruments or one selected instrument. Choose a row to inspect:

- Exact JSON request body sent, including the numerical context and question instructions.
- Validated model answer fields, input-token usage, HTTP status, measured request duration and estimated cost.
- Mode, thresholds, errors, actual candidate decision/blockers and associated order ID.
- Whether the model was observed in shadow mode or vetoed the entry as a filter.

The response display is a typed projection, not the raw provider body. Credentials, authorization headers, unexpected response fields and raw transport error strings are excluded. Failed responses show an error without disclosing their raw body. A request interrupted by restart is labeled interrupted; unknown billing stays conservatively reserved. Traces are token-protected and retained for at most 3,000 records and the configured retention age. Financial candidates/orders remain in their existing long-lived journal.

Earlier releases did not retain exact HTTP inputs. Their historical rows explicitly show **historical numerical context**, with recorded parsed answers where available; they are never represented as newly captured wire requests. An explicit session ID distinguishes retained records from the current process, even when provider clock calibration moves timestamps across process start. The counters describe only records in the current view. View freezing and row/instrument selection do not pause trading.

`JEV_MODE=shadow` still cannot veto an entry or place an order. `filter` can veto candidates below its configured thresholds or on model failure. Neither setting proves economic value. Establish value by comparing fixed strategy variants after fees, slippage, model cost and latency, using out-of-sample evidence; the I/O panel is an observability tool, not that evaluation.

The v1.5.1 request includes the versioned setup definition, holding horizon and code-computed context labels. Its deadline respects remaining candidate and micro-context validity. See [Jev trading review](JEV-TRADING-REVIEW.md) for the source audit, measured behavior and the proposed higher-frequency architecture.

## Review and acceptance

First review found that globally ignoring external positions would mix agent risk with unrelated P/L and stale cash. The implementation instead validates owned quantities, calculates a separate agent ledger, preserves the actual broker cash ceiling and reserves externally occupied instruments.

Second review found avoidable model spending on already-blocked candidates, missing original request history and ambiguous shadow outcomes. The implementation adds prechecks, captured future requests, explicit historical disclosure and final-decision linkage. It retains a post-model eligibility check to cover changed state during model latency.

Third review exercised restart/budget recovery, stale broker cash, external deposits, manual quantity changes, scope switching and private payload rendering. Automated checks cover these contracts; a separate clearly labeled UI fixture exercises layout without provider access. Provider execution and economic results remain separate validation tasks.
