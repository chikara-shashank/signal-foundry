> Archived diagnostic, not production qualification. See [the September 25 implementation audit](RESEARCH-AUDIT-2026-09-25.md) for corrected session validation, next-bar execution, separate signal/lot accounting and the new comparison. Original results below are preserved; some strategies used the close that generated the decision as their reference fill.

# Published intraday strategies · September 2026 tests

`scripts/intraday-research.js` tests four published intraday strategies on Alpaca SIP minute bars. It uses the rules and parameters stated in each paper and fits nothing to this data. Sessions, including early closes, come from Alpaca's trading calendar. Only regular-session bars are used.

```sh
node --env-file=.env scripts/intraday-research.js --study all --from 2016-01-04 --to 2026-09-23 --inplay-from 2024-09-23
```

## Rules tested

| Study | Source | Rule | Data |
|---|---|---|---|
| Last-half-hour momentum | Gao, Han, Li & Zhou (2018), *Market Intraday Momentum*, Journal of Financial Economics | At 15:30, trade in the direction of the first half-hour return (prior close to 10:00). Exit at the close. The "agree" variant trades only when the 15:00–15:30 return has the same sign. | SPY and QQQ, Jan 2016 – Sep 2026 |
| Noise-area breakout | Zarattini, Aziz & Barbon (2024), *Beat the Market* | The band is max/min(open, prior close) × (1 ± average absolute move from the open at that minute over the previous 14 sessions). Check at every :00 and :30 from 10:00. Go long above the band or short below it. Exit when price crosses max(upper band, VWAP) for longs or min(lower band, VWAP) for shorts, and at the close. | SPY and QQQ, Jan 2016 – Sep 2026 |
| 5-minute opening range breakout | Zarattini & Aziz (2023), *Can Day Trading Really Be Profitable?* | Trade in the direction of the 09:30–09:35 candle at the open of the next candle. The stop is the other end of that candle, the target is 10R, and otherwise exit at the close. Doji candles are skipped. | SPY and QQQ, Jan 2016 – Sep 2026 |
| Stocks-in-play opening range breakout | Zarattini, Barbon & Aziz (2024), *A Profitable Day Trading Strategy for the U.S. Equity Market* | Filter for open > $5, 14-day average volume ≥ 1M, 14-day ATR ≥ $0.50 and first-5-minute relative volume ≥ 100%, then take the top 20 by relative volume. Enter with a stop order at the 5-minute high (bullish candle) or low (bearish candle). The stop is 10% of the ATR and the exit is at the close. The daily result is an equal-weighted average across the day's trades. | The 100 most-traded US common stocks by dollar volume in the 20 sessions before the test, Sep 2024 – Sep 2026 |

Costs per side are half the quoted spread plus slippage plus fee:

- **engine**: the live configuration, 3 bps slippage and a 1 bps fee.
- **low**: commission-free execution of liquid names, 1 bps slippage and no fee.

Half-spreads come from the live engine's recorded quotes (SPY 0.13 bps, QQQ 0.14 bps). In-play names are assumed at 2 bps (engine) or 1 bps (low), since spreads are wider near the open. A limit target exit pays no slippage. The gross column is the result before any cost.

## Results

Net figures are bps per trade after costs. "After publication" keeps only trades after each paper appeared: 2019 (momentum), March 2023 (5-minute ORB) and June 2024 (noise area). Only that window is out-of-sample for the authors. Annual return is unlevered on one unit of notional.

