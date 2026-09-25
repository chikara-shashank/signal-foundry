import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Engine } from '../src/engine.js';
import { createDashboard } from '../src/server.js';
import { STRATEGY_REGISTRY, WORKER_STRATEGIES } from '../src/strategy-registry.js';
import { Workers } from '../src/workers.js';
import { evaluate } from '../src/strategies.js';
import { fixture, inlineWorkers, quote, testConfig } from './helpers.js';

const change = (e, strategy, enabled) => e.strategyControls.update({ strategy, enabled, expectedRevision: e.strategyControls.state.revision });

test('saved selections persist across restarts, allow all off and reject invalid or stale edits', async () => {
  const f = await fixture();
  try {
    const e = f.engine;
    for (const request of [null, [], {}, { strategy: 'unknown', enabled: true, expectedRevision: 0 }, { strategy: 'range_breakout', enabled: 'false', expectedRevision: 0 }, { strategy: 'range_breakout', enabled: false, expectedRevision: -1 }, { strategy: 'range_breakout', enabled: false, expectedRevision: 0, extra: true }]) {
      await assert.rejects(e.strategyControls.update(request), { status: 400 });
    }
    await change(e, 'range_breakout', false);
    await assert.rejects(e.strategyControls.update({ strategy: 'trend_pullback', enabled: false, expectedRevision: 0 }), { status: 409 });
    for (const id of e.strategyControls.enabledIds()) await change(e, id, false);
    const restart = new Engine(f.cfg, f.store, f.broker, inlineWorkers, f.now); await restart.init();
    assert.deepEqual(restart.strategyControls.enabledIds(), []);
    assert.equal(restart.checkEntry(f.prepare()).reason, 'strategy_disabled');
    assert.equal(f.store.events(100).filter(e => e.type === 'strategy_settings_changed').length, WORKER_STRATEGIES.length);
    assert.equal(testConfig({ STRATEGIES: '' }).strategies.length, 0);
    await assert.rejects(change(restart, 'noise_area', true), /provider sessions/);
    assert.equal(f.store.orders().length, 0);
  } finally { f.store.close(); }
});

test('a newly installed strategy stays off when absent from saved settings', async () => {
  const f = await fixture();
  try {
    const saved = f.store.get('strategySettings'); delete saved.strategies.volatility_expansion; f.store.set('strategySettings', saved);
    const e = new Engine(f.cfg, f.store, f.broker, inlineWorkers, f.now); await e.init();
    assert.equal(e.strategyControls.enabled('volatility_expansion'), false);
    await change(e, 'volatility_expansion', true);
    assert.equal(e.strategyControls.enabled('volatility_expansion'), true);
  } finally { f.store.close(); }
});

test('worker signals computed before an off/on cycle cannot place orders', async () => {
  const f = await fixture();
  try {
    const c = f.prepare(); let release;
    f.engine.workers = { ...inlineWorkers, evaluate: () => new Promise(resolve => { release = resolve; }) };
    // prepare inserted a different candidate; the worker produces its own unique record.
    c.id = 'worker-in-flight';
    const running = f.engine.processCandidates(c.features, ['range_breakout']);
    await change(f.engine, 'range_breakout', false); await change(f.engine, 'range_breakout', true);
    release([c]); await running;
    assert.equal(f.store.getCandidate(c.id).reason, 'strategy_selection_changed'); assert.equal(f.store.orders().length, 0);
  } finally { f.store.close(); }
});

test('switching off while a model call is in flight prevents entry on its response', async () => {
  const f = await fixture();
  try {
    const c = f.prepare(); c.id = 'model-in-flight'; let respond, begun;
    const started = new Promise(resolve => { begun = resolve; });
    f.engine.workers = { ...inlineWorkers, evaluate: async () => [c] };
    f.engine.jev.evaluate = () => { begun(); return new Promise(resolve => { respond = resolve; }); };
    const running = f.engine.processCandidates(c.features, ['range_breakout']); await started;
    await change(f.engine, 'range_breakout', false); respond({ pass: true, mode: 'off' }); await running;
    assert.equal(f.store.getCandidate(c.id).reason, 'strategy_disabled'); assert.equal(f.store.orders().length, 0);
  } finally { f.store.close(); }
});

