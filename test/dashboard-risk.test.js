import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Engine } from '../src/engine.js';
import { createDashboard } from '../src/server.js';
import { chartData, performanceData } from '../src/telemetry.js';
import { fixture, quote, inlineWorkers } from './helpers.js';
import { nyDate } from '../src/util.js';

test('daily loss setting persists, invalid values fail, concurrent edits conflict, and a halt cannot be cleared by raising it', async () => {
  const f = await fixture();
  try {
    for (const dailyLoss of [0, -10, 100001, NaN, Infinity, '150', 1.001]) {
      await assert.rejects(f.engine.updateRiskSettings({ dailyLoss, expectedDailyLoss: 100 }), /ceiling/);
    }
    await f.engine.updateRiskSettings({ dailyLoss: 150.25, expectedDailyLoss: 100 });
    assert.equal(f.store.get('dailyLossOverride'), 150.25);
    await assert.rejects(f.engine.updateRiskSettings({ dailyLoss: 200, expectedDailyLoss: 100 }), /another session/);
    f.broker.state.cash -= 75; await f.engine.reconcile();
    assert.equal(f.engine.ready, true);
    const result = await f.engine.updateRiskSettings({ dailyLoss: 50, expectedDailyLoss: 150.25 });
    assert.equal(result.halted, true); assert.equal(f.engine.ready, false);
    await f.engine.mutex.run(() => f.engine.enter(f.prepare()));
    assert.equal(f.store.orders().length, 0);
    await f.engine.updateRiskSettings({ dailyLoss: 500, expectedDailyLoss: 50 });
    assert.equal(f.engine.ready, false);
    assert.equal(f.store.get(`lossHalt:${nyDate(f.now())}`), true);
    const restarted = new Engine(f.cfg, f.store, f.broker, inlineWorkers, f.now);
    await restarted.init();
    assert.equal(restarted.dailyLossLimit, 500); assert.equal(restarted.ready, false);
    assert.equal(f.store.events(50).filter(e => e.type === 'risk_settings_changed').length, 3);
  } finally { f.store.close(); }
});

test('risk and performance APIs require auth and risk writes reject cross-origin and oversized requests', async () => {
  const f = await fixture(), server = createDashboard(f.engine, f.cfg);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${f.cfg.token}`, 'Content-Type': 'application/json' };
  const body = JSON.stringify({ dailyLoss: 125, expectedDailyLoss: 100 });
  try {
    assert.equal((await fetch(base + '/api/performance')).status, 401);
    assert.equal((await fetch(base + '/api/risk-settings', { method: 'POST', body })).status, 401);
    assert.equal((await fetch(base + '/api/risk-settings', { method: 'POST', headers: { ...headers, Origin: 'https://other.invalid' }, body })).status, 403);
    assert.equal((await fetch(base + '/api/risk-settings', { method: 'POST', headers, body: JSON.stringify({ dailyLoss: 0, expectedDailyLoss: 100 }) })).status, 400);
    assert.equal((await fetch(base + '/api/risk-settings', { method: 'POST', headers, body: JSON.stringify({ text: 'x'.repeat(1100) }) })).status, 413);
    assert.equal((await fetch(base + '/api/risk-settings', { method: 'POST', headers, body })).status, 200);
    assert.equal((await fetch(base + '/api/risk-settings', { method: 'POST', headers, body })).status, 409);
    const p = await (await fetch(base + '/api/performance', { headers })).json();
    assert.equal(p.dailyLoss, 125); assert.ok(p.points.length > 0);
    assert.equal(f.store.orders().length, 0);
  } finally { await new Promise(resolve => server.close(resolve)); f.store.close(); }
});

test('reconciliation explains external positions and orders without adopting or closing them', async () => {
  const f = await fixture();
  try {
    const symbol = 'QQQ260925P00735000';
    f.broker.state.positions[symbol] = { symbol, qty: 50, entryPrice: 1.4 };
    f.broker.state.orders.external = { id: 'external', symbol: 'QQQ', side: 'buy', qty: 1, status: 'new' };
    await f.engine.reconcile();
    const s = f.engine.status();
    assert.equal(s.ready, false); assert.equal(s.reconciliation.positions[0].symbol, symbol);
    assert.equal(s.reconciliation.positions[0].configured, false); assert.equal(s.reconciliation.orders[0].clientId, 'external');
    assert.equal(s.positions[0].management, null);
    await f.engine.updateRiskSettings({ dailyLoss: 500, expectedDailyLoss: 100 });
    await f.engine.control('resume'); await f.engine.reconcile();
    assert.equal(f.engine.ready, false); assert.equal(f.store.orders().length, 0);
    assert.equal(f.broker.state.positions[symbol].qty, 50);
  } finally { f.store.close(); }
});

test('position P/L marks fresh bids and matched fills, while quote trails never fabricate candles', async () => {
  const f = await fixture({ SYMBOL_COOLDOWN_SECONDS: '0' });
  try {
    await f.engine.mutex.run(() => f.engine.enter(f.prepare()));
    f.advance(1000); await f.engine.onQuote(quote('SPY', f.now())); await f.engine.reconcile();
    const entry = f.store.orders()[0];
    f.advance(1000); await f.engine.onQuote(quote('SPY', f.now(), 101));
    let data = chartData(f.engine, 'SPY');
    assert.equal(data.bars.length, 0); assert.ok(data.quoteSeries.length >= 2);
    assert.ok(Math.abs(data.positionPnl.value - (100.99 - entry.fillPrice) * entry.filledQty) < .00001);
    assert.equal(data.positionPnl.fresh, true);
    await f.engine.control('flatten'); await f.engine.reconcile();
    f.advance(1000); await f.engine.onQuote(quote('SPY', f.now(), 101)); await f.engine.reconcile();
    data = chartData(f.engine, 'SPY');
    assert.equal(data.positionPnl, null); assert.equal(data.trades.length, 1);
    const trade = data.trades[0];
    assert.equal(trade.pnl, (trade.exitPrice - trade.entryPrice) * trade.qty);
    assert.ok(trade.pnl > 0);
    assert.equal(data.timeline.find(item => item.type === 'fill' && item.side === 'sell').grossPnl, trade.pnl);
  } finally { f.store.close(); }
});

test('P/L history includes broker unrealized marks, preserves extrema, excludes prior dates, and labels stale data', async () => {
  const f = await fixture();
  try {
    const base = f.now();
    for (let i = 0; i < 1000; i++) f.store.event('equity', { dailyPnl: i === 333 ? -777 : i / 10, unrealized: i === 444 ? 888 : 3 }, base + i * 5000);
    f.advance(5000000);
    let p = performanceData(f.engine);
    assert.ok(p.points.length < 1000);
    assert.ok(p.points.some(x => x.dailyPnl === -777)); assert.ok(p.points.some(x => x.unrealized === 888));
    f.engine.fail('broker_reconciliation_failed'); p = performanceData(f.engine); assert.equal(p.stale, true);
    f.advance(24 * 3600000); p = performanceData(f.engine); assert.equal(p.points.length, 0);
  } finally { f.store.close(); }
});
