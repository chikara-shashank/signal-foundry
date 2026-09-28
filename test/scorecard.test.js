import test from 'node:test';
import assert from 'node:assert/strict';
import { t975, closedTradeStats, scorecardReport } from '../src/scorecard.js';
import { tradeScorecard } from '../src/research.js';
import { closedTrade } from './helpers.js';

const start = Date.parse('2026-09-22T14:00:00Z'); // 10:00 New York, closedTrade's default clock
const cfg = { equityFee: 1, cryptoFee: 25 };

test('t975 matches Student t tables', () => {
  for (const [df, value] of [[1, 12.706], [3, 3.182], [5, 2.571], [10, 2.228], [30, 2.042], [120, 1.980]]) assert.ok(Math.abs(t975(df) - value) < .005, `df ${df}: ${t975(df)}`);
  assert.equal(t975(0), null);
});

test('closed-trade stats: net, 95% range, halves, thirds, drawdown and cost share', () => {
  const rows = [2, -1, 3, -1].map((n, i) => ({ fullyClosed: true, estimatedNetPnl: n, grossPnl: n + .25, estimatedFees: .25, closedAt: i }));
  const s = closedTradeStats([...rows, { fullyClosed: false, estimatedNetPnl: 50, closedAt: 9 }]);
  assert.equal(s.closed, 4); assert.equal(s.wins, 2); assert.equal(s.net, 3); assert.equal(s.mean, .75);
  assert.deepEqual(s.halves, [1, 2]); assert.equal(s.maxDrawdown, 1);
  assert.equal(s.fees, 1); assert.equal(s.gross, 4); assert.equal(s.costShare, .25);
  // sd of [2,-1,3,-1] is sqrt(4.25); t(3) = 3.182
  const margin = 3.182 * Math.sqrt(4.25) / 2;
  assert.ok(Math.abs(s.ci95[0] - (.75 - margin)) < 1e-9 && Math.abs(s.ci95[1] - (.75 + margin)) < 1e-9);
  assert.deepEqual(closedTradeStats([]).halves, null); assert.equal(closedTradeStats([]).ci95, null);
  assert.equal(closedTradeStats(rows.map(r => ({ ...r, grossPnl: -1 }))).costShare, null);
});

test('the report reads the same accounting as the dashboard, scoped to one code version', () => {
  const orders = [closedTrade(0, { net: 2 }), closedTrade(1, { net: -1, symbol: 'QQQ' }), closedTrade(2, { net: 3 }),
    closedTrade(3, { net: -4, code: 'code-b' }), closedTrade(4, { net: 1, strategy: 'vwap_reversion', at: start + 3600000 })];
  assert.equal(tradeScorecard(orders, cfg).trades.filter(t => t.fullyClosed).length, 5);
  const all = scorecardReport(orders, cfg), a = scorecardReport(orders, cfg, { codeHash: 'code-a' });
  assert.equal(all.all.closed, 5); assert.equal(all.all.net, 1); assert.equal(all.realizedNetAll, 1);
  assert.deepEqual(all.versions.map(v => [v.codeHash, v.closed]), [['code-a', 4], ['code-b', 1]]);
  assert.equal(a.all.closed, 4); assert.equal(a.all.net, 5);
  assert.deepEqual(a.strategies.map(s => [s.strategy, s.closed, s.net]), [['range_breakout', 3, 4], ['vwap_reversion', 1, 1]]);
  assert.deepEqual(a.byHour.map(h => [h.key, h.closed, h.net]), [['10', 3, 4], ['11', 1, 1]]);
  assert.deepEqual(a.bySymbol.map(s => [s.key, s.net]), [['SPY', 6], ['QQQ', -1]]);
  // Code-b's loss still counts toward realized P/L for the drawdown brake.
  assert.equal(a.realizedNetAll, 1);
});
