import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fixture, testConfig, candidate } from './helpers.js';
import { Jev, parseJev, requestFor } from '../src/jev.js';
import { Store } from '../src/store.js';
import { AlpacaBroker } from '../src/broker.js';
import { parseMessage } from '../src/feeds.js';
import { createDashboard } from '../src/server.js';

const response = () => ({ model: 'jev-1.13.0', answers: { coherence: { type: 'noul', noul: .9 }, regime: { type: 'choice', choice: 'trend', probabilities: { trend: .9, range: .05, disorderly: .05 }, confidence: .85 }, quality: { type: 'score', score: 3.8, probabilities: { 0: 0, 1: 0, 2: 0, 3: .2, 4: .8 }, confidence: .8 } }, usage: { input_tokens: 1200 } });
test('Jev uses all three typed question contracts and rejects schema drift', () => {
  const cfg = testConfig(), body = requestFor(candidate('SPY', 100), cfg.jevModel);
  assert.deepEqual(Object.values(body.questions).map(x => x.type), ['noul', 'choice', 'score']);
  assert.equal(parseJev(response(), cfg).quality, .95);
  const invalid = response(); invalid.answers.coherence.noul = NaN; assert.throws(() => parseJev(invalid, cfg));
  assert.throws(() => parseJev({ ...response(), model: 'jev-new' }, cfg));
});

test('Jev success settles persistent token cost; failures retain conservative reservation', async () => {
  const cfg = { ...testConfig(), jevMode: 'filter', jevKey: 'private', jevBudget: 1 }, s = new Store();
  try {
    let seen; const client = new Jev(cfg, s, async (url, opts) => { seen = JSON.parse(opts.body); return { ok: true, json: async () => response() }; });
    const now = Date.now(), month = new Date(now).toISOString().slice(0, 7);
    const r = await client.evaluate(candidate('SPY', now), now); assert.equal(r.pass, true); assert.ok(seen.questions.regime); assert.equal(s.spend(month), 1200 * .042 / 1e6);
    client.fetch = async () => { throw new Error('sensitive private key'); }; const failed = await client.evaluate(candidate('SPY', now), now); assert.equal(failed.error, 'model_unavailable'); assert.ok(s.spend(month) > r.cost);
    const empty = new Jev({ ...cfg, jevBudget: 0 }, s, async () => { throw new Error('should never call'); }); assert.equal((await empty.evaluate(candidate('SPY', now), now)).error, 'model_budget_exhausted');
  } finally { s.close(); }
});

test('broker payload uses native equity bracket and simple crypto orders', async () => {
  const requests = [], broker = new AlpacaBroker(testConfig(), async (url, opts) => {
    const body = opts.body ? JSON.parse(opts.body) : null; requests.push({ url, body });
    return { ok: true, status: 200, json: async () => ({ id: 'b', client_order_id: body?.client_order_id, symbol: body?.symbol, status: 'new', qty: body?.qty, side: body?.side }) };
  });
  await broker.submit({ id: 'e', symbol: 'SPY', kind: 'entry', qty: 1, limit: 100, stop: 98, target: 104 });
  assert.equal(requests[0].body.order_class, 'bracket'); assert.equal(requests[0].body.limit_price, '100');
  await broker.submit({ id: 'c', symbol: 'BTC/USD', kind: 'entry', qty: .001, limit: 60000 });
  assert.equal(requests[1].body.order_class, undefined); assert.equal(requests[1].body.time_in_force, 'ioc');
  assert.ok(requests.every(r => r.url.startsWith('https://paper-api.alpaca.markets/')));
});

test('bracket lookup refreshes nested protective legs', async () => {
  const calls = [], broker = new AlpacaBroker(testConfig(), async url => {
    calls.push(url); return { ok: true, status: 200, json: async () => ({ id: 'b', client_order_id: 'e', symbol: 'SPY', status: 'filled', qty: '1', filled_qty: '1', order_class: 'bracket', ...(url.includes('nested=true') ? { legs: [{ id: 'stop', status: 'new', type: 'stop', qty: '1' }] } : {}) }) };
  });
  const order = await broker.find('e'); assert.equal(order.legs.length, 1); assert.ok(calls[1].endsWith('?nested=true'));
});

test('market schemas reject invalid bars and ignore correction retriggers', () => {
  assert.equal(parseMessage({ T: 'u', S: 'SPY' }), null);
  assert.equal(parseMessage({ T: 'b', S: 'SPY', t: 'invalid', o: 1, h: 2, l: 0, c: 1, v: 2 }), null);
  assert.equal(parseMessage({ T: 'q', S: 'SPY', t: '2026-09-22T15:00:00Z', bp: 100, ap: 101 }).bid, 100);
});

test('dashboard authenticates data and controls, rejects cross-origin flatten, hides credentials', async () => {
  const f = await fixture(), server = createDashboard(f.engine, f.cfg); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`, headers = { Authorization: `Bearer ${f.cfg.token}`, 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(base + '/healthz')).status, 200);
    assert.equal((await fetch(base + '/api/status')).status, 401);
    const status = await (await fetch(base + '/api/status', { headers })).text(); assert.ok(!status.includes(f.cfg.token));
    assert.equal((await fetch(base + '/api/control', { method: 'POST', headers: { ...headers, Origin: 'https://hostile.example' }, body: JSON.stringify({ action: 'flatten', confirmation: 'FLATTEN_MANAGED_POSITIONS' }) })).status, 403);
    assert.equal((await fetch(base + '/api/control', { method: 'POST', headers, body: JSON.stringify({ action: 'flatten' }) })).status, 400);
    assert.equal((await fetch(base + '/api/control', { method: 'POST', headers, body: JSON.stringify({ action: 'pause' }) })).status, 202);
    assert.equal(f.engine.operatorPause, true);
    const html = await fetch(base + '/'); assert.ok(html.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  } finally { await new Promise(resolve => server.close(resolve)); f.store.close(); }
});
