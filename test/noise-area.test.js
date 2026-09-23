import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { SimBroker } from '../src/broker.js';
import { Engine } from '../src/engine.js';
import { NoiseArea } from '../src/noise-area.js';
import { sizeEntry } from '../src/risk.js';
import { inlineWorkers, testConfig } from './helpers.js';

const DAY = Date.parse('2026-09-22T00:00:00Z'), OPEN = DAY + 13.5 * 3600000, CLOSE = DAY + 20 * 3600000, MIN = 60000;
const noiseConfig = (extra = {}) => testConfig({ MODE: 'shadow', ALPACA_KEY: 'k', ALPACA_SECRET: 's', STRATEGIES: 'noise_area', MAX_GROSS_USD: '3000', MAX_GROUP_USD: '3000', ...extra });
// Weekday sessions from Aug 31 to Sep 22 2026 (Labor Day closed), 09:30-16:00 New York.
function sessions({ earlyToday = false } = {}) {
  const out = [];
  for (let d = Date.parse('2026-08-31T00:00:00Z'); d <= DAY; d += 86400000) {
    const date = new Date(d).toISOString().slice(0, 10), day = new Date(d).getUTCDay();
    if (day === 0 || day === 6 || date === '2026-09-07') continue;
    out.push({ date, open: d + 13.5 * 3600000, close: d === DAY && earlyToday ? d + 17 * 3600000 : d + 20 * 3600000 });
  }
  return out;
}
// Prior sessions move exactly 0.2% from their open at every half hour and close at 100.
function priorBars(list) {
  return list.slice(0, -1).flatMap(s => [{ symbol: 'QQQ', ts: s.open - 30 * MIN, open: 90, high: 90, low: 90, close: 90, volume: 1 }, // Pre-market bar is ignored.
    ...Array.from({ length: 13 }, (_, i) => { const close = i === 12 ? 100 : 100 * (1 + (i % 2 ? .002 : -.002)); return { symbol: 'QQQ', ts: s.open + i * 30 * MIN, open: 100, high: Math.max(100, close), low: Math.min(100, close), close, volume: 1000 }; })]);
}
// Today: up 0.02 per minute to 100.60 by 10:00, then down to 100.10 by 10:30, then flat.
const price = i => i <= 30 ? 100 + .02 * i : i <= 60 ? 100.6 - (i - 30) * .5 / 30 : 100.1;
const minuteBar = i => ({ kind: 'bar', symbol: 'QQQ', ts: OPEN + i * MIN, open: price(i), high: Math.max(price(i), price(i + 1)), low: Math.min(price(i), price(i + 1)), close: price(i + 1), volume: 1000 });
async function harness(start, extra, options) {
  let now = start;
  const cfg = noiseConfig(extra), store = new Store(), broker = new SimBroker(cfg, store), engine = new Engine(cfg, store, broker, inlineWorkers, () => now);
  const list = sessions(options), prior = priorBars(list), requests = [];
  const history = { bars: async (symbols, from, to, timeframe = '1Min') => { requests.push(timeframe); return new Map([[symbols[0], (timeframe === '30Min' ? prior : Array.from({ length: 390 }, (_, i) => minuteBar(i))).filter(b => b.ts >= from && b.ts < to)]]); } };
  await engine.init();
  engine.noiseArea = new NoiseArea(engine, { calendar: async () => list }, history);
  // One simulated minute: a quote and reconciliation, the closed bar, then a second quote a
  // second later that fills anything the bar decision submitted.
  const tickQuote = async p => { await engine.onQuote({ symbol: 'QQQ', ts: now, bid: p - .005, ask: p + .005 }); await engine.reconcile(); };
  const minute = async i => {
    now = OPEN + (i + 1) * MIN + 500; await tickQuote(price(i + 1));
    await engine.onBar(minuteBar(i));
    now += 1000; await tickQuote(price(i + 1));
  };
  return { engine, store, cfg, requests, minute, at: t => { now = t; }, now: () => now };
}
const decisions = store => store.events(500).filter(e => e.type === 'noise_area_decision').map(e => e.data).reverse();

test('noise band comes from the prior 14 regular sessions, the prior close and today\'s open', async () => {
  const h = await harness(OPEN + 5000);
  try {
    await h.engine.reconcile(); await h.engine.noiseArea.tick(h.now());
    const s = h.engine.noiseArea.state;
    assert.equal(s.prevClose, 100); assert.equal(s.marks.length, 12); assert.equal(s.marks[0].ts, OPEN + 30 * MIN); assert.equal(s.marks.at(-1).ts, CLOSE - 30 * MIN);
    assert.ok(s.marks.every(m => Math.abs(m.sigma - .002) < 1e-12));
    assert.deepEqual(h.requests, ['30Min']); // No minute-bar restore needed at the open.
    await h.minute(0); assert.equal(s.dayOpen, 100);
  } finally { h.engine.stopped = true; h.store.close(); }
});