| Study | Trades | Gross | Net, low cost (t) | Net, engine cost | After publication, low cost (t) |
|---|---|---|---|---|---|
| Momentum, SPY | 2,673 | −0.2 | −2.5 (−4.2) | −8.5 | −2.3 (−3.0) |
| Momentum, SPY, both half-hours agree | 1,360 | +0.5 | −1.8 (−1.9) | −7.8 | −1.7 (−1.4) |
| Momentum, QQQ | 2,687 | +0.2 | −2.1 (−3.1) | −8.1 | −2.4 (−2.7) |
| Momentum, QQQ, both half-hours agree | 1,391 | +1.0 | −1.3 (−1.3) | −7.3 | −1.8 (−1.3) |
| Noise area, SPY | 2,415 | +2.6 | +0.3 (0.3) | −5.7 | −1.8 (−1.0) |
| **Noise area, QQQ** | **2,370** | **+5.7** | **+3.4 (2.8)** | −2.6 | **+3.2 (1.0)**, 495 trades |
| 5-minute ORB, SPY | 2,651 | +0.8 | −1.5 (−1.7) | −7.4 | −2.2 (−2.0) |
| 5-minute ORB, QQQ | 2,662 | +2.8 | +0.5 (0.5) | −5.4 | −0.9 (−0.5) |
| Stocks in play, top 20 of 100 | 7,482 | −4.2 | −8.2 (−7.3) | −16.2 | whole test is after publication |
| Stocks in play, optimistic entry bar | 7,482 | +5.3 | +1.3 (1.0) | −6.7 | whole test is after publication |

**Last-half-hour momentum exists statistically but cannot be traded.** The regression slope is positive (SPY 0.017, t = 2.1; QQQ 0.027, t = 3.6), but it explains under 0.5% of the variance. The timing strategy earns about 0 bps gross, and nothing improved after 2019.

**The 5-minute ORB does not reproduce.** The mean R is 0.006 on QQQ and −0.16 on SPY at low cost, which is flat or negative. Leverage cannot turn a zero-mean R into a profit.

**Stocks-in-play ORB fails on large caps.** A 1-minute bar cannot tell whether the tight stop (10% of ATR) was hit before or after the entry. The true result lies between the conservative row (−8.2 bps) and the optimistic row (+1.3 bps, t = 1.0), so no edge is shown. The paper ranks the whole US market, where the top 20 by relative volume are mostly news-driven small and mid caps. This test used the 100 most liquid names, so it is not a complete replication.

**The QQQ noise-area breakout is the only positive result.** It holds up in several ways:
- Gross +5.7 bps per trade over 10.7 years.
- Both directions are profitable: longs +4.2 bps and shorts +2.6 bps net at low cost. The result is not just market exposure.
- Positive in 9 of 11 years at low cost. The only losing years were 2016 (−283 bps) and 2019 (−54 bps), and gains are largest in volatile years (2018, 2022–2024).
- About 7.6% a year unlevered, Sharpe 0.88, maximum drawdown −11%.
- After publication: +3.2 bps per trade over 495 trades. That is consistent with the full sample but not significant on its own.

Its margin is thin:
- It breaks even at about 5.7 bps of round-trip cost. It loses under the engine's assumptions (8.3 bps) in 10 of 11 years.
- About ten configurations were tested. A t of 2.8 is roughly at a multiple-testing-adjusted 5% level, not beyond it.
- On SPY, a similar instrument, the same rules earn only +2.6 bps gross.

## What this means for the engine

Live-fill cost on QQQ is the deciding unknown. Measure it in paper before building anything larger. The engine's 3 bps-per-side slippage assumption has not been measured on QQQ, whose median quoted spread is 0.27 bps.

Two current settings block QQQ:
- The `shared` account policy reserves QQQ because of the external QQQ option position.
- One share (about $740) exceeds `MAX_POSITION_USD=500`.

The noise-area rules also do not fit the engine's current bracket-order strategies. They need half-hourly decisions, a trailing VWAP stop managed in software, and a flat position at the close.

## Limitations

- The noise-area stop is checked at the half-hour marks, the same as entries. The paper's exact stop cadence may differ.
- The volatility-targeted leverage used in the paper is not applied.
- The universe is today's active assets, which carries mild survivorship bias for the in-play study.
- Borrow cost for shorts is not modeled.
- Spreads for in-play names are assumed, not measured.

