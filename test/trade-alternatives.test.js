import test from 'node:test';
import assert from 'node:assert/strict';
import { freshAlternatives, advanceAlternatives, alternativesSummary, TradeAlternatives, ALTERNATIVES_HASH } from '../src/trade-alternatives.js';
import { ALTERNATIVES_POLICY as A } from '../src/trade-alternatives-policy.js';
import { OptionsLab } from '../src/options-lab.js';
import { OptionsData, normalizeStockEligibility } from '../src/options-data.js';
import { Store } from '../src/store.js';
import { Mutex } from '../src/util.js';
import { fixture } from './helpers.js';
import { config } from '../src/config.js';
import { createDashboard } from '../src/server.js';
import { alternativesHtml } from '../public/trade-alternatives.js';

const start = Date.parse('2026-09-28T15:00:00Z');
function frame(bear = false) {
  const now = start, type = bear ? 'put' : 'call', expiry = '2026-10-12';
  const contract = strike => ({ symbol: `SPY261012${bear ? 'P' : 'C'}${String(strike * 1000).padStart(8, '0')}`,
    underlying: 'SPY', root: 'SPY', expiry, type, style: 'american', status: 'active', tradable: true,
    strike, multiplier: 100, size: 100, openInterest: 1000, oiDate: '2026-09-25',
    deliverables: [{ type: 'equity', symbol: 'SPY', amount: '100', allocation_percentage: '100', delayed_settlement: false }] });
  const long = contract(bear ? 101 : 100), short = contract(bear ? 100 : 101);
  const quote = (bid, delta) => ({ bid, ask: bid + .02, bidSize: 100, askSize: 100, condition: ' ', ts: now, delta, iv: .25 });
  return { now, source: 'alpaca_opra', stockFeed: 'sip', clockUncertaintyMs: 50, marketOpen: true, universe: ['SPY'],
    session: { date: '2026-09-28', open: start - 5400000, close: start + 18000000 },
    spots: { SPY: { price: 100.2, bid: 100.19, ask: 100.21, bidSize: 100, askSize: 100, ts: now } },
    assets: { SPY: { at: now, status: 'active', tradable: true, shortable: true, easyToBorrow: true } },
    contexts: { SPY: { intradayReady: true, barEnd: now - 1000, close: bear ? 99 : 102, rangeHigh: bear ? 101 : 100.1, rangeLow: bear ? 100.3 : 99, vwap: bear ? 100.5 : 100,
      through: Date.parse('2026-09-25T04:00Z'), rv20: .15, sma20: 99, sma50: 98, previousClose: 100 } },
    contracts: { [long.symbol]: long, [short.symbol]: short }, quotes: { [long.symbol]: quote(1.5, bear ? -.55 : .55), [short.symbol]: quote(1, bear ? -.2 : .4) } };
}
function later(f, seconds = 30) {
  const n = structuredClone(f); n.now += seconds * 1000;
  for (const q of [...Object.values(n.spots), ...Object.values(n.quotes)]) q.ts = n.now;
  for (const a of Object.values(n.assets)) a.at = n.now;
  return n;
}
const route = (s, id) => s.cohorts[0].routes.find(r => r.id === id);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);

