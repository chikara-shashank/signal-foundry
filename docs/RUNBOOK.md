# Operations runbook

## Configuration and readiness

1. Use one engine per account. The default dedicated policy blocks external holdings; paper accounts can opt into `ACCOUNT_POLICY=shared` under the ownership, cash and P/L constraints in [shared-account operations](SHARED-ACCOUNT-AND-JEV.md). Do not manually trade engine-owned symbols. Verify state/product eligibility and account-specific intraday buying-power rules.
2. Start demo and verify dashboard login, pause, resume, order records, and restart behavior.
3. Set paper credentials. Run doctor, then confirm both streaming feeds show `streaming` where enabled. `feed_error_409` indicates a data-entitlement problem; `406` can indicate an existing connection consuming your subscription's allowance.
4. Start Jev in shadow, inspect stored results, then evaluate a filter as a separate research experiment.
5. Configure actual fee assumptions and capital/risk limits. The default $10,000 capital is simulation/configuration budget, not a statement of your funds.
6. Configure `HEARTBEAT_URL` with an external dead-man monitor. The application posts an empty success ping once a minute only when reconciliation and active-market quotes are healthy. Set an external alert at >3 missed minutes and test it by stopping a paper deployment. The monitor's own notification destination belongs to you.

Dashboard readiness refers to account gates; each entry separately requires current quotes and sufficiently warm features. Equities can show old quotes when the market is closed without the service being broken. Price-triggered exits require valid current quotes; session/time exits use broker execution without pretending an old quote is tradable.

## Operator actions

| Action | Effect |
|---|---|
| Pause entries | Persistently disables new allocations; reconciliation and exits continue. Existing pending entries are canceled on the next reconciliation. |
| Resume | Clears operator pause only; it cannot clear a daily-loss latch, unknown order, or account restriction. |
| Cancel entries | Pauses new entries and requests cancellation of managed pending entry orders. Capacity stays reserved until acknowledged. |
| Flatten managed | Pauses entries; marks current positions and late fills for closure. Cancels native exits and waits for settlement before independent sells. External/ownership-ambiguous holdings are left for account-level investigation. |
| Stop service | Stops the process. It does not flatten the account. Broker-held orders can remain active. |

Flatten is a workflow, not a promise of an immediate fill. Inspect broker positions and journal status for completion. Crypto dust below the venue's increment can remain and requires venue-specific handling.

## Faults

- **unresolved_order:** a network failure may have hidden broker acceptance. Reconciliation searches the same client ID; no automatic second POST occurs. If it remains missing, use the broker's order history and support to establish the outcome. Do not delete the journal or manually free its reservation while uncertain. This conservative condition requires operator investigation if the broker never establishes an outcome.
- **external_account_activity:** dedicated policy found an external holding/order or inconsistent managed quantity. Restore a matching journal where appropriate, or use the documented shared paper-account policy for unrelated existing holdings. Do not delete the volume.
- **external_orders_pending:** shared policy found unmatched open orders; inspect and resolve those orders in the broker account. The engine does not cancel them.
- **managed_position_conflict / agent_accounting_unavailable:** owned fills and broker quantities/marks cannot be reconciled. Investigate the matching journal and broker activity; do not adopt a discrepant quantity or clear the gate by deleting data.
- **fill_not_reconciled / cash_not_reconciled:** broker fill status, quantity or cash has not reconciled. Reservations remain allocated. Under dedicated policy, gross fill cash flow is checked against a persistent initial anchor; deposits, dividends or other positive adjustments can also trigger this conservative pause. Under shared policy, unrelated credits do not block reconciliation or increase the conservative agent cash ceiling. Inspect broker activities and reconcile the journal before changing an anchor; there is no automatic reset or dashboard override for this condition.
- **daily_loss_limit:** entries remain disabled for the remainder of the New York date even if equity recovers or the process restarts. Managed positions enter the reduction workflow. Session transitions establish a new baseline; an operator pause remains set.
- **broker_reconciliation_failed:** new entries pause; existing broker-held protection remains subject to venue behavior. Resolve connectivity/credentials, inspect broker state, and confirm recovery.
- **model_budget_exhausted / unavailable:** filter-dependent entries are rejected. Shadow/off behavior is fixed by your configuration; the system does not silently switch strategy variants. Exits do not depend on Jev.
- **feed reconnecting:** fresh-data gates prevent new orders. The receiver resubscribes after backoff. A missing minute resets strategy warmup; no fabricated bars.
- **database/lease failure:** process stops rather than continuing without an authoritative journal. Docker restarts it. Allow up to two minutes for a crashed owner's lease to expire. Never scale replicas.

## Persistence, backup and restore

Named Docker volume: `signal-foundry_trading-data` under the default Compose project name. Daily consistent SQLite snapshots are written under `/app/data/backups`, with seven retained per mode. These copies share the host's failure domain until exported.

Export snapshots:

```sh
mkdir -p backups
docker compose cp engine:/app/data/backups/. ./backups/
```

Copy to your own encrypted object bucket with `aws s3 sync ./backups s3://YOUR-BUCKET/signal-foundry/` or `gcloud storage rsync ./backups gs://YOUR-BUCKET/signal-foundry/`. Bucket creation, IAM, retention, and scheduling are account-specific. Terraform does not provision backup buckets. For a fresh immediate consistent snapshot, use:

```sh
docker compose exec engine node --input-type=module -e 'import {Store} from "./src/store.js"; const s=new Store(`/app/data/${process.env.MODE}.sqlite`); await s.backup(`/app/data/backups/manual-${process.env.MODE}.sqlite`); s.close();'
```

Restore only while the service is stopped. Preserve the original database and its WAL/SHM files together in a separate recovery folder. Copy the chosen consistent snapshot to the mode's database path with correct owner (container UID 1000), start with operator pause, and reconcile against the broker. A restored snapshot can lack newer broker activity; that activity must block entries and be investigated. Never infer that restoring local state restores the brokerage account.

## Deployment update

Pause entries, verify pending intents and positions, back up, build the new image, and recreate the single container. Check reconciliation, feed states, and preserved pause before resuming. Pin configuration/model version during a research run. A configuration change starts a new experimental version; no live parameter optimizer is included.

## Live activation

Use live credentials only after paper order lifecycle checks (including partial fills and cancel races) and an account-specific review. Set:

```dotenv
MODE=live
EXPECTED_ACCOUNT_ID=YOUR_ACTUAL_ACCOUNT_ID
LIVE_ACK=I_ACCEPT_REAL_MONEY_RISK
# Equity-only first deployment:
CRYPTO_SYMBOLS=
```

For live crypto, restore your eligible crypto universe and set `LIVE_CRYPTO_ACK=I_ACCEPT_SOFTWARE_EXIT_OUTAGE_RISK`. Verify venue location and fee tier. Start with a small explicitly chosen capital/risk budget. The code does not certify your strategy or decide when your evidence is sufficient for deployment.

US margin rules are broker/account dependent during FINRA's 2026–2027 transition. This engine uses cash-based local capacity and the broker's returned restrictions; it does not implement a regulatory compliance engine or override broker risk controls.
