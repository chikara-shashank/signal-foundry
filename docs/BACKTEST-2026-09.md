# Walk-forward backtest · September 2026

`scripts/backtest.js` replays Alpaca historical bars through the production `Features` and `assess()` code. It applies the live entry gates: shock regime, open session with at least 10 minutes left, spread cap, 30 bps price-moved check, and a reward that must clear twice the round-trip cost. It also applies one position per symbol and strategy, and the per-symbol cooldown. Each strategy and side is tested with 20 exit variants (16 for crypto): holding times of 15, 30, 60 or 120 minutes or to the session end, crossed with the production target, 1R, 3R or no target.

```sh
node --env-file=.env scripts/backtest.js --from 2026-03-23 --to 2026-09-23 --split 2026-07-23 \
  --quotes data/paper.sqlite --out data/research/backtest-2026-09-23.json
```

Bars are cached in `data/history/` (split-adjusted SIP 1-minute bars for equities, 5-minute bars for crypto). Costs match the engine configuration: 3 bps slippage per side, a 1 bps equity fee or 25 bps crypto fee per side, and half the median quoted spread recorded for each symbol by the live engine. Each variant is chosen on the in-sample period (Mar 23 – Jul 22). The untouched out-of-sample period (Jul 23 – Sep 22) is the evidence.

## Results

Universe: SPY, QQQ, AAPL, MSFT, NVDA, AMD, AMZN, META, GOOGL, TSLA, PLTR, NKE, LULU, BTC/USD and ETH/USD. That is about 1.5 million bars.

| Equity strategy, production settings (long, 60 min, production target) | OOS trades | OOS net bps/trade | t | Gross bps | Random entry gross, same hold |
|---|---|---|---|---|---|
| range_breakout | 1,888 | −9.4 | −9.8 | 0.3 | 1.9 |
| trend_pullback | 2,202 | −9.3 | −10.9 | 0.2 | 1.9 |
| failed_breakout | 1,679 | −7.4 | −8.1 | 2.2 | 1.9 |
| vwap_reversion | 753 | −7.4 | −5.5 | 1.4 | 1.9 |
| volatility_expansion | 2 | −44.5 | – | −30.6 | 1.9 |

- **No strategy has predictive value.** Gross returns per trade are within about 2 bps of random entries at the same holding time, and random entries only earn the period's upward drift. Lower costs therefore cannot make these rules profitable.
- **Exit tuning does not help.** The best in-sample variant for every strategy and side still lost 7–16 bps per trade out-of-sample.
- **Mirrored short rules lose more** (−11 to −16 bps out-of-sample). Adding short execution to the engine is not justified by this evidence.
- **Crypto loses at every horizon.** Fees of 25 bps per side mean −30 to −80 bps per trade. Only the one-day hold of random entries approaches break-even, and that comes from the price trend, not from a signal.
- **Volatility expansion is too rare to measure:** 22 trades in six months.

Strategies that met the promotion rule (in-sample and out-of-sample mean net > 0, out-of-sample n ≥ 20, pooled t ≥ 2): **none**.

## Configuration applied

The paper deployment keeps the five equity bar strategies running to collect Jev shadow outcomes. Jev's value can only be measured forward. The configuration removes crypto and the quote-triggered order-flow strategy. The live replay found order-flow indistinguishable from random entries at its 3-minute hold (420 signals, −10.5 bps net versus −11.0 bps for random entries). Expect small paper losses; this deployment exists to collect evidence, not profit.

## Limitations

- 1-minute bars hide the order of events within a bar, so when both the stop and the target are touched, the stop is assumed first.
- Entries fill at the next bar's open plus costs. There is no queue or market-impact model.
- The short variants do not model borrow availability or fees.
- Six months covers only one market regime. The harness accepts any `--from/--to` range that the data subscription covers.
