import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { createDashboard } from '../src/server.js';
import { testConfig, fixture, quote } from './helpers.js';
import { tradeCampaigns, recordTradeMarks, tradePerformanceData, thinTradeMarks } from '../src/trade-performance.js';

const T = Date.parse('2026-09-25T15:00:00Z');
const entry = (patch = {}) => ({ id: 'buy-1', symbol: 'SPY', kind: 'entry', strategy: 'range_breakout', status: 'filled', ts: T - 60000, filledAt: T - 59000, filledQty: 10, fillPrice: 100, fee: 1, feeRateBps: 10, ...patch });
const exit = (patch = {}) => ({ id: 'sell-1', brokerId: 'broker-sell', entryId: 'buy-1', symbol: 'SPY', kind: 'exit', status: 'filled', ts: T - 1000, filledAt: T, filledQty: 10, fillPrice: 104, fee: 1.04, ...patch });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
function harness(t) {
  const store = new Store(); t.after(() => store.close());
  const e = { store, cfg: { ...testConfig(), mode: 'paper' }, clock: () => T, quotes: new Map([['SPY', { symbol: 'SPY', ts: T, bid: 101, ask: 101.02 }]]),
    lastReconcile: Date.now(), issues: [], portfolio: { state: { valid: true, conflicts: [] } }, managed: { SPY: { entryId: 'buy-1' } }, positions: [{ symbol: 'SPY', qty: 10 }] };
  return e;
}

test('open return uses bid, entry costs and estimated exit fees; orders are not positions', t => {
  const e = harness(t); e.store.order(entry()); e.store.order(entry({ id: 'unfilled', filledQty: 0, status: 'accepted' }));
  const [r] = tradeCampaigns(e);
  assert.equal(tradeCampaigns(e).length, 1); assert.equal(r.status, 'active');
  near(r.net, 7.99); near(r.returnPct, 7.99 / 1001 * 100); near(r.estimatedExitFees, 1.01);
  e.quotes.get('SPY').bid = 99; near(tradeCampaigns(e)[0].net, -11.99);
});

test('closed gains and losses use actual fills and de-duplicate bracket exits', t => {
  const e = harness(t), close = exit();
  e.store.order(entry({ legs: [close] })); e.store.order(close);
  let r = tradeCampaigns(e)[0]; assert.equal(r.status, 'closed'); near(r.net, 37.96); near(r.returnPct, 37.96 / 1001 * 100);
  assert.equal(r.fills.length, 2); assert.equal(r.closedAt, T);
  e.quotes.clear(); e.lastReconcile = 0; e.portfolio.state.valid = false;
  assert.equal(tradeCampaigns(e)[0].net, r.net, 'closed fills need no current quote');
  const losing = exit({ fillPrice: 98, fee: .98 }); e.store.order(entry({ legs: [losing] })); e.store.order(losing);
  r = tradeCampaigns(e)[0]; near(r.net, -21.98); assert.ok(r.returnPct < 0);
});

test('scale-ins form one campaign and retain partial-exit profit in total return', t => {
  const e = harness(t);
  e.store.order(entry({ addPolicy: { enabled: true } }));
  e.store.order(entry({ id: 'add-1', addition: true, campaignId: 'buy-1', filledQty: 2, fillPrice: 110, fee: .22, filledAt: T - 30000 }));
  e.store.order(exit({ filledQty: 4, fillPrice: 105, fee: .42 }));
  e.positions[0].qty = 8; e.quotes.get('SPY').bid = 115; e.quotes.get('SPY').ask = 115.02;
  let rows = tradeCampaigns(e), r = rows[0];
  assert.equal(rows.length, 1); assert.equal(r.qty, 8); assert.equal(r.boughtQty, 12); assert.equal(r.soldQty, 4);
  near(r.capital, 1221.22); near(r.net, 117.44); near(r.returnPct, 117.44 / 1221.22 * 100);
  e.store.order(exit({ id: 'sell-2', brokerId: 'broker-2', filledQty: 6, fillPrice: 98, fee: .588 }));
  e.store.order(exit({ id: 'sell-add', brokerId: 'broker-add', entryId: 'add-1', filledQty: 2, fillPrice: 120, fee: .24 }));
  r = tradeCampaigns(e)[0]; assert.equal(r.status, 'closed'); near(r.net, 25.532);
  e.store.order(entry({ id: 'other', filledAt: T - 20000 }));
  assert.equal(tradeCampaigns(e).length, 2, 'a new trade in the same ticker is separate');
});

