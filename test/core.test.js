import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testConfig, candidate, quote } from './helpers.js';
import { Features, aggregate } from '../src/features.js';
import { evaluate } from '../src/strategies.js';
import { sizeEntry } from '../src/risk.js';
import { Store } from '../src/store.js';
import { validateQuote, validBar } from '../src/util.js';
import { Workers } from '../src/workers.js';

test('configuration requires explicit live account and crypto acknowledgments', () => {
  assert.throws(() => testConfig({ MODE: 'live', ALPACA_KEY: 'k', ALPACA_SECRET: 's' }), /Live mode/);
  assert.throws(() => testConfig({ MODE: 'live', ALPACA_KEY: 'k', ALPACA_SECRET: 's', LIVE_ACK: 'I_ACCEPT_REAL_MONEY_RISK', EXPECTED_ACCOUNT_ID: 'a', CRYPTO_SYMBOLS: 'BTC/USD' }), /crypto requires/);
  assert.throws(() => testConfig({ MAX_POSITION_USD: 'NaN' }), /Invalid/);
  assert.throws(() => testConfig({ MAX_GROSS_USD: '10001' }), /allocation/);
  assert.throws(() => testConfig({ EQUITY_SYMBOLS: 'SPY<script>' }), /symbol/);
});

test('quote validation rejects future, stale, crossed and nonfinite prices', () => {
  const now = 10000, q = quote('SPY', now);
  assert.ok(validateQuote(q, now, 5000));
  for (const patch of [{ ts: 1 }, { ts: 20000 }, { bid: 101 }, { ask: NaN }, { bid: 0 }]) assert.equal(validateQuote({ ...q, ...patch }, now, 5000), false);
});

test('position count is unlimited by default, accepts an optional integer cap and rejects invalid values', () => {
  assert.equal(testConfig().maxPositions, 0);
  assert.equal(testConfig({ MAX_POSITIONS: '0' }).maxPositions, 0);
  assert.equal(testConfig({ MAX_POSITIONS: '4' }).maxPositions, 4);
  for (const value of ['-1', '1.5', 'NaN', 'Infinity', '51']) assert.throws(() => testConfig({ MAX_POSITIONS: value }));
});

test('unlimited position count still enforces pending reservations, dollar capacity and symbol exclusivity', () => {
  const cfg = testConfig({ MAX_POSITIONS: '0' }), now = 100000;
  const held = ['QQQ', 'AAPL', 'NVDA'].map(symbol => ({ symbol, marketValue: 100 }));
  const pending = ['MSFT', 'AMD'].map(symbol => ({ symbol, kind: 'entry', reserved: 100 }));
  const account = { ts: now, equity: 10000, cash: 10000, buyingPower: 10000 };
  const run = (positions = held, orders = pending, funds = account, limits = cfg) => sizeEntry(candidate('SPY', now), quote('SPY', now), funds, positions, orders, limits, { tradable: true }, now, { open: true, ts: now, close: now + 3600000 });
  assert.equal(run().ok, true); // Five existing allocations do not impose a count cap.
  assert.equal(run(held, pending, account, { ...cfg, maxPositions: 4 }).reason, 'position_limit');
  assert.equal(run([...held, { symbol: 'SPY', marketValue: 100 }]).reason, 'symbol_already_allocated');
  assert.equal(run(held, [...pending, { symbol: 'SPY', kind: 'entry', reserved: 100 }]).reason, 'symbol_already_allocated');
  for (const reserved of [1200, 1700]) {
    assert.equal(run(held, [{ symbol: 'MSFT', kind: 'entry', reserved }]).reason, 'insufficient_capacity_or_lot_size');
  }
  assert.equal(run(held, pending, { ...account, cash: 200 }).reason, 'insufficient_capacity_or_lot_size');
});