test('disabled pending entries are cancelled; held positions and protective orders continue until their exit', async () => {
  const f = await fixture({ SYMBOL_COOLDOWN_SECONDS: '0' });
  try {
    await f.engine.mutex.run(() => f.engine.enter(f.prepare()));
    await change(f.engine, 'range_breakout', false); await f.engine.reconcile();
    assert.equal(f.store.orders()[0].status, 'canceled'); assert.equal(f.engine.positions.length, 0);
    await change(f.engine, 'range_breakout', true);
    const c = f.prepare('SPY', 'second'); c.strategyGeneration = f.engine.strategyControls.generation(c.strategy);
    await f.engine.mutex.run(() => f.engine.enter(c));
    f.advance(1000); await f.engine.onQuote(quote('SPY', f.now())); await f.engine.reconcile();
    const parent = f.store.orders().find(o => o.candidateId === 'second');
    assert.equal(parent.status, 'filled'); assert.ok(f.engine.managed.SPY);
    let cancels = 0; const original = f.broker.cancel.bind(f.broker); f.broker.cancel = async o => { cancels++; return original(o); };
    await change(f.engine, 'range_breakout', false); assert.equal(cancels, 0);
    assert.equal(f.engine.managed.SPY.exitReason, null);
    f.advance(1000); await f.engine.onQuote(quote('SPY', f.now(), 105)); await f.engine.reconcile();
    assert.equal(f.store.orders().find(o => o.kind === 'exit').reason, 'target');
    f.advance(1000); await f.engine.onQuote(quote('SPY', f.now(), 105)); await f.engine.reconcile();
    assert.equal(f.engine.positions.length, 0); assert.equal(f.engine.managed.SPY, undefined);
    const row = f.engine.strategyControls.snapshot().strategies.find(s => s.id === 'range_breakout');
    assert.equal(row.enabled, false); assert.equal(row.closed, 1); assert.equal(row.wins, 1); assert.ok(row.realizedNetPnl > 0);
  } finally { f.store.close(); }
});

test('uncertain entry cancellation survives re-enable until the broker outcome is known', async () => {
  const f = await fixture();
  try {
    await f.engine.mutex.run(() => f.engine.enter(f.prepare()));
    const o = f.store.orders()[0]; o.status = 'unknown'; f.store.order(o);
    await change(f.engine, 'range_breakout', false); await change(f.engine, 'range_breakout', true);
    assert.equal(f.store.orders()[0].entryDisableRequested, true);
    await f.engine.reconcile(); await f.engine.reconcile();
    assert.equal(f.store.orders()[0].status, 'canceled'); assert.equal(f.engine.positions.length, 0);
  } finally { f.store.close(); }
});

test('per-strategy results combine assets, retain disabled history and exclude partial exits from win rate', async () => {
  const f = await fixture();
  try {
    const add = (id, symbol, strategy, entryPrice, exitPrice, qty, exitQty) => {
      f.store.order({ id, ts: f.now(), kind: 'entry', symbol, strategy, status: 'filled', qty, filledQty: qty, fillPrice: entryPrice, feeRateBps: 0, legs: [] });
      f.store.order({ id: id + '-exit', entryId: id, ts: f.now(), kind: 'exit', symbol, status: 'filled', qty: exitQty, filledQty: exitQty, fillPrice: exitPrice, feeRateBps: 0 });
    };
    add('stock', 'SPY', 'range_breakout', 100, 102, 2, 2); // +4 closed winner
    add('crypto', 'BTC/USD', 'range_breakout', 100, 99, 1, 1); // -1 closed loss
    add('partial', 'QQQ', 'range_breakout', 100, 103, 4, 2); // +6 partial, not a third win
    add('history', 'SPY', 'retired_strategy', 100, 101, 1, 1);
    await change(f.engine, 'range_breakout', false);
    const result = f.engine.strategyControls.snapshot(), row = result.strategies.find(s => s.id === 'range_breakout');
    assert.equal(row.realizedNetPnl, 9); assert.equal(row.closed, 2); assert.equal(row.wins, 1); assert.equal(row.winRate, .5); assert.equal(row.partial, 1);
    assert.equal(result.strategies.find(s => s.id === 'vwap_reversion').winRate, null);
    assert.equal(result.strategies.find(s => s.id === 'retired_strategy').installed, false);
    assert.equal(result.strategies.filter(s => s.installed).length, STRATEGY_REGISTRY.length);
    assert.equal(row.enabled, false);
  } finally { f.store.close(); }
});

test('a disabled worker failure does not block the enabled strategies', async () => {
  const f = await fixture({ STRATEGIES: 'trend_pullback' });
  try {
    f.engine.workers = { ...inlineWorkers, status: () => inlineWorkers.status().map(w => ({ ...w, alive: w.strategy !== 'range_breakout' })) };
    await f.engine.reconcile(); assert.equal(f.engine.ready, true);
    await assert.rejects(change(f.engine, 'range_breakout', true), /unavailable/);
    await change(f.engine, 'vwap_reversion', true); assert.equal(f.engine.strategyControls.enabled('vwap_reversion'), true);
  } finally { f.store.close(); }
});

