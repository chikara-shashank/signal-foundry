# Risk levels and the strategy scorecard

A strategy trades at the limits in `.env` until its own results earn more, and it
loses the extra size again as soon as the results stop holding. A drawdown brake
over the engine's own P/L halves trade size and then stops new entries. None of
this establishes an edge; it only refuses to scale one that has not shown up.

`RISK_LEVELS=off` (the default) changes nothing: every limit is the `.env` value.
`RISK_LEVELS=auto` is accepted in demo, shadow and paper modes only. In live mode
the engine refuses to start with it, because scaling real money is an operator's
decision.

## Levels

| Level | Earned when | Trade size and caps |
|---|---|---|
| 1 | Always | The `.env` limits |
| 2 | `RISK_LEVEL2_MIN_TRADES` (100) closed trades, net P/L after fees positive, positive in both the first and second half | `RISK_PER_TRADE_USD` and `MAX_POSITION_USD` × `RISK_LEVEL2_MULTIPLIER` (10) |
| 3 | `RISK_LEVEL3_MIN_TRADES` (300) closed trades, positive in each third, worst drawdown no larger than net profit | × `RISK_LEVEL3_MULTIPLIER` (50) |

- Evidence is per strategy and per **code version** (the manifest's `codeHash`).
  Changing limits or switching other strategies on and off does not reset it;
  deploying new strategy or engine code does.
- `RISK_LEVEL_MAX` (2) caps what can be earned. Level 3 needs `RISK_LEVEL_MAX=3`.
- Levels are re-evaluated every 30 seconds during reconciliation. Every change is
  journaled as a `risk_level_changed` event, and each entry order records the
  level, multiplier and brake state that sized it (`riskLevel`).
- A trade's size follows its own strategy's level. `MAX_GROSS_USD`,
  `MAX_GROUP_USD`, `CAPITAL_BUDGET_USD` and the daily loss ceiling scale with the
  highest level among the enabled strategies, so a promoted strategy has room.
  The saved daily loss ceiling stays the Level 1 value; the Operations tab shows
  the ceiling in effect.
- No single trade risks more than `RISK_MAX_ACCOUNT_RISK_PCT` (0.5%) of account
  equity, whatever the level.
- Fixed-notional strategies (noise-area, closing-strength carry) keep their own
  notional.

## Drawdown brake

The brake follows the engine's P/L: realized net after fees for every trade in
the journal, plus open P/L on managed positions. External holdings do not move
it. Drawdown is measured from the high-water mark, as a share of the capital
budget in force (`CAPITAL_BUDGET_USD` × the portfolio multiplier).

- At `RISK_BRAKE_HALVE_PCT` (5%) every trade is sized at half. This lifts again
  once the drawdown recovers below the threshold.
- At `RISK_BRAKE_HALT_PCT` (10%) new entries stop (`drawdown_brake`), like the
  daily loss halt. Exits and position management continue. The stop holds, even
  after a recovery and across restarts, until **Reset drawdown brake** on the
  Operations tab. The reset makes the current P/L the new high-water mark.

## Scorecard

`npm run scorecard` prints, per strategy, closed trades, win rate, net P/L after
fees, average per trade with its 95% range, average win and loss, fees as a share
of gross profit, the worst dip, both halves, and the level earned with what is
missing. Below that come results by entry hour and by symbol. It opens the
journal read-only, so it is safe beside a running engine:

```bash
docker compose exec engine node scripts/scorecard.js
docker compose exec engine node scripts/scorecard.js --version all --json
```

`--version latest` (the default) scores the code version that traded most
recently. `GET /api/scorecard` returns the same report for the running code,
with the level state.

A 95% range that includes zero means the trades so far show no edge. Paper fills
ignore queue position and market impact, which flatters strategies with small
targets. Judge them with a cost haircut before reading anything into a promotion.
