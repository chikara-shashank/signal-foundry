import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, quote, inlineWorkers } from './helpers.js';
import { Engine } from '../src/engine.js';
import { SimBroker } from '../src/broker.js';
import { nyDate } from '../src/util.js';
import { DemoFeed } from '../src/feeds.js';

test('accepted order with lost HTTP response is reconciled without resubmission', async () => {
  const f = await fixture();
  try {
    const original = f.broker.submit.bind(f.broker); let calls = 0;
    f.broker.submit = async o => { calls++; await original(o); throw new Error('timeout after acceptance'); };
    await f.engine.mutex.run(() => f.engine.enter(f.prepare()));
    assert.equal(f.store.orders()[0].status, 'unknown'); assert.equal(f.engine.ready, false);
    await f.engine.mutex.run(() => f.engine.enter(f.prepare('QQQ', 'second'))); assert.equal(calls, 1);
    await f.engine.reconcile(); assert.equal(f.store.orders()[0].status, 'new'); assert.equal(f.engine.ready, true); assert.equal(calls, 1);
  } finally { f.store.close(); }
});

test('unknown missing order remains reserved and blocks entries', async () => {
  const f = await fixture();
  try { f.broker.submit = async () => { throw new Error('network'); }; await f.engine.mutex.run(() => f.engine.enter(f.prepare())); await f.engine.reconcile(); assert.ok(f.engine.issues.includes('unresolved_order')); assert.ok(f.engine.pending()[0].reserved > 0); }
  finally { f.store.close(); }
});

test('local fills require a later quote and expired entries cannot fill', async () => {
  const f = await fixture();
  try {
    const c = f.prepare(); await f.engine.mutex.run(() => f.engine.enter(c));
    f.broker.onQuote(quote('SPY', f.now())); assert.equal((await f.broker.positions()).length, 0);
    f.advance(1000); f.engine.onQuote(quote('SPY', f.now())); await f.engine.reconcile(); assert.equal(f.engine.positions.length, 1);
    const o = { id: 'expire', symbol: 'QQQ', kind: 'entry', qty: 1, limit: 101, ts: f.now() };
    await f.broker.submit(o); f.advance(21000); f.broker.onQuote(quote('QQQ', f.now())); assert.equal((await f.broker.find('expire')).status, 'expired');
  } finally { f.store.close(); }
});

test('restart preserves ownership, operator pause, and daily loss halt', async () => {
  const f = await fixture();
  try {
    await f.engine.mutex.run(() => f.engine.enter(f.prepare())); f.advance(1000); f.engine.onQuote(quote('SPY', f.now())); await f.engine.reconcile();
    await f.engine.control('pause'); f.store.set(`lossHalt:${nyDate(f.now())}`, true);
    const next = new Engine(f.cfg, f.store, new SimBroker(f.cfg, f.store), inlineWorkers, f.now); await next.init();
    assert.equal(next.operatorPause, true); assert.ok(next.managed.SPY); assert.ok(next.issues.includes('daily_loss_limit'));
    await next.control('resume'); assert.equal(next.ready, false);
  } finally { f.store.close(); }
});

test('concurrent entry candidates cannot allocate the same symbol twice', async () => {
  const f = await fixture({ SYMBOL_COOLDOWN_SECONDS: '0' });
  try { const a = f.prepare(), b = f.prepare('SPY', 'other'); await Promise.all([f.engine.mutex.run(() => f.engine.enter(a)), f.engine.mutex.run(() => f.engine.enter(b))]); assert.equal(f.store.orders().length, 1); assert.equal(b.reason, 'symbol_already_allocated'); }
  finally { f.store.close(); }
});

test('external holdings block entries and are not flattened', async () => {
  const f = await fixture();
  try { f.broker.state.positions.QQQ = { symbol: 'QQQ', qty: 1, entryPrice: 100 }; await f.engine.reconcile(); assert.ok(f.engine.issues.includes('external_account_activity')); await f.engine.control('flatten'); await f.engine.reconcile(); assert.equal(f.store.orders().length, 0); }
  finally { f.store.close(); }
});

