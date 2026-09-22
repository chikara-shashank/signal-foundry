import test from 'node:test';
import assert from 'node:assert/strict';
import { Microstructure, relativeValue } from '../src/microstructure.js';
import { evaluate } from '../src/strategies.js';
import { fixture, quote } from './helpers.js';

test('best-quote imbalance and OFI have correct signs and stale books expire', () => {
  const book = new Microstructure();
  const q = { symbol: 'SPY', ts: 1000, bid: 100, ask: 100.02, bidSize: 100, askSize: 100 };
  book.add(q); const x = book.add({ ...q, ts: 1100, bidSize: 200, askSize: 50 });
  assert.equal(x.imbalance, .6); assert.ok(x.normalizedOfi > 0); assert.ok(x.microprice > x.mid);
  assert.equal(book.snapshot('SPY', 2200), null);
  assert.equal(book.add({ ...q, ts: 2300, bidSize: undefined }), null);
  const reset = book.add({ ...q, ts: 10000 }); assert.equal(reset.observations, 1);
});

test('order-flow setup requires adequate history, freshness, and supportive trend', () => {
  const f = { symbol: 'SPY', version: 10, bar: { close: 100, volume: 100 }, atr: .5, ema9: 101, ema21: 100, trend5: .01, trend15: .01, relativeVolume: 1,
    micro: { ts: 10000, observations: 30, spanMs: 2000, imbalance: .5, normalizedOfi: 3, micropriceSkewBps: 1, returnBps: 2, mid: 102 } };
  const c = evaluate('order_flow_continuation', f, 10000); assert.ok(c); assert.equal(c.reference, 102); assert.equal(c.maxHold, 180000);
  assert.equal(evaluate('order_flow_continuation', f, 12000), null);
  assert.equal(evaluate('order_flow_continuation', { ...f, micro: { ...f.micro, observations: 2 } }, 10000), null);
});

test('relative-value fit excludes the current price from its training window', () => {
  const a = [], b = [], start = 600000;
  for (let i = 0; i < 61; i++) {
    const x = 100 * Math.exp(.001 * i), y = Math.exp(.4 + 1.1 * Math.log(x) + .002 * Math.sin(i));
    a.push({ symbol: 'SPY', ts: start + i * 60000, close: y }); b.push({ symbol: 'QQQ', ts: start + i * 60000, close: x });
  }
  const first = relativeValue(a, b); const changed = structuredClone(a); changed.at(-1).close *= 1.1; const second = relativeValue(changed, b);
  assert.equal(first.beta, second.beta); assert.ok(second.zscore > first.zscore); assert.ok(first.trainingEndsAt < first.ts);
  assert.equal(relativeValue(a.slice(1), b), null);
});

test('quote-triggered scan can create a candidate between bars', async () => {
  const f = await fixture({ SYMBOL_COOLDOWN_SECONDS: '0', STRATEGIES: 'order_flow_continuation' });
  try {
    let seen = 0;
    f.engine.workers = { status: () => [{ strategy: 'order_flow_continuation', alive: true }], evaluate: async (_, __, names) => { assert.deepEqual(names, ['order_flow_continuation']); seen++; return []; } };
    f.engine.snapshots.set('SPY', { version: f.now() - 60000, bar: { ts: f.now() - 60000 } });
    await f.engine.onQuote({ ...quote('SPY', f.now()), bidSize: 100, askSize: 50 });
    assert.equal(seen, 1); await f.engine.onQuote({ ...quote('SPY', f.now() + 10), bidSize: 101, askSize: 50 }); assert.equal(seen, 1);
  } finally { f.store.close(); }
});

test('quant regime rules distinguish reversion and volatility expansion', () => {
  const base = { symbol: 'SPY', version: 1, bar: { close: 100, open: 99, low: 98, high: 101, volume: 100 }, previous: { close: 99, low: 98 }, atr: 1, ema9: 100, ema21: 100, trend5: .01, trend15: .001, relativeVolume: 2, rangeHigh: 99.5, rollingVwap: 103, regime: 'range', vwapZ: -2 };
  assert.equal(evaluate('vwap_reversion', base, 100).target, 103);
  assert.ok(evaluate('volatility_expansion', { ...base, priorCompression: .6, volatilityRatio: 1.5 }, 100));
  assert.equal(evaluate('volatility_expansion', { ...base, priorCompression: .6, volatilityRatio: 3 }, 100), null);
});