test('unknown fill times are never replaced with order intent timestamps', t => {
  const e = harness(t); e.store.order(entry({ filledAt: null })); e.store.order(exit({ filledAt: null }));
  const [r] = tradePerformanceData(e).trades;
  assert.equal(r.entryAt, null); assert.equal(r.closedAt, null); assert.equal(r.asOf, null); assert.equal(r.points.length, 0); assert.ok(r.returnPct > 0);
  e.store.order(entry({ filledAt: null, lastFillObservedAt: T - 10000 }));
  assert.equal(tradeCampaigns(e)[0].entryAt, T - 10000); assert.equal(tradeCampaigns(e)[0].entryTimeSource, 'first observed fill');
});

test('late broker exit reports remove observations beyond the actual exit time', t => {
  const e = harness(t); e.store.order(entry());
  e.store.tradeMark('buy-1', { ts: T - 1000, returnPct: 3 }); e.store.tradeMark('buy-1', { ts: T + 1000, returnPct: 4 });
  e.store.order(exit()); e.clock = () => T + 2000;
  assert.deepEqual(tradePerformanceData(e).trades[0].points.map(p => p.ts), [T - 1000]);
});

test('entry anchor keeps the first observed partial fill when a later fill completes', t => {
  const e = harness(t); e.store.order(entry({ firstFillObservedAt: T - 58000, filledAt: T - 1000 }));
  const r = tradeCampaigns(e)[0]; assert.equal(r.entryAt, T - 58000); assert.equal(r.entryTimeSource, 'first observed entry fill');
  assert.equal(r.fills[0].ts, T - 1000, 'the cumulative fill record still has its own completion time');
});

test('stale quotes, stale reconciliation and quantity conflicts cannot appear as current profit', t => {
  const e = harness(t); e.store.order(entry()); recordTradeMarks(e);
  e.quotes.get('SPY').ts = T - 100000;
  let r = tradePerformanceData(e).trades[0]; assert.equal(r.returnPct, null); assert.equal(r.asOf, null); assert.ok(r.points[0].returnPct > 0);
  e.quotes.get('SPY').ts = T; e.lastReconcile = Date.now() - 60000;
  assert.equal(tradeCampaigns(e)[0].returnPct, null);
  e.lastReconcile = Date.now(); e.positions[0].qty = 11;
  assert.equal(tradeCampaigns(e)[0].returnPct, null);
  e.positions[0].qty = 10; e.portfolio.state.conflicts = ['SPY'];
  assert.equal(tradeCampaigns(e)[0].returnPct, null);
});

test('invalid executions and orphan additions are unpriced, not wins', t => {
  const e = harness(t); e.store.order(entry()); e.store.order(exit({ filledQty: 11 }));
  let r = tradeCampaigns(e)[0]; assert.equal(r.returnPct, null); assert.match(r.reason, /exceeds/);
  e.store.order(exit({ replacedBy: 'new-order' })); assert.match(tradeCampaigns(e)[0].reason, /Replaced/);
  e.store.order(entry({ id: 'orphan', addition: true, campaignId: 'missing-root' }));
  assert.equal(tradeCampaigns(e).find(r => r.id === 'missing-root').returnPct, null);
});

test('sampling is bounded, durable across restarts and pruned independently of fills', t => {
  const e = harness(t), dir = mkdtempSync(join(tmpdir(), 'trade-marks-')), file = join(dir, 'journal.sqlite');
  const original = e.store; e.store = new Store(file);
  try {
    e.store.order(entry()); recordTradeMarks(e); recordTradeMarks(e);
    assert.equal(e.store.tradeMarks('buy-1', 0, T).length, 1);
    e.clock = () => T + 10001; e.quotes.get('SPY').ts = T + 10001; recordTradeMarks(e);
    assert.equal(e.store.tradeMarks('buy-1', 0, T + 20000).length, 2);
    e.store.close(); e.store = new Store(file);
    assert.equal(e.store.tradeMarks('buy-1', 0, T + 20000).length, 2);
    e.store.prune(T + 1); assert.equal(e.store.tradeMarks('buy-1', 0, T + 20000).length, 1); assert.equal(e.store.orders().length, 1);
  } finally { e.store.close(); e.store = original; rmSync(dir, { recursive: true, force: true }); }
});

