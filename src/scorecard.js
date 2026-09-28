import { tradeScorecard } from './research.js';

// THE EVIDENCE PER STRATEGY: what its closed trades earned after costs, how sure
// that is, and whether it held up over time. tradeScorecard owns the per-trade
// accounting (fills, partial exits, fee rates); this only summarises it, so the
// dashboard's realized net and these numbers cannot disagree.

const hourFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' });
const sum = xs => xs.reduce((a, b) => a + b, 0);

// Two-sided 95% Student t quantile. Table values for tiny samples, then the
// Cornish-Fisher expansion (within 0.1% of tables from df 5).
export function t975(df) {
  if (!(df >= 1)) return null;
  const table = [12.706, 4.303, 3.182, 2.776];
  if (df <= 4) return table[Math.floor(df) - 1];
  const z = 1.959964, z3 = z ** 3, z5 = z ** 5, z7 = z ** 7;
  return z + (z3 + z) / (4 * df) + (5 * z5 + 16 * z3 + 3 * z) / (96 * df ** 2) + (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df ** 3);
}

// Net P/L of consecutive equal slices, oldest first: [first half, second half] or thirds.
const slices = (net, k) => net.length >= k ? Array.from({ length: k }, (_, i) => sum(net.slice(Math.floor(i * net.length / k), Math.floor((i + 1) * net.length / k)))) : null;

// Summary of fully closed trades in the order they closed.
export function closedTradeStats(trades) {
  const closed = trades.filter(t => t.fullyClosed && Number.isFinite(t.estimatedNetPnl)).sort((a, b) => (a.closedAt ?? a.entryAt ?? 0) - (b.closedAt ?? b.entryAt ?? 0));
  const net = closed.map(t => t.estimatedNetPnl), n = net.length, total = sum(net), mean = n ? total / n : null;
  const sd = n > 1 ? Math.sqrt(net.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : null;
  const margin = sd === null ? null : t975(n - 1) * sd / Math.sqrt(n);
  const wins = net.filter(x => x > 0), losses = net.filter(x => x < 0);
  const gross = sum(closed.map(t => t.grossPnl ?? 0)), fees = sum(closed.map(t => t.estimatedFees ?? 0));
  let run = 0, peak = 0, maxDrawdown = 0;
  for (const x of net) { run += x; peak = Math.max(peak, run); maxDrawdown = Math.max(maxDrawdown, peak - run); }
  return { closed: n, wins: wins.length, winRate: n ? wins.length / n : null, net: total, mean, sd,
    ci95: margin === null ? null : [mean - margin, mean + margin],
    averageWin: wins.length ? sum(wins) / wins.length : null, averageLoss: losses.length ? sum(losses) / losses.length : null,
    gross, fees, costShare: gross > 0 ? fees / gross : null, maxDrawdown, halves: slices(net, 2), thirds: slices(net, 3),
    firstClosedAt: closed[0]?.closedAt ?? null, lastClosedAt: closed.at(-1)?.closedAt ?? null };
}

const breakdown = (trades, keyOf) => {
  const groups = new Map();
  for (const t of trades.filter(t => t.fullyClosed && Number.isFinite(t.estimatedNetPnl))) {
    const key = keyOf(t), g = groups.get(key) ?? { key, closed: 0, wins: 0, net: 0 };
    g.closed++; g.wins += t.estimatedNetPnl > 0 ? 1 : 0; g.net += t.estimatedNetPnl; groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.net - a.net);
};

// The code version each trade was placed under. The experiment id also moves
// with limits and with which strategies are switched on, so evidence follows
// the code (codeHash), which changes only when the strategy code does.
export const codeVersionOf = orders => new Map(orders.filter(o => o.kind === 'entry').map(o => [o.id, o.experiment?.codeHash ?? 'legacy']));

export function scorecardReport(orders, cfg, { codeHash = null, now = Date.now() } = {}) {
  const { trades, exceptions } = tradeScorecard(orders, cfg), versionOf = codeVersionOf(orders);
  const scoped = codeHash ? trades.filter(t => versionOf.get(t.entryId) === codeHash) : trades;
  const versions = new Map();
  for (const t of trades) {
    const id = versionOf.get(t.entryId) ?? 'legacy', v = versions.get(id) ?? { codeHash: id, trades: 0, closed: 0, lastEntryAt: 0 };
    v.trades++; v.closed += t.fullyClosed ? 1 : 0; v.lastEntryAt = Math.max(v.lastEntryAt, t.entryAt ?? 0); versions.set(id, v);
  }
  const ids = [...new Set(scoped.map(t => t.strategy ?? 'unknown'))].sort();
  return {
    generatedAt: now, codeHash,
    versions: [...versions.values()].sort((a, b) => b.lastEntryAt - a.lastEntryAt),
    all: closedTradeStats(scoped),
    strategies: ids.map(id => ({ strategy: id, exceptions: exceptions.filter(x => x.strategy === id).length, ...closedTradeStats(scoped.filter(t => (t.strategy ?? 'unknown') === id)) })),
    byHour: breakdown(scoped, t => Number.isFinite(t.entryAt) ? hourFormat.format(t.entryAt) : 'unknown'),
    bySymbol: breakdown(scoped, t => t.symbol),
    // Everything realized since the journal began, every version: the drawdown brake's P/L.
    realizedNetAll: sum(trades.map(t => Number.isFinite(t.estimatedNetPnl) ? t.estimatedNetPnl : 0)),
    exceptions: exceptions.length,
    note: 'Closed trades after recorded or estimated fees, paper fills. The 95% range is for the average net P/L per trade; a range that includes zero shows no edge yet. Paper fills ignore queue position and market impact.'
  };
}