test('independent bullish/bearish theses; options, no-trade and forecast requirement recorded', () => {
  for (const bear of [false, true]) {
    const s = freshAlternatives(); const events = advanceAlternatives(s, frame(bear));
    assert.equal(route(s, bear ? 'stock_short' : 'stock_long').state, 'pending');
    assert.equal(route(s, bear ? 'stock_long' : 'stock_short').reason, 'directional_thesis_not_confirmed');
    assert.equal(route(s, bear ? 'put_debit' : 'call_debit').state, 'pending');
    assert.equal(route(s, 'long_volatility').reason, 'forward_volatility_forecast_unavailable');
    assert.equal(route(s, 'no_trade').net, 0); assert.equal(events[0].type, 'trade_alternatives_decision');
    assert.ok(s.cohorts[0].routes.every(r => !r.kind || r.risk <= A.risk));
  }
});
test('unknown, stale, hard-to-borrow assets cannot produce a short', () => {
  for (const mutate of [f => delete f.assets.SPY, f => f.assets.SPY.easyToBorrow = false, f => f.assets.SPY.shortable = false, f => f.assets.SPY.at -= 900001]) {
    const f = frame(true); mutate(f); const s = freshAlternatives(); advanceAlternatives(s, f);
    assert.equal(route(s, 'stock_short').state, 'unavailable');
  }
});
test('same-frame or pre-decision leg quotes never fill; limits are not chased', () => {
  const f = frame(), s = freshAlternatives(); advanceAlternatives(s, f); advanceAlternatives(s, f);
  assert.equal(route(s, 'stock_long').state, 'pending');
  const n = later(f, 2); Object.values(n.quotes)[0].ts = start;
  n.spots.SPY.bid += .1; n.spots.SPY.ask += .1;
  advanceAlternatives(s, n);
  assert.equal(route(s, 'stock_long').state, 'pending'); assert.equal(route(s, 'call_debit').state, 'pending');
  advanceAlternatives(s, later(f)); assert.equal(route(s, 'stock_long').state, 'open'); assert.equal(route(s, 'call_debit').state, 'open');
});
test('short sells at bid then buys ask; gap losses and both sides of costs are realized on later quotes', () => {
  const f = frame(true), s = freshAlternatives(); advanceAlternatives(s, f); advanceAlternatives(s, later(f));
  const r = route(s, 'stock_short'); near(r.entry, f.spots.SPY.bid * .9997);
  const n = later(f, 60); n.spots.SPY.bid = 103; n.spots.SPY.ask = 103.02;
  advanceAlternatives(s, n); assert.equal(r.state, 'exiting'); assert.equal(r.net, null);
  const end = later(n); advanceAlternatives(s, end);
  const exit = 103.02 * 1.0003, fees = (r.entry + exit) * r.quantity * .0001;
  near(r.net, (r.entry - exit) * r.quantity - fees); assert.ok(r.net < -r.risk); assert.equal(r.reason, 'stop');
});
test('matched horizon uses subsequent exit quotes, includes four option-side fees and no-trade baseline', () => {
  const f = frame(), s = freshAlternatives(); advanceAlternatives(s, f); advanceAlternatives(s, later(f));
  for (let seconds = 60; seconds <= 1800; seconds += 30) advanceAlternatives(s, later(f, seconds));
  assert.equal(route(s, 'call_debit').state, 'exiting');
  advanceAlternatives(s, later(f, 1830));
  const option = route(s, 'call_debit'); assert.equal(option.state, 'closed'); near(option.net, -8.4); near(option.fees, .4);
  const p = alternativesSummary(s).pairs.find(p => p.a === 'stock_long' && p.b === 'call_debit'); assert.equal(p.count, 1);
  const baseline = alternativesSummary(s).pairs.find(p => p.a === 'call_debit' && p.b === 'no_trade'); near(baseline.netDifference, -8.4);
});
test('capture gaps, bad clock and missing per-route quotes leave unknown P/L, never zero', () => {
  for (const kind of ['gap', 'clock', 'quote']) {
    const f = frame(), s = freshAlternatives(); advanceAlternatives(s, f); advanceAlternatives(s, later(f));
    if (kind === 'gap') advanceAlternatives(s, later(f, 121), false);
    if (kind === 'clock') advanceAlternatives(s, { ...later(f, 60), clockUncertaintyMs: 1001 });
    if (kind === 'quote') for (const seconds of [60, 90, 120, 150]) { const n = later(f, seconds); n.quotes = {}; advanceAlternatives(s, n, false); }
    assert.equal(route(s, 'call_debit').state, 'incomplete'); assert.equal(route(s, 'call_debit').net, null);
    assert.equal(alternativesSummary(s).pairs.filter(p => p.a === 'call_debit' || p.b === 'call_debit').length, 0);
  }
});
test('no overlap, no repeated bar decision, and paused mode opens no new observations', () => {
  const f = frame(), s = freshAlternatives(); advanceAlternatives(s, f, false); assert.equal(s.cohorts.length, 0);
  advanceAlternatives(s, f); const n = later(f); n.contexts.SPY.barEnd = n.now - 1000; advanceAlternatives(s, n);
  assert.equal(s.cohorts.length, 1);
});
test('restart invalidates observations, persists audit events and never calls a broker', () => {
  const store = new Store(':memory:');
  try {
    const cfg = { mode: 'paper', tradeAlternatives: 'shadow' }, first = new TradeAlternatives(cfg, store), f = frame();
    first.observe(f); first.observe(later(f)); const second = new TradeAlternatives(cfg, store);
    second.observe(later(f, 60), false);
    assert.equal(route(second.state, 'call_debit').reason, 'process_restarted');
    assert.equal(second.snapshot().executionEnabled, false); assert.equal(second.snapshot().validatedWinner, null);
    assert.equal(store.get(`tradeAlternatives:${ALTERNATIVES_HASH}`).cohorts.length, 1);
    const durable = store.get(`tradeAlternatives:${ALTERNATIVES_HASH}:cohort:${second.state.cohorts[0].id}`);
    assert.equal(durable.routes.find(r => r.id === 'call_debit').reason, 'process_restarted');
    assert.ok(store.events().some(e => e.type === 'trade_alternatives_fill'));
    store.prune(start + 86400000);
    assert.deepEqual(store.get(`tradeAlternatives:${ALTERNATIVES_HASH}:cohort:${durable.id}`), durable);
    assert.equal(new TradeAlternatives({ mode: 'live', tradeAlternatives: 'shadow' }, store).active, false);
  } finally { store.close(); }
});
test('comparison captures while prior Options Lab experiment stays preserved and blocked', async () => {
  const store = new Store(':memory:');
  try {
    const old = { codeHash: 'prior-experiment', positions: [], pending: [], trades: [] }; store.set('optionsLab', old);
    const engine = { cfg: { mode: 'paper', tradeAlternatives: 'shadow', dataDir: '/tmp/trade-alternatives-test' }, store, mutex: new Mutex(), clock: () => start, stopped: false };
    store.lease(Date.now()); engine.tradeAlternatives = new TradeAlternatives(engine.cfg, store);
    const lab = new OptionsLab(engine, { capture: async () => frame() }); lab.tape.flush = async () => {};
    assert.ok(lab.blocked); await lab.poll();
    assert.equal(engine.tradeAlternatives.state.cohorts.length, 1); assert.deepEqual(store.get('optionsLab'), old);
  } finally { store.close(); }
});
test('read-only adapter permits only the two eligibility lookups, never orders or other assets', async () => {
  const adapter = new OptionsData({ key: 'test', secret: 'test', fetchFn: async (_, opts) => { assert.equal(opts.method, 'GET'); return { ok: true, json: async () => ({}) }; } });
  await adapter.get('https://paper-api.alpaca.markets', '/v2/assets/SPY');
  for (const path of ['/v2/orders', '/v2/assets/TSLA']) await assert.rejects(adapter.get('https://paper-api.alpaca.markets', path), /read_only/);
});
test('provider borrow-status enum overrides legacy easy-to-borrow flag and unknown values fail closed', () => {
  const a = { symbol: 'SPY', status: 'active', tradable: true, shortable: true, easy_to_borrow: true };
  assert.equal(normalizeStockEligibility({ ...a, borrow_status: 'easy_to_borrow' }, start, 'SPY').easyToBorrow, true);
  for (const borrow_status of ['hard_to_borrow', 'unknown', '']) assert.equal(normalizeStockEligibility({ ...a, borrow_status }, start, 'SPY').easyToBorrow, false);
  assert.equal(normalizeStockEligibility(a, start, 'SPY').easyToBorrow, true);
  assert.equal(normalizeStockEligibility(a, start, 'QQQ').status, null);
});
test('warm capture reuses authenticated clock, calendar and assets without consuming reserved broker requests', async () => {
  const f = frame(), date = f.session.date, calls = [];
  const daily = Array.from({ length: 50 }, (_, i) => ({ t: new Date(start - (50 - i) * 86400000).toISOString().slice(0, 10) + 'T04:00:00Z', o: 100, h: 101, l: 99, c: 100, v: 1000 }));
  const calendar = [...daily.map(b => ({ date: b.t.slice(0, 10), open: '09:30', close: '16:00' })), { date, open: f.session.open, close: f.session.close }];
  const shared = { now: start, synchronized: true, uncertaintyMs: 50, marketOpen: true, calendar,
    assets: { SPY: { observedAt: start, status: 'active', tradable: true, shortable: true, borrow_status: 'easy_to_borrow' } } };
  const adapter = new OptionsData({ key: 'test', secret: 'test', now: () => start, providerContext: () => shared,
    fetchFn: async url => { calls.push(url); assert.ok(url.startsWith('https://data.alpaca.markets/')); return { ok: true, json: async () => url.includes('/quotes/latest') ?
      { quotes: { SPY: { bp: 100.19, ap: 100.21, bs: 100, as: 100, t: new Date(start).toISOString() } } } : { bars: [] } }; } });
  adapter.cache.set('SPY', { date, ts: start, low: 90, high: 110, daily, contracts: [] });
  adapter.budget.requests = Array(100).fill(Date.now());
  const captured = await adapter.capture(['SPY']);
  assert.equal(captured.assets.SPY.easyToBorrow, true); assert.equal(captured.clockUncertaintyMs, 50); assert.equal(captured.spots.SPY.bid, 100.19);
  assert.equal(adapter.budget.status().used, 100); assert.equal(calls.length, 3);
  shared.synchronized = false; await assert.rejects(adapter.capture(['SPY']), /options_clock_uncertain/); assert.equal(calls.length, 3);
});
test('dashboard endpoint requires authentication and UI escapes provider text', async () => {
  const { cfg, engine, store } = await fixture(); const server = createDashboard(engine, cfg);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/trade-alternatives`;
    assert.equal((await fetch(url)).status, 401);
    const data = await (await fetch(url, { headers: { Authorization: `Bearer ${cfg.token}` } })).json();
    assert.equal(data.executionEnabled, false);
    const html = alternativesHtml({ ...data, error: '<script>bad</script>' }); assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>'));
  } finally { await new Promise(resolve => server.close(resolve)); store.close(); }
});
test('configuration cannot enable comparisons in live mode', () => {
  assert.throws(() => config({ MODE: 'live', TRADE_ALTERNATIVES: 'shadow' }), /Trade alternatives/);
});
test('pause cancels pending entries and stale or crossed stock quotes cannot enter', () => {
  const f = frame(), s = freshAlternatives(); advanceAlternatives(s, f); advanceAlternatives(s, later(f), false);
  assert.equal(route(s, 'stock_long').reason, 'new_observations_paused');
  for (const patch of [{ ts: start - 5001 }, { ts: start + 1 }, { bidSize: 0 }, { bid: 101 }]) {
    const n = frame(); Object.assign(n.spots.SPY, patch); const state = freshAlternatives(); advanceAlternatives(state, n);
    assert.equal(route(state, 'stock_long').state, 'unavailable');
  }
});
test('expired original limit stays unfilled, and a closed session creates no decision', () => {
  const f = frame(), s = freshAlternatives(); advanceAlternatives(s, f);
  for (const seconds of [30, 60, 90, 120]) {
    const n = later(f, seconds); n.spots.SPY.bid += .1; n.spots.SPY.ask += .1;
    Object.values(n.quotes)[0].ask += .05; advanceAlternatives(s, n);
  }
  assert.equal(route(s, 'stock_long').state, 'unfilled'); assert.equal(route(s, 'call_debit').state, 'unfilled');
  const closed = freshAlternatives(); advanceAlternatives(closed, { ...frame(), marketOpen: false }); assert.equal(closed.cohorts.length, 0);
});
test('experiment totals and matched evidence survive rolling retention without double counting', () => {
  const f = frame(), s = freshAlternatives(); advanceAlternatives(s, f);
  for (let seconds = 30; seconds <= 1830; seconds += 30) advanceAlternatives(s, later(f, seconds));
  const before = alternativesSummary(s).pairs.find(p => p.a === 'call_debit' && p.b === 'no_trade');
  for (let day = 1; day <= 12; day++) for (let bar = 0; bar < 20; bar++) {
    const n = later(f, day * 86400 + bar * 300); n.session.open += day * 86400000; n.session.close += day * 86400000;
    n.session.date = new Date(n.now).toISOString().slice(0, 10); n.contexts.SPY.barEnd = n.now - 1000; n.contexts.SPY.intradayReady = false;
    n.contracts = {}; n.quotes = {}; advanceAlternatives(s, n);
  }
  const summary = alternativesSummary(s);
  assert.equal(summary.retainedCohorts, A.maxCohorts); assert.equal(summary.totalCohorts, 241);
  assert.deepEqual(summary.pairs.find(p => p.a === 'call_debit' && p.b === 'no_trade'), before);
  assert.equal(summary.rows.find(r => r.id === 'call_debit').closed, 1);
});
