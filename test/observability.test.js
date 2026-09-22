import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { assess } from '../src/strategies.js';
import { Workers } from '../src/workers.js';
import { Jev } from '../src/jev.js';
import { Store } from '../src/store.js';
import { createDashboard } from '../src/server.js';
import { activityPage } from '../src/observability.js';
import { fixture, testConfig, candidate, quote } from './helpers.js';

const features = () => ({ symbol: 'SPY', version: 1, bar: { ts: 1, open: 100, close: 102, low: 99, high: 103, volume: 100 },
  previous: { close: 100, low: 99 }, previousEma9: 100, atr: 1, ema9: 101, ema21: 100, trend5: .01, trend15: .01,
  relativeVolume: 1, rangeHigh: 101, rangeLow: 98, rollingVwap: 100, regime: 'trend' });

test('worker counters distinguish checks, matches and no setup, with the exact unmet threshold', async () => {
  const workers = new Workers(['range_breakout']), reports = [];
  workers.onEvaluation = r => reports.push(r);
  try {
    assert.equal((await workers.evaluate(features(), 1000)).length, 0);
    const failed = reports[0].checks.find(c => !c.pass);
    assert.equal(failed.name, 'Relative volume'); assert.equal(failed.actual, 1); assert.equal(failed.target, 1.25);
    assert.equal((await workers.evaluate({ ...features(), version: 2, relativeVolume: 1.25 }, 1000)).length, 1);
    const s = workers.status()[0]; assert.equal(s.evaluated, 2); assert.equal(s.matched, 1); assert.equal(s.noSetup, 1); assert.equal(s.errors, 0);
    assert.equal(reports[1].matched, true);
  } finally { await workers.close(); }
});

test('Jev off and budget skips do not count as API requests; failed requests do', async () => {
  const store = new Store(); let calls = 0;
  const fetchFn = async () => { calls++; throw new Error('private-key-canary'); };
  const cfg = testConfig(), c = candidate('SPY', Date.now());
  try {
    const off = new Jev(cfg, store, fetchFn);
    assert.equal((await off.evaluate(c)).requested, false); assert.equal(off.stats.requests, 0); assert.equal(off.stats.skipped, 1);
    const budget = new Jev({ ...cfg, jevMode: 'shadow', jevBudget: 0 }, store, fetchFn);
    assert.equal((await budget.evaluate(c)).requested, false); assert.equal(calls, 0);
    const enabled = new Jev({ ...cfg, jevMode: 'shadow', jevBudget: 1 }, store, fetchFn);
    assert.equal((await enabled.evaluate(c)).requested, true); assert.equal(calls, 1);
    assert.equal(enabled.stats.requests, 1); assert.equal(enabled.stats.failed, 1); assert.equal(enabled.stats.succeeded, 0);
    assert.doesNotMatch(JSON.stringify(enabled.stats), /private-key-canary/);
  } finally { store.close(); }
});

test('no-setup and rejected-quote logs are sampled, with every rejection still counted', async () => {
  const f = await fixture();
  try {
    const report = assess('range_breakout', features(), f.now()).assessment;
    for (let i = 0; i < 50; i++) f.engine.observability.evaluation({ ...report, ts: f.now() + i });
    assert.equal(f.store.eventsOfType('scan_summary', 0).length, 1);
    assert.equal(f.engine.observability.snapshot('SPY').topReasons[0].count, 50);
    for (let i = 0; i < 20; i++) await f.engine.onQuote(quote('SPY', f.now() - 60000));
    assert.equal(f.engine.observability.counts.quotesRejected, 20);
    assert.equal(f.store.eventsOfType('quote_rejected', 0).length, 1);
    assert.equal(f.engine.quotes.has('SPY'), false);
    assert.match(f.engine.observability.snapshot('SPY').why, /no accepted quote/);
  } finally { f.store.close(); }
});

test('order acceptance is not counted as a fill; repeated reconciliation does not duplicate fills', async () => {
  const f = await fixture();
  try {
    await f.engine.mutex.run(() => f.engine.enter(f.prepare()));
    assert.equal(f.engine.observability.counts.riskApproved, 1);
    assert.equal(f.engine.observability.counts.submissions, 1);
    assert.equal(f.engine.observability.counts.filledOrders, 0);
    f.advance(1000); await f.engine.onQuote(quote('SPY', f.now())); await f.engine.reconcile(); await f.engine.reconcile();
    assert.equal(f.engine.observability.counts.filledOrders, 1);
    assert.equal(f.store.eventsOfType('fill', 0).length, 1);
    assert.equal(f.store.journalSummary().filledBuys, 1);
  } finally { f.store.close(); }
});

test('activity cursors page without duplicates, filter categories, and omit credentials and market payloads', async () => {
  const f = await fixture();
  try {
    f.store.event('started', { mode: 'demo', token: 'secret-canary' }, f.now());
    let page = activityPage(f.engine, { limit: 1 }); const cursor = page.cursor;
    assert.doesNotMatch(JSON.stringify(page), /secret-canary/);
    for (let i = 0; i < 5; i++) f.store.event('candidate_detected', { symbol: 'SPY', candidateId: String(i), strategy: 'range_breakout', price: 100 }, f.now());
    f.store.event('market_sample', { secret: 'market-canary' }, f.now());
    page = activityPage(f.engine, { after: cursor, category: 'decisions', symbol: 'SPY', limit: 2 });
    const ids = new Set(page.events.map(e => e.id)); assert.equal(page.hasMore, true);
    const next = activityPage(f.engine, { after: page.cursor, category: 'decisions', symbol: 'SPY', limit: 10 });
    assert.equal(next.events.length, 3); assert.equal(next.events.some(e => ids.has(e.id)), false);
    assert.equal(activityPage(f.engine, { after: next.cursor, category: 'decisions', symbol: 'SPY' }).events.length, 0);
    assert.equal(activityPage(f.engine, { after: 999999999 }).reset, true);
    assert.throws(() => activityPage(f.engine, { category: "orders'); DROP TABLE orders;--" }));
    assert.doesNotMatch(JSON.stringify(activityPage(f.engine, {})), /market-canary|secret-canary/);
  } finally { f.store.close(); }
});

test('decision telemetry and log APIs require authentication and validate query bounds', async () => {
  const f = await fixture(), server = createDashboard(f.engine, f.cfg); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`, headers = { Authorization: `Bearer ${f.cfg.token}` };
  try {
    assert.equal((await fetch(base + '/api/insights?symbol=SPY')).status, 401);
    assert.equal((await fetch(base + '/api/activity')).status, 401);
    assert.equal((await fetch(base + '/api/insights?symbol=UNKNOWN', { headers })).status, 400);
    for (const query of ['after=-1', 'after=abc', 'limit=100000', 'category=private', 'symbol=UNKNOWN']) assert.equal((await fetch(base + '/api/activity?' + query, { headers })).status, 400);
    const d = await (await fetch(base + '/api/insights?symbol=SPY', { headers })).json();
    assert.equal(d.jev.state, 'OFF'); assert.equal(d.counts.modelRequests, 0); assert.ok(d.note.includes('not a Jev request'));
    assert.equal(f.store.orders().length, 0);
  } finally { await new Promise(resolve => server.close(resolve)); f.store.close(); }
});