test('registry worker strategies have callable evaluators and unknown IDs fail closed', async () => {
  const workers = new Workers(WORKER_STRATEGIES);
  try {
    const now = Date.now(), f = { symbol: 'SPY', version: now, bar: { close: 101, open: 100, high:101.2, low: 99, volume: 1000 }, atr: 1, trend5: 1, trend15: 1, ema9: 100, ema21: 99, previous: { close: 100, low: 99 }, previousEma9: 100, rangeHigh: 100, rangeLow: 98, relativeVolume: 2, rollingVwap: 100 };
    const results = await workers.evaluate(f, now, ['range_breakout']);
    assert.equal(results.length, 1); assert.equal(results[0].strategy, 'range_breakout');
    assert.equal(evaluate('not_installed', f, now), null);
  } finally { await workers.close(); }
});

test('switching off noise-area releases its idle notional reservation for other strategies', async () => {
  const f = await fixture({ MODE: 'shadow', ALPACA_KEY: 'fixture', ALPACA_SECRET: 'fixture', STRATEGIES: 'noise_area,range_breakout', MAX_GROSS_USD: '3000', MAX_GROUP_USD: '3000' });
  try {
    f.engine.noiseArea = { reason: 'ready', state: { date: '2026-09-22' } };
    const c = f.prepare();
    f.engine.positions = [{ symbol: 'AAPL', qty: 14, marketValue: 1400 }];
    assert.equal(f.engine.checkEntry(c).reason, 'insufficient_capacity_or_lot_size');
    await change(f.engine, 'noise_area', false);
    assert.equal(f.engine.checkEntry(c).ok, true);
  } finally { await f.engine.mutex.tail; f.store.close(); }
});

test('open strategy P/L excludes external holdings and becomes unavailable on reconciliation failure', async () => {
  const f = await fixture({ ACCOUNT_POLICY: 'shared' });
  try {
    await f.engine.mutex.run(() => f.engine.enter(f.prepare()));
    f.advance(1000); await f.engine.onQuote(quote('SPY', f.now())); await f.engine.reconcile();
    f.broker.state.positions.QQQ = { symbol: 'QQQ', qty: 100, entryPrice: 200 };
    f.advance(1000); await f.engine.onQuote(quote('SPY', f.now(), 101)); await f.engine.onQuote(quote('QQQ', f.now(), 50)); await f.engine.reconcile();
    const entry = f.store.orders().find(o => o.kind === 'entry');
    const row = f.engine.strategyControls.snapshot().strategies.find(s => s.id === 'range_breakout');
    assert.ok(Math.abs(row.openGrossPnl - entry.filledQty * (100.99 - entry.fillPrice)) < 1e-8);
    assert.equal(row.openPositions, 1); assert.equal(row.closed, 0); assert.equal(row.winRate, null);
    f.engine.fail('broker_reconciliation_failed');
    assert.equal(f.engine.strategyControls.snapshot().strategies.find(s => s.id === 'range_breakout').openGrossPnl, null);
  } finally { f.store.close(); }
});

test('strategy APIs enforce authentication, origins, shape, concurrency and body limits', async () => {
  const f = await fixture(), server = createDashboard(f.engine, f.cfg); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`, headers = { Authorization: `Bearer ${f.cfg.token}`, 'Content-Type': 'application/json' };
  const body = JSON.stringify({ strategy: 'range_breakout', enabled: false, expectedRevision: 0 });
  const post = (body, extra = {}) => fetch(base + '/api/strategy-settings', { method: 'POST', body, headers, ...extra });
  try {
    assert.equal((await fetch(base + '/api/strategies')).status, 401);
    assert.equal((await post(body, { headers: {} })).status, 401);
    assert.equal((await post(body, { headers: { ...headers, Origin: 'https://other.invalid' } })).status, 403);
    assert.equal((await post('null')).status, 400);
    assert.equal((await post(JSON.stringify({ padding: 'x'.repeat(1200) }))).status, 413);
    assert.equal((await post(body)).status, 200); assert.equal((await post(body)).status, 409);
    const result = await (await fetch(base + '/api/strategies', { headers })).json();
    assert.equal(result.revision, 1); assert.equal(result.strategies.find(s => s.id === 'range_breakout').enabled, false);
    assert.equal(f.store.orders().length, 0);
  } finally { await new Promise(resolve => server.close(resolve)); f.store.close(); }
});
