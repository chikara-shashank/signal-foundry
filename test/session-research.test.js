import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionContext, noiseSignal, vwapSignal } from '../src/session-signals.js';
import { completeSession, replaySession, sessionStatistics } from '../src/session-replay.js';
import { VwapTrend } from '../src/vwap-trend.js';

const open = Date.parse('2026-09-22T13:30Z'), day = { date: '2026-09-22', open, close: open + 60 * 60000 };
const bars = Array.from({ length: 60 }, (_, i) => ({ symbol: 'QQQ', ts: open + i * 60000, open: 100 + i * .01,
  high: 100.02 + i * .01, low: 99.99 + i * .01, close: 100.01 + i * .01, volume: 1000 }));

test('noise entries enforce the same VWAP line that would immediately request an exit', () => {
  const context = { price: 101, vwap: 102, dayOpen: 100, prevClose: 100, sigma: .005 };
  assert.equal(noiseSignal(context).action, 'hold_flat');
  assert.equal(noiseSignal(context, true).action, 'exit_long');
  assert.equal(noiseSignal({ ...context, price: 103 }).action, 'enter_long');
  assert.equal(noiseSignal({ ...context, sigma: NaN }), null);
});

test('session VWAP excludes future bars and rejects missing or duplicate minute history', () => {
  const context = sessionContext(bars, open, open + 30 * 60000);
  const changed = structuredClone(bars); changed[30].close = 1000000;
  assert.deepEqual(sessionContext(changed, open, open + 30 * 60000), context);
  assert.equal(sessionContext(bars.slice(1), open, open + 30 * 60000), null);
  assert.equal(sessionContext([...bars, bars[4]], open, open + 30 * 60000), null);
  assert.equal(vwapSignal(context), 'enter_long');
  assert.equal(vwapSignal({ price: 100, vwap: 100 }), 'hold_flat');
});

test('replay fills after the signal, respects early close, integer lots and four-way cost sensitivity', () => {
  const free = replaySession(day, bars, [], 'vwap_trend', { slipBps: 0, feeBps: 0, halfSpreadBps: 0 }).trades;
  assert.equal(free.length, 1); assert.equal(free[0].entryMinute, 1); assert.equal(free[0].decisionMinute, 1);
  assert.equal(free[0].entry, bars[1].open); assert.equal(free[0].exitMinute, 55);
  assert.equal(free[0].quantity, 4);
  const paid = replaySession(day, bars, [], 'vwap_trend').trades[0]; assert.ok(paid.netPnl < free[0].netPnl);
  const delayed = replaySession(day, bars, [], 'vwap_trend', { delayMinutes: 1 }).trades[0]; assert.equal(delayed.entryMinute, 2);
  const zero = replaySession(day, bars, [], 'vwap_trend', { maxPosition: 50 }).trades;
  assert.equal(zero[0].quantity, 0); assert.equal(zero[0].netPnl, 0);
  const stats = sessionStatistics(zero, [day.date]); assert.equal(stats.trades, 0); assert.equal(stats.winRate, null); assert.equal(stats.zeroLotSignals, 1);
});

test('ambiguous bars take the stop first; gaps cannot receive the stale stop price', () => {
  const changed = structuredClone(bars); Object.assign(changed[2], { open: 97, low: 96, high: 107 });
  const result = replaySession(day, changed, [], 'vwap_trend', { slipBps: 0, feeBps: 0, halfSpreadBps: 0 });
  assert.equal(result.trades[0].reason, 'stop'); assert.equal(result.trades[0].exit, 97);
  assert.equal(completeSession(day, changed.slice(1)), false);
});

test('replay decisions before a changed future remain identical', () => {
  const before = replaySession(day, bars, [], 'vwap_trend').trades[0];
  const changed = structuredClone(bars); for (const b of changed.slice(20)) { b.open *= .99; b.high *= .99; b.low *= .99; b.close *= .99; }
  const after = replaySession(day, changed, [], 'vwap_trend').trades[0];
  assert.equal(before.entryMinute, after.entryMinute); assert.equal(before.entry, after.entry); assert.equal(before.quantity, after.quantity);
});

test('production VWAP handler restores the session, follows shared rules and exits while disabled', async () => {
  let now = open + 30 * 60000 + 500, enabled = true, reads = 0, reconciles = 0;
  const candidates = [], engine = { cfg: { mode: 'shadow', noiseSymbol: 'QQQ' }, clock: () => now, managed: {}, pending: () => [],
    schedule: { state: () => ({ today: day }) }, strategyControls: { enabled: () => enabled, state: { strategies: { vwap_trend: { changedAt: 0 } } } },
    store: { set() {}, event() {} }, mutex: { run: fn => fn() }, observability: { evaluation() {} },
    submitCandidate: async c => candidates.push(c), scheduleReconcile: () => reconciles++ };
  const handler = new VwapTrend(engine, { bars: async () => { reads++; return new Map([['QQQ', bars.slice(0, 30)]]); } });
  await handler.onBar(bars[29]); assert.equal(reads, 1); assert.equal(candidates.length, 1);
  await handler.onBar(bars[29]); assert.equal(candidates.length, 1);
  enabled = false; engine.managed.QQQ = { strategy: 'vwap_trend' }; now += 60000;
  const falling = { ...bars[30], open: 99, high: 100, low: 98, close: 99 };
  await handler.onBar(falling); assert.equal(engine.managed.QQQ.exitReason, 'vwap_trailing_stop'); assert.equal(reconciles, 1);
  assert.equal(candidates.length, 1);
});
