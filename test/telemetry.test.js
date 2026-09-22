import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fixture, quote } from './helpers.js';
import { aggregateDisplayBars, chartData, marketDiagnostics } from '../src/telemetry.js';
import { createDashboard } from '../src/server.js';
import { normalizeOrder } from '../src/broker.js';

test('chart aggregation labels missing minutes and excludes unclosed source bars', () => {
  const t = Date.parse('2026-09-22T15:00:00Z');
  const bar = i => ({ symbol:'SPY', ts:t+i*60000, open:100+i, high:102+i, low:99+i, close:101+i, volume:10 });
  const result = aggregateDisplayBars([bar(0),bar(1),bar(3),bar(5)],5,t+5*60000);
  assert.equal(result.length,1); assert.equal(result[0].partial,true); assert.equal(result[0].volume,30); assert.equal(result[0].close,104);
  assert.equal(aggregateDisplayBars([0,1,2,3,4].map(bar),5,t+5*60000)[0].partial,false);
});

test('accepted orders are not plotted as fills and unknown historical fill times are not invented', async () => {
  const f = await fixture();
  try {
    await f.engine.mutex.run(() => f.engine.enter(f.prepare()));
    let data = chartData(f.engine,'SPY');
    assert.equal(data.markers.filter(m => m.type==='fill').length,0);
    f.advance(1000); await f.engine.onQuote(quote('SPY',f.now())); await f.engine.reconcile();
    data = chartData(f.engine,'SPY'); const fill = data.markers.find(m => m.type==='fill');
    assert.equal(fill.ts,f.now()); assert.equal(fill.side,'buy'); assert.ok(fill.price>0);
    const order = f.store.orders()[0]; delete order.filledAt; delete order.lastFillObservedAt; f.store.order(order);
    data=chartData(f.engine,'SPY'); assert.equal(data.markers.filter(m=>m.type==='fill').length,0);
    assert.equal(data.timeline.find(m=>m.type==='fill').timeSource,'unavailable');
  } finally { f.store.close(); }
});

test('diagnostics distinguish synthetic prices, key presence, and execution mode without exposing secrets', async () => {
  const f=await fixture();
  try {
    f.cfg.key='do-not-disclose'; f.cfg.secret='private-secret';
    const d=marketDiagnostics(f.engine); assert.equal(d.synthetic,true); assert.equal(d.credentials.alpaca,true);
    assert.ok(d.hint.includes('MODE=demo')); assert.ok(!JSON.stringify(d).includes('do-not-disclose'));
  } finally { f.store.close(); }
});

test('chart API requires authentication, bounds selections, and exposes broker timestamps', async () => {
  const f=await fixture(), server=createDashboard(f.engine,f.cfg); server.listen(0,'127.0.0.1'); await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`, headers={Authorization:`Bearer ${f.cfg.token}`};
  try {
    assert.equal((await fetch(base+'/api/chart?symbol=SPY')).status,401);
    assert.equal((await fetch(base+'/api/chart?symbol=UNKNOWN',{headers})).status,400);
    assert.equal((await fetch(base+'/api/chart?symbol=SPY&interval=100000',{headers})).status,400);
    const data=await (await fetch(base+'/api/chart?symbol=SPY&interval=5',{headers})).json(); assert.equal(data.interval,5); assert.equal(data.symbol,'SPY');
    assert.ok((await (await fetch(base+'/chart.js')).text()).includes('TradingChart'));
    const o=normalizeOrder({symbol:'SPY',filled_at:'2026-09-22T15:00:00Z',filled_qty:'1',filled_avg_price:'100'});
    assert.equal(o.filledAt,Date.parse('2026-09-22T15:00:00Z'));
  } finally { await new Promise(resolve=>server.close(resolve)); f.store.close(); }
});