test('partial entry cancellation closes only the actual remaining position', async () => {
  const f = await fixture();
  try {
    await f.engine.mutex.run(() => f.engine.enter(f.prepare())); const order = f.store.orders()[0];
    Object.assign(f.broker.state.orders[order.id], { status: 'canceled', filledQty: 1, fillPrice: 100 });
    f.broker.state.positions.SPY = { symbol: 'SPY', qty: 1, entryPrice: 100 };
    await f.engine.reconcile(); const exits = f.store.orders().filter(o => o.kind === 'exit'); assert.equal(exits.length, 1); assert.equal(exits[0].qty, 1);
  } finally { f.store.close(); }
});

test('flatten waits for native protective leg cancellation acknowledgment', async () => {
  const f = await fixture();
  try {
    await f.engine.mutex.run(() => f.engine.enter(f.prepare())); f.advance(1000); f.engine.onQuote(quote('SPY', f.now())); await f.engine.reconcile();
    const parent = Object.values(f.broker.state.orders)[0]; parent.legs = [{ id: 'leg', brokerId: 'leg', status: 'new', type: 'stop' }];
    let cancels = 0; f.broker.cancel = async () => { cancels++; };
    await f.engine.control('flatten'); await f.engine.reconcile(); assert.ok(cancels > 0); assert.equal(f.store.orders().filter(o => o.kind === 'exit').length, 0);
    parent.legs[0].status = 'canceled'; await f.engine.reconcile(); assert.equal(f.store.orders().filter(o => o.kind === 'exit').length, 1);
  } finally { f.store.close(); }
});

test('stale model candidate cannot bypass changed quote or pause state', async () => {
  const f = await fixture();
  try { const c = f.prepare(); f.advance(11000); await f.engine.mutex.run(() => f.engine.enter(c)); assert.equal(f.store.orders().length, 0); assert.ok(['stale_or_invalid_quote', 'candidate_expired'].includes(c.reason)); }
  finally { f.store.close(); }
});

test('late fill after flatten retains the pending reduction request', async () => {
  const f = await fixture();
  try {
    await f.engine.mutex.run(() => f.engine.enter(f.prepare()));
    f.broker.cancel = async () => {}; // Exchange has not acknowledged cancellation.
    await f.engine.control('flatten'); f.advance(1000); f.engine.onQuote(quote('SPY', f.now())); await f.engine.reconcile();
    assert.equal(f.engine.managed.SPY.exitReason, 'operator_flatten');
    assert.equal(f.store.orders().filter(o => o.kind === 'exit').length, 1);
  } finally { f.store.close(); }
});

test('manual increase to a managed position is detected and not liquidated by flatten', async () => {
  const f = await fixture();
  try {
    await f.engine.mutex.run(() => f.engine.enter(f.prepare())); f.advance(1000); f.engine.onQuote(quote('SPY', f.now())); await f.engine.reconcile();
    f.broker.state.positions.SPY.qty += 10; await f.engine.reconcile(); await f.engine.control('flatten'); await f.engine.reconcile();
    assert.ok(f.engine.issues.includes('external_account_activity')); assert.equal(f.store.orders().filter(o => o.kind === 'exit').length, 0);
  } finally { f.store.close(); }
});

test('immediately filled submission retains reservation until positions and cash are reconciled', async () => {
  const f = await fixture({ MAX_POSITIONS: '1', SYMBOL_COOLDOWN_SECONDS: '0' });
  try {
    f.broker.submit = async o => ({ brokerId: 'instant', id: o.id, status: 'filled', filledQty: o.qty, fillPrice: o.limit, legs: [] });
    await f.engine.mutex.run(() => f.engine.enter(f.prepare()));
    assert.equal(f.engine.pending().length, 1);
    const second = f.prepare('QQQ', 'second'); await f.engine.mutex.run(() => f.engine.enter(second));
    assert.equal(second.reason, 'position_limit'); assert.equal(f.store.orders().length, 1);
  } finally { f.store.close(); }
});