test('a long opens above the upper band and exits below max(upper band, VWAP) at the next check', async () => {
  const h = await harness(OPEN + 5000);
  try {
    await h.engine.reconcile(); await h.engine.noiseArea.tick(h.now());
    for (let i = 0; i < 30; i++) await h.minute(i);
    let d = decisions(h.store);
    assert.equal(d.length, 1); assert.equal(d[0].action, 'enter_long'); assert.equal(d[0].price, price(30));
    assert.ok(Math.abs(d[0].ub - 100.2) < 1e-9);
    const entry = h.store.orders().find(o => o.kind === 'entry');
    assert.equal(entry.strategy, 'noise_area'); assert.equal(entry.qty, 14); // $1,500 notional at about $100.6.
    assert.ok(entry.stop < price(30) * .9851 && entry.stop > price(30) * .984); assert.ok(entry.target > price(30) * 1.04);
    assert.ok(entry.maxHold > CLOSE - h.now());
    for (let i = 30; i < 60; i++) await h.minute(i); // The next quote fills the entry.
    assert.equal(h.engine.managed.QQQ.strategy, 'noise_area');
    d = decisions(h.store);
    assert.equal(d[1].action, 'exit_long'); assert.ok(d[1].vwap > d[1].ub); assert.ok(d[1].price < d[1].vwap);
    await h.minute(60); await h.minute(61);
    const exit = h.store.orders().find(o => o.kind === 'exit');
    assert.equal(exit.reason, 'noise_trailing_stop'); assert.equal(exit.status, 'filled'); assert.equal(exit.qty, 14);
    assert.equal(h.engine.managed.QQQ, undefined);
    for (let i = 62; i < 120; i++) await h.minute(i);
    assert.deepEqual(decisions(h.store).map(x => x.action), ['enter_long', 'exit_long', 'hold_flat', 'hold_flat']);
    const report = h.engine.observability.snapshot('QQQ').reports.find(r => r.strategy === 'noise_area');
    assert.equal(report.checks.length, 3); assert.equal(h.engine.status().noiseArea.decided, 4);
  } finally { h.engine.stopped = true; h.store.close(); }
});

test('after a restart the open and VWAP are restored and passed checks are never traded late', async () => {
  const h = await harness(OPEN + 45 * MIN + 30000);
  try {
    await h.engine.reconcile(); await h.engine.noiseArea.tick(h.now());
    const s = h.engine.noiseArea.state;
    assert.deepEqual(h.requests, ['30Min', '1Min']); assert.equal(s.dayOpen, 100); assert.equal(s.bars.size, 45);
    assert.equal(s.marks[0].done, 'missed_before_start'); // 10:00 was above the band, but it is 10:15 now.
    for (let i = 45; i < 60; i++) await h.minute(i);
    assert.deepEqual(decisions(h.store).map(x => x.action), ['hold_flat']);
    assert.equal(h.store.orders().length, 0);
  } finally { h.engine.stopped = true; h.store.close(); }
});

test('an early close shortens the checks and an incomplete prior session blocks the day', async () => {
  const early = await harness(OPEN + 5000, {}, { earlyToday: true });
  try {
    await early.engine.reconcile(); await early.engine.noiseArea.tick(early.now());
    assert.equal(early.engine.noiseArea.state.marks.at(-1).ts, DAY + 16.5 * 3600000); // 12:30 for a 13:00 close.
  } finally { early.engine.stopped = true; early.store.close(); }
  const h = await harness(OPEN + 5000);
  try {
    h.engine.noiseArea.history = { bars: async () => new Map([['QQQ', []]]) };
    await h.engine.reconcile(); await h.engine.noiseArea.tick(h.now());
    assert.equal(h.engine.noiseArea.state, null); assert.equal(h.engine.noiseArea.reason, 'noise_prior_close_missing');
  } finally { h.engine.stopped = true; h.store.close(); }
});

test('bar strategies leave the noise notional free while it is flat; config rejects impossible setups', () => {
  const now = OPEN + 60 * MIN, account = { cash: 10000, equity: 10000, buyingPower: 10000, ts: now, blocked: false }, session = { open: true, close: CLOSE, ts: now };
  const asset = { tradable: true, min_order_size: 1, min_trade_increment: 1, price_increment: .01 }, q = { symbol: 'SPY', ts: now, bid: 99.99, ask: 100.01 };
  const bar = { symbol: 'SPY', strategy: 'range_breakout', ts: now, expires: now + 10000, reference: 100, stop: 98, target: 104, features: {} };
  const held = [{ symbol: 'AAPL', qty: 14, marketValue: 1400 }];
  const both = noiseConfig({ STRATEGIES: 'noise_area,range_breakout' }), without = noiseConfig({ STRATEGIES: 'range_breakout' });
  assert.equal(sizeEntry(bar, q, account, held, [], both, asset, now, session).reason, 'insufficient_capacity_or_lot_size');
  assert.equal(sizeEntry(bar, q, account, held, [], without, asset, now, session).ok, true);
  const noise = { ...bar, symbol: 'SPY', strategy: 'noise_area', stop: 98.5, target: 105, sizing: { notional: 1500 } };
  assert.equal(sizeEntry(noise, q, account, held, [], noiseConfig({ STRATEGIES: 'noise_area,range_breakout', NOISE_AREA_SYMBOL: 'SPY' }), asset, now, session).qty, 14);
  assert.throws(() => testConfig({ STRATEGIES: 'noise_area' }), /shadow, paper or live/);
  assert.throws(() => noiseConfig({ NOISE_AREA_SYMBOL: 'IWM' }), /EQUITY_SYMBOLS/);
  assert.throws(() => noiseConfig({ NOISE_AREA_NOTIONAL_USD: '2500', MAX_GROUP_USD: '2000' }), /exceeds/);
});
