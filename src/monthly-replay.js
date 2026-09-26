import { monthlyTrendContext } from './monthly-trend.js';

// Normalized, unlevered total-return proxy. It is not the bracketed paper engine.
// Adjusted shares are synthetic units; raw prices are used only for lot diagnostics.
export function replayMonthly({ adjusted, raw, calendar, from, to, model, costBps = 4, delaySessions = 0 }) {
  const cache = new Map(), rawByDate = new Map(raw.map(b => [b.date,b]));
  const rows = adjusted.filter(b => b.date >= from && b.date < to);
  if (!rows.length) throw new Error('monthly_replay_empty');
  let cash = 10000, units = 0, peak = 10000, drawdown = 0, entryCost = 0, sides = 0, daysLong = 0, previous = 10000;
  const trades = [], returns = [], equity = [], queue = [], feasible = { signals: 0, fundedAtExistingCaps: 0, noWholeShare: 0 };
  for (let i = 0; i < rows.length; i++) {
    const b = rows[i], month = b.date.slice(0,7);
    if (!cache.has(month)) cache.set(month, monthlyTrendContext(adjusted, calendar, b.date, model === 'buy_hold' ? 'sma10' : model));
    const context = cache.get(month);
    if (context.reason) throw new Error('monthly_replay_' + context.reason);
    queue.push(model === 'buy_hold' || context.long);
    const target = i >= delaySessions ? queue[i - delaySessions] : false, cost = costBps / 10000;
    if (!target && units) {
      const proceeds = units * b.open * (1 - cost); cash += proceeds; trades.push(proceeds / entryCost - 1); units = 0; sides++;
    } else if (target && !units) {
      const price = rawByDate.get(b.date)?.open;
      if (!(price > 0)) throw new Error('monthly_replay_raw_missing');
      feasible.signals++;
      // Original caps: min($500 position, $350 overnight position, $10 at a 2% stop + costs).
      const qty = Math.floor(Math.min(350 / (price * (1 + cost)), 10 / (price * (.02 + 2 * cost))));
      if (qty > 0) feasible.fundedAtExistingCaps++; else feasible.noWholeShare++;
      entryCost = cash; units = cash / (b.open * (1 + cost)); cash = 0; sides++;
    }
    if (units) daysLong++;
    // Liquidate final mark to make costs comparable across hypotheses and benchmarks.
    if (i === rows.length - 1 && units) { cash += units * b.close * (1 - cost); trades.push(cash / entryCost - 1); units = 0; sides++; }
    const value = cash + units * b.close;
    peak = Math.max(peak,value); drawdown = Math.max(drawdown,1-value/peak);
    returns.push(value/previous-1); equity.push({date:b.date,value}); previous = value;
  }
  const mean = returns.reduce((s,x)=>s+x,0)/returns.length, sd = Math.sqrt(returns.reduce((s,x)=>s+(x-mean)**2,0)/(returns.length-1));
  const years = (Date.parse(rows.at(-1).date)-Date.parse(rows[0].date))/86400000/365.25;
  return { first:rows[0].date,last:rows.at(-1).date,days:rows.length,netReturnPct:100*(previous/10000-1),cagrPct:100*((previous/10000)**(1/years)-1),
    dailyCloseMaxDrawdownPct:drawdown*100,zeroRateSharpe:sd?mean/sd*Math.sqrt(252):null,exposurePct:100*daysLong/rows.length,
    roundTrips:trades.length,winRate:trades.length?trades.filter(x=>x>0).length/trades.length:null,transactionSides:sides,lotFeasibilityOnly:feasible,
    initial950DollarSleeveIllustrationPnl:(previous-10000)*.095, equity };
}
