import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { performanceData } from '../src/telemetry.js';
import { fixture, quote, inlineWorkers, testConfig } from './helpers.js';
import { nyDate } from '../src/util.js';
import { relatedSymbol } from '../src/portfolio.js';

const external = f => { f.broker.state.positions.QQQ260925P00735000 = { symbol: 'QQQ260925P00735000', qty: 50, entryPrice: 120 }; };
async function fill(f) { await f.engine.mutex.run(() => f.engine.enter(f.prepare())); f.advance(1000); await f.engine.onQuote(quote('SPY', f.now())); await f.engine.reconcile(); }

test('shared account allows unrelated entries with external options and reserves their underlying', async () => {
  const f = await fixture({ ACCOUNT_POLICY: 'shared' });
  try {
    external(f); await f.engine.reconcile(); const s = f.engine.status();
    assert.equal(s.ready, true); assert.equal(s.reconciliation.blocking, false); assert.equal(s.portfolio.managedGross, 0); assert.equal(s.portfolio.externalGross, 6000);
    assert.equal(s.positions[0].management, null); assert.ok(s.reconciliation.reservedSymbols.includes('QQQ'));
    const q = f.prepare('QQQ', 'blocked'); await f.engine.mutex.run(() => f.engine.enter(q)); assert.equal(q.reason, 'external_symbol_reserved');
    const spy = f.prepare('SPY', 'allowed'); await f.engine.mutex.run(() => f.engine.enter(spy)); assert.equal(spy.status, 'approved');
    await f.engine.control('flatten'); assert.equal(f.broker.state.positions.QQQ260925P00735000.qty, 50);
    assert.equal(f.store.orders().some(o => o.symbol.startsWith('QQQ')), false);
  } finally { f.store.close(); }
});

test('external P/L and cash transfers do not contaminate agent P/L or clear recorded history', async () => {
  const f = await fixture({ ACCOUNT_POLICY: 'shared' });
  try {
    external(f); await f.engine.reconcile();
    f.store.set(`lossHalt:${nyDate(f.now())}`, true);
    f.broker.state.cash -= 1000; f.broker.state.positions.QQQ260925P00735000.entryPrice = 10; f.advance(5000); await f.engine.reconcile();
    assert.equal(f.engine.portfolio.state.dailyPnl, 0); assert.equal(f.engine.ready, true);
    assert.equal(f.engine.status().limits.dailyLossHalted, false); assert.equal(f.store.get(`lossHalt:${nyDate(f.now())}`), true);
    f.broker.state.cash += 5000; await f.engine.reconcile(); assert.equal(f.engine.ready, true); assert.equal(f.engine.portfolio.state.dailyPnl, 0);
    assert.equal(performanceData(f.engine).scope, 'agent'); assert.equal(performanceData(f.engine, 'account').dailyLoss, null);
    assert.ok(performanceData(f.engine, 'account').latest.dailyPnl !== 0); assert.throws(() => performanceData(f.engine, 'unknown'));
  } finally { f.store.close(); }
});

test('shared cash ceiling retains local debits through stale broker cash and survives restart', async () => {
  const f = await fixture({ ACCOUNT_POLICY: 'shared', CAPITAL_BUDGET_USD: '2000', MAX_GROSS_USD: '2000' });
  try {
    const before = f.broker.state.cash; await fill(f); const order = f.store.orders()[0];
    f.broker.state.cash = before; await f.engine.reconcile();
    assert.ok(f.engine.portfolio.state.cashAvailable <= before - order.filledQty * order.fillPrice);
    const ceiling = f.engine.portfolio.state.cashAvailable;
    f.broker.state.cash += 10000; await f.engine.reconcile(); assert.equal(f.engine.portfolio.state.cashAvailable, ceiling);
    const next = new Engine(f.cfg, f.store, f.broker, inlineWorkers, f.now); await next.init(); assert.equal(next.portfolio.state.cashAvailable, ceiling);
    f.broker.state.cash = 50; await next.reconcile(); assert.equal(next.portfolio.state.cashAvailable, 50);
  } finally { f.store.close(); }
});

test('agent P/L includes managed marks and fees and its daily halt survives raising the ceiling and restart', async () => {
  const f = await fixture({ ACCOUNT_POLICY: 'shared' });
  try {
    await fill(f); const order = f.store.orders()[0];
    f.advance(1000); await f.engine.onQuote(quote('SPY', f.now(), 95)); await f.engine.reconcile();
    const expected = order.filledQty * (94.99 - order.fillPrice) - order.fee;
    assert.ok(Math.abs(f.engine.portfolio.state.dailyPnl - expected) < 1e-6);
    const result = await f.engine.updateRiskSettings({ dailyLoss: 5, expectedDailyLoss: 100 }); assert.equal(result.halted, true);
    await f.engine.updateRiskSettings({ dailyLoss: 500, expectedDailyLoss: 5 }); assert.equal(f.engine.ready, false);
    const next = new Engine(f.cfg, f.store, f.broker, inlineWorkers, f.now); await next.init(); assert.ok(next.issues.includes('daily_loss_limit'));
  } finally { f.store.close(); }
});

test('shared account blocks unmatched open orders without canceling external orders', async () => {
  const f = await fixture({ ACCOUNT_POLICY: 'shared' });
  try {
    f.broker.state.orders.external = { id: 'external', symbol: 'QQQ', side: 'buy', qty: 1, status: 'new' };
    await f.engine.reconcile(); assert.ok(f.engine.issues.includes('external_orders_pending'));
    await f.engine.control('cancel_entries'); assert.equal(f.broker.state.orders.external.status, 'new');
    f.broker.state.orders.external.status = 'canceled'; await f.engine.reconcile(); assert.equal(f.engine.issues.includes('external_orders_pending'), false);
  } finally { f.store.close(); }
});

test('both manual increases and reductions of managed quantities block shared allocations and exits', async () => {
  for (const delta of [-1, 1]) {
    const f = await fixture({ ACCOUNT_POLICY: 'shared' });
    try {
      await fill(f); f.broker.state.positions.SPY.qty += delta; await f.engine.reconcile();
      assert.ok(f.engine.issues.includes('managed_position_conflict')); assert.equal(f.engine.portfolio.state.dailyPnl, null);
      await f.engine.control('flatten'); await f.engine.reconcile(); assert.equal(f.store.orders().filter(o => o.kind === 'exit').length, 0);
    } finally { f.store.close(); }
  }
});

test('moving an existing agent book to shared mode does not silently erase a legacy loss halt', async () => {
  const f = await fixture();
  try {
    await fill(f); f.store.set('agentPnlTracking', null); f.store.set(`lossHalt:${nyDate(f.now())}`, true);
    const next = new Engine({ ...f.cfg, accountPolicy: 'shared' }, f.store, f.broker, inlineWorkers, f.now); await next.init();
    assert.equal(next.status().limits.dailyLossHalted, true);
  } finally { f.store.close(); }
});

test('shared-account policy validates modes and standard option underlying reservations', () => {
  assert.equal(relatedSymbol('QQQ260922P00740000'), 'QQQ'); assert.equal(relatedSymbol('BTC/USD'), 'BTC/USD');
  assert.throws(() => testConfig({ ACCOUNT_POLICY: 'ignore' }), /ACCOUNT_POLICY/);
  assert.throws(() => testConfig({ MODE: 'live', ACCOUNT_POLICY: 'shared' }), /paper/);
});