test('coordinator accepts five distinct pending entries with no count cap and reports it explicitly', async () => {
  const symbols = ['SPY', 'QQQ', 'AAPL', 'NVDA', 'MSFT'];
  const f = await fixture({ EQUITY_SYMBOLS: symbols.join(','), MAX_POSITIONS: '0', MAX_POSITION_USD: '150' });
  try {
    for (const symbol of symbols) {
      const c = f.prepare(symbol, `entry-${symbol}`);
      await f.engine.mutex.run(() => f.engine.enter(c));
      assert.equal(c.status, 'approved');
    }
    assert.equal(f.store.orders().length, 5); assert.equal(f.engine.pending().length, 5);
    assert.ok(f.engine.pending().reduce((sum, o) => sum + o.reserved, 0) <= f.cfg.maxGross);
    assert.equal(f.engine.status().limits.maxPositions, null);
  } finally { f.store.close(); }
});

test('filled order with delayed position visibility remains reserved across reconciliation', async () => {
  const f = await fixture();
  try {
    const original = f.broker.submit.bind(f.broker);
    f.broker.submit = async o => { const remote = await original(o); Object.assign(remote, { status: 'filled', filledQty: o.qty, fillPrice: o.limit }); return remote; };
    await f.engine.mutex.run(() => f.engine.enter(f.prepare())); await f.engine.reconcile();
    assert.ok(f.engine.issues.includes('fill_not_reconciled')); assert.ok(f.engine.pending()[0].reserved > 0); assert.ok(f.engine.managed.SPY);
  } finally { f.store.close(); }
});

test('terminal partial fill retains reservation and ownership until broker position becomes visible', async () => {
  const f = await fixture();
  try {
    const original = f.broker.submit.bind(f.broker);
    f.broker.submit = async o => { const remote = await original(o); Object.assign(remote, { status: 'canceled', filledQty: 1, fillPrice: o.limit }); return remote; };
    await f.engine.mutex.run(() => f.engine.enter(f.prepare())); await f.engine.reconcile();
    assert.ok(f.engine.issues.includes('fill_not_reconciled')); assert.equal(f.engine.pending().length, 1); assert.ok(f.engine.managed.SPY);
    f.broker.state.positions.SPY = { symbol: 'SPY', qty: 1, entryPrice: 100 };
    f.broker.state.cash -= 101;
    await f.engine.reconcile();
    assert.ok(f.store.orders().find(o => o.kind === 'entry').settledAt);
    assert.equal(f.store.orders().filter(o => o.kind === 'exit').length, 1);
  } finally { f.store.close(); }
});

test('visible fill with stale broker cash cannot release the allocation', async () => {
  const f = await fixture();
  try {
    await f.engine.mutex.run(() => f.engine.enter(f.prepare()));
    const beforeCash = f.broker.state.cash;
    f.advance(1000); await f.engine.onQuote(quote('SPY', f.now())); await f.engine.mutex.tail;
    const afterCash = f.broker.state.cash;
    f.broker.state.cash = beforeCash;
    await f.engine.reconcile();
    assert.ok(f.engine.issues.includes('cash_not_reconciled')); assert.equal(f.engine.pending().length, 1);
    f.broker.state.cash = afterCash; await f.engine.reconcile();
    assert.ok(!f.engine.issues.includes('cash_not_reconciled')); assert.equal(f.engine.pending().length, 0);
  } finally { f.store.close(); }
});

test('accelerated demo resumes its saved timeline and price state on restart', async () => {
  const f = await fixture();
  try {
    const setTime = value => f.advance(value - f.now());
    const feed = new DemoFeed(f.cfg, f.engine, setTime);
    for (let i = 0; i < 100; i++) await feed.step(true);
    await feed.step(); await f.engine.control('pause');
    const last = f.store.bars('SPY').at(-1), savedIndex = feed.index;
    const next = new Engine(f.cfg, f.store, new SimBroker(f.cfg, f.store), inlineWorkers, f.now); await next.init();
    const resumed = new DemoFeed(f.cfg, next, setTime);
    assert.equal(resumed.index, savedIndex); assert.equal(resumed.prices.get('SPY'), last.close);
    assert.equal(next.operatorPause, true); await resumed.step();
    assert.equal(f.store.bars('SPY').at(-1).ts, last.ts + 60000);
  } finally { f.store.close(); }
});