test('features exclude incomplete bars and reset on time gaps', () => {
  const f = new Features(), start = Date.parse('2026-09-22T14:00:00Z'); let last;
  for (let i = 0; i < 60; i++) {
    const b = { symbol: 'SPY', ts: start + i * 60000, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: 100 };
    assert.equal(f.add(b, b.ts), null);
    last = f.add(b, b.ts + 60000);
  }
  assert.equal(last.count, 60); assert.ok(last.trend15 > 0);
  assert.equal(last.rangeHigh, 160); // Excludes current high=161.
  const gap = { symbol: 'SPY', ts: start + 62 * 60000, open: 1, high: 2, low: 1, close: 2, volume: 10 };
  assert.equal(f.add(gap, gap.ts + 60000), null); assert.equal(f.history.get('SPY').length, 1);
  assert.equal(aggregate([{ ...gap, ts: start }], 5).length, 0);
  assert.equal(validBar({ ...gap, low: 3 }), false);
});

const setup = () => ({ symbol: 'SPY', version: 1, bar: { ts: 1, open: 99, high: 102, low: 98, close: 101, volume: 200 }, previous: { low: 99, close: 100 }, atr: 1, ema9: 100, ema21: 99, previousEma9: 100, rangeHigh: 100.5, rangeLow: 98.5, relativeVolume: 2, rollingVwap: 99, trend5: .01, trend15: .01 });
test('three strategies yield defined long setups and reject missing context', () => {
  for (const strategy of ['range_breakout', 'trend_pullback', 'failed_breakout']) {
    const c = evaluate(strategy, setup(), 1000); assert.ok(c); assert.ok(c.stop < c.reference && c.target > c.reference);
    assert.equal(evaluate(strategy, { ...setup(), trend15: null }, 1000), null);
  }
});

test('six worker threads evaluate an immutable shared snapshot', async () => {
  const workers = new Workers();
  try { const f = setup(); const before = JSON.stringify(f); const results = await workers.evaluate(f, 1000); assert.equal(workers.status().length, 6); assert.equal(results.length, 3); assert.equal(JSON.stringify(f), before); }
  finally { await workers.close(); }
});

test('risk sizing respects reservations, cash, lots, costs and sessions', () => {
  const cfg = testConfig(), now = 100000, c = candidate('SPY', now), q = quote('SPY', now), a = { ts: now, equity: 10000, cash: 10000, buyingPower: 10000 }, asset = { tradable: true }, session = { open: true, ts: now, close: now + 3600000 };
  const run = (positions = [], pending = [], acc = a, cand = c, ses = session) => sizeEntry(cand, q, acc, positions, pending, cfg, asset, now, ses);
  const result = run(); assert.ok(result.ok); assert.ok(result.reserved <= cfg.maxPosition); assert.ok(result.riskAtStop <= cfg.risk); assert.ok(Number.isInteger(result.qty));
  assert.equal(run([], [{ symbol: 'SPY', kind: 'entry', reserved: 10 }]).reason, 'symbol_already_allocated');
  assert.equal(run([], [{ symbol: 'QQQ', kind: 'entry', reserved: 1900 }]).ok, false);
  assert.equal(run([], [], { ...a, cash: 50 }).ok, false);
  assert.equal(run([], [], a, { ...c, target: 100.03 }).ok, false);
  assert.equal(run([], [], a, c, { ...session, open: false }).reason, 'equity_session_closed');
});

test('durable budget reservation is atomic and unknown costs stay reserved', () => {
  const s = new Store();
  try { assert.equal(s.reserveCost('1', '2026-09', .6, 1, 1), true); assert.equal(s.reserveCost('2', '2026-09', .6, 1, 1), false); assert.equal(s.spend('2026-09'), .6); s.settleCost('1', .2); assert.equal(s.reserveCost('2', '2026-09', .6, 1, 1), true); }
  finally { s.close(); }
});

test('two engines cannot own the same SQLite journal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-lease-')), a = new Store(join(dir, 'test.sqlite')), b = new Store(join(dir, 'test.sqlite'));
  try { a.lease(100); assert.throws(() => b.lease(101), /Another engine/); a.release(); b.lease(102); assert.throws(() => a.lease(103), /lease lost/); }
  finally { a.close(); b.close(); rmSync(dir, { recursive: true }); }
});
