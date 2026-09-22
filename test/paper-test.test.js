import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fixture, quote } from './helpers.js';
import { createDashboard } from '../src/server.js';
import { chartData } from '../src/telemetry.js';

const paper = () => fixture({ MODE:'paper', ALPACA_KEY:'test-only', ALPACA_SECRET:'test-only' });
test('paper connectivity test is idempotent, size-limited, and exits through the normal coordinator', async () => {
  const f=await paper();
  try {
    f.engine.onQuote(quote('SPY',f.now())); const requestId=randomUUID();
    const c=await f.engine.paperTest('SPY',requestId); assert.equal(c.status,'approved');
    assert.equal(f.store.orders()[0].qty,1); assert.equal((await f.engine.paperTest('SPY',requestId)).orderId,c.orderId); assert.equal(f.store.orders().length,1);
    f.advance(1000); await f.engine.onQuote(quote('SPY',f.now())); await f.engine.reconcile();
    f.advance(60001); await f.engine.onQuote(quote('SPY',f.now())); await f.engine.reconcile();
    assert.equal(f.store.orders().filter(o=>o.kind==='exit').length,1);
    f.advance(1000); await f.engine.onQuote(quote('SPY',f.now())); await f.engine.reconcile(); assert.equal(f.engine.positions.length,0);
    const exit = chartData(f.engine,'SPY').timeline.find(e=>e.type==='fill'&&e.side==='sell');
    assert.equal(exit.strategy,'operator_paper_test'); assert.equal(exit.reason,'holding_time');
  } finally { f.store.close(); }
});
test('paper test cannot bypass pause, missing quotes, or request throttling', async () => {
  const f=await paper();
  try {
    const stale=await f.engine.paperTest('SPY',randomUUID()); assert.equal(stale.reason,'stale_or_invalid_quote');
    assert.equal((await f.engine.paperTest('QQQ',randomUUID())).reason,'paper_test_cooldown');
    f.advance(61000); await f.engine.reconcile(); f.engine.onQuote(quote('SPY',f.now())); await f.engine.control('pause');
    assert.equal((await f.engine.paperTest('SPY',randomUUID())).reason,'entries_paused'); assert.equal(f.store.orders().length,0);
  } finally { f.store.close(); }
});
test('paper-test API rejects non-paper mode even with valid token and acknowledgment', async () => {
  const f=await fixture(), server=createDashboard(f.engine,f.cfg); server.listen(0,'127.0.0.1'); await once(server,'listening');
  try {
    f.cfg.mode='live'; f.cfg.brokerUrl='https://api.alpaca.markets';
    await assert.rejects(f.engine.paperTest('SPY',randomUUID()),/MODE=paper/);
    const r=await fetch(`http://127.0.0.1:${server.address().port}/api/paper-test`,{method:'POST',headers:{Authorization:`Bearer ${f.cfg.token}`,'Content-Type':'application/json'},body:JSON.stringify({symbol:'SPY',requestId:randomUUID(),confirmation:'PAPER_MONEY_ONLY'})});
    assert.equal(r.status,403); assert.equal(f.store.orders().length,0);
  } finally { await new Promise(resolve=>server.close(resolve)); f.store.close(); }
});
