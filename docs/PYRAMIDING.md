# Controlled additions to winners — v1.12.0

Range breakout and failed breakout now have separate **Add to winners** switches. They default off, persist across restarts, and are restricted to paper/shadow/demo equities. Other strategies and real-money execution cannot use additions. Enabling applies to positions first opened with the addition policy enabled; legacy positions are not migrated. Turning it off cancels unfilled additions while protecting existing fills.

## Frozen first experiment

- One addition attempt per position, at most 25% of the original filled shares, rounded down to whole shares. Positions smaller than four shares cannot add.
- The original entry must be completely filled, reconciled, profitable after estimated costs, and up at least one original entry-to-stop distance (1R). Profit protection must already be armed. No partial exits, pending orders, ownership conflicts, or pending exit triggers are allowed.
- Require three contiguous completed minute bars after the original fill, forming a consolidation above the original entry with width no greater than one ATR. The next completed candle must break its high by at least 0.05 ATR, remain within one ATR of that high, close in its upper 35%, and meet both relative-volume and consolidation-volume multiples of 1.5. Short/medium-term trend checks must pass. Repeated alerts are insufficient. Failed-breakout positions use this same fresh continuation setup.
- Additions require at least 1.5:1 remaining reward/risk after estimated costs, using the original target. The total marked position must fit the existing per-position cap; cash, buying power, group exposure, gross exposure, daily loss, spread, quote freshness, cooldown, and session gates remain active. A position already near its notional cap often cannot add.
- The common software exit floor must retain at least half the observed peak net profit at the planned fill, and fit the original dollar-risk budget. Recalculate it as new fills and prices arrive; never lower it. All open positions' estimated stop giveback must fit the remaining daily-loss ceiling. No daily ceiling or allocation limits are increased.
- Additions never restart the holding clock or move the original target. A native lot exit or canceled partially filled entry triggers coordinated closure of the remaining campaign.
- Jev filter mode blocks additions until its continuation assessment is separately validated; additions do not silently bypass it.

These thresholds are a frozen hypothesis, not optimized results or a promise of profitability.

## Execution and accounting

Every buy retains its own immutable intent, broker ID, fill price, fees, and bracket. Ownership reconciles the sum of explicitly linked lots against the broker position. Unknown submissions are resolved by the original client ID, never blindly resubmitted. On a software exit, pending entries and all owned native exit orders are canceled and confirmed before bounded market exits, one lot at a time. Unrelated shares still produce an ownership conflict rather than becoming agent-owned.

The initial broker stop remains its original backstop; the tighter **combined-position floor is software managed**, not a native stop replacement. Network outages, gaps, slippage, and cancellation latency can exceed planned giveback or risk limits. Added shares have their own native bracket in Alpaca paper mode. Broker rejection preserves the original holding and consumes the single attempt. Paper broker behavior still needs forward execution calibration.

One combined position counts as one closed trade/win. Added-share net P/L is shown separately; a positive combined trade can conceal a losing addition. Version/date filters follow the original entry and include later additions. Added-share P/L alone is not the causal difference versus a no-addition strategy, because exits and portfolio capacity can also change.

## Paired executable-quote replay

Run the two arms with identical receipt-ordered quote/bar tapes, calendar, settings, latency, and displayed-size fill caps:

```powershell
npm run replay:pyramiding -- tape.json calendar.json comparison.json settings.json execution.json
```

`execution.json` can contain `{"latencyMs":1000,"participation":0.1,"addToWinners":["range_breakout","failed_breakout"]}`. Only include strategies enabled in `settings.json`. The baseline automatically disables additions. The output file must not already exist. Neither arm connects to the broker.

The report includes combined net P/L, added-share net, sampled daily drawdown, completed positions, unresolved exposure, and input/source hashes. Incremental realized net stays unavailable while either arm has open exposure, pending orders, execution exceptions, or a reconciliation failure. Synthetic tapes are labeled functional checks and every report remains ineligible for live trading.

For a prospective experiment, freeze this policy and use at least 20 unseen sessions with at least 100 eligible addition attempts, extending collection if necessary. Run baseline costs and a stress case with 2-second latency and 10 bps adverse slippage. Review incremental net, daily drawdown, concentration, fill/cancel failures, and per-strategy/day consistency before any broader rollout; sample counts alone do not qualify a strategy. Keep data selection and settings identical across both arms. Full-market scanner rotation, native bracket queue/race behavior, and market impact are not reproduced by the offline tape and require separate forward paper observations.

## Verification

Automated coverage includes defaults and migration, invalid/live toggles, distinct post-fill setups, quantity/capital/daily limits, partial fills and canceled remainders, restart recovery, uncertain submissions, native exits, per-lot closure, grouped win rates, and production-scanner paired synthetic replay. Browser verification uses a separate paused in-memory demo with no external broker connection. No unseen-market profitability claim follows from these checks.

The journal-preserving release workflow remains `scripts/finish-release.ps1`; it commits locally, builds the image, backs up the active journal, replaces port 8080, verifies the configured release and protection, and preserves the approved $2,000 daily ceiling. It does not enable the new switches or push to a remote.

Broker references: [Alpaca order lifecycle and bracket orders](https://docs.alpaca.markets/us/docs/orders-at-alpaca), [Alpaca order protections](https://docs.alpaca.markets/us/docs/user-protection).