test('chart reads do not record history and bounds retain older active positions', t => {
  const e = harness(t); e.store.order(entry({ ts: T - 40 * 86400000, filledAt: T - 40 * 86400000 + 1000 }));
  const data = tradePerformanceData(e); assert.equal(data.trades.length, 1); assert.ok(data.trades[0].entryAt < data.since);
  assert.equal(e.store.tradeMarks('buy-1', 0, T).length, 0); assert.throws(() => tradePerformanceData(e, 9999));
  for (let i = 0; i < 105; i++) {
    e.store.order(entry({ id: `old-${i}` })); e.store.order(exit({ id: `sold-${i}`, brokerId: `s-${i}`, entryId: `old-${i}` }));
  }
  const many = tradePerformanceData(e); assert.equal(many.trades.length, 100); assert.equal(many.total, 106); assert.equal(many.truncated, true); assert.equal(many.trades[0].id, 'buy-1');
});

test('thinning retains the profit peak, trough and gaps', () => {
  const points = Array.from({ length: 2000 }, (_, i) => ({ ts: T + i * 10000 + (i >= 501 ? 120000 : 0), returnPct: i === 407 ? 9 : i === 1314 ? -4 : .1 }));
  const thinned = thinTradeMarks(points);
  assert.ok(thinned.some(p => p.returnPct === 9)); assert.ok(thinned.some(p => p.returnPct === -4));
  assert.ok(thinned.some(p => p.ts === points[501].ts && p.breakBefore)); assert.equal(thinned[0].ts, points[0].ts); assert.equal(thinned.at(-1).ts, points.at(-1).ts);
  assert.ok(thinned.length < 340);
});

test('authenticated API and static assets are wired; unsupported ranges are rejected', async t => {
  const e = harness(t), server = createDashboard(e, e.cfg); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`, headers = { Authorization: `Bearer ${e.cfg.token}` };
  try {
    assert.equal((await fetch(base + '/api/trade-performance')).status, 401);
    assert.equal((await fetch(base + '/api/trade-performance?days=0', { headers })).status, 400);
    const response = await fetch(base + '/api/trade-performance?days=7', { headers }); assert.equal(response.status, 200); assert.equal((await response.json()).days, 7);
    assert.match(await (await fetch(base + '/trade-performance.js')).text(), /class TradePerformanceView/);
    assert.match(await (await fetch(base + '/trade-performance.css')).text(), /return-surface/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('engine reconciliation records return observations without enabling entries', async () => {
  const f = await fixture();
  try {
    await f.engine.mutex.run(() => f.engine.enter(f.prepare()));
    f.advance(1000); await f.engine.onQuote(quote('SPY', f.now())); await f.engine.reconcile();
    f.advance(10000); await f.engine.onQuote(quote('SPY', f.now())); await f.engine.reconcile();
    const data = tradePerformanceData(f.engine); assert.equal(data.trades.length, 1);
    assert.equal(f.store.orders()[0].firstFillObservedAt, f.now() - 10000);
    assert.ok(data.trades[0].points.length > 0); assert.ok(Number.isFinite(data.trades[0].returnPct));
    f.engine.operatorPause = true; const count = f.store.orders().length;
    f.advance(11000); await f.engine.onQuote(quote('SPY', f.now(), 100.1)); await f.engine.reconcile();
    assert.equal(f.store.orders().length, count); assert.ok(tradePerformanceData(f.engine).trades[0].points.length >= 2);
    f.store.tradeMark = () => { throw new Error('simulated chart storage failure'); };
    f.advance(11000); await f.engine.onQuote(quote('SPY', f.now(), 100.1)); await f.engine.reconcile();
    assert.equal(f.engine.protection.state, 'reconciled'); assert.match(tradePerformanceData(f.engine).recordingError, /could not be saved/);
  } finally { f.engine.stopped = true; clearTimeout(f.engine.streamReconcile); await f.engine.mutex.tail; f.store.close(); }
});
