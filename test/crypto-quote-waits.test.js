import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { fixture, candidate, quote } from './helpers.js';
import { Engine } from '../src/engine.js';
import { CryptoContext } from '../src/crypto-context.js';
import { activityPage } from '../src/observability.js';

async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await turn(); }
  assert.fail('Expected asynchronous state was not reached');
}
async function setup(t) {
  const f = await fixture({ MODE: 'shadow', ALPACA_KEY: 'test', ALPACA_SECRET: 'test', CRYPTO_SYMBOLS: 'BTC/USD,ETH/USD' });
  t.after(async () => {
    f.engine.stopped = true; f.engine.cryptoQuoteWaits.cancel('engine_stopped');
    await until(() => f.engine.pendingCandidates === 0); f.store.close();
  });
  return f;
}
function start(f, cs = [candidate('BTC/USD', f.now())]) {
  for (const c of cs) f.engine.snapshots.set(c.symbol, c.features);
  f.engine.workers = { ...f.engine.workers, evaluate: async () => cs };
  const task = f.engine.processCandidates({ symbol: cs[0].symbol }, [...new Set(cs.map(c => c.strategy))]);
  return { task, c: cs[0] };
}

test('stale crypto signal waits without reserving capital and one fresh quote submits at most once', async t => {
  const f = await setup(t);
  const { task, c } = start(f);
  await until(() => f.engine.cryptoQuoteWaits.snapshot().waiting === 1);
  assert.equal(f.store.orders().length, 0); assert.equal(f.engine.observability.counts.riskRejected, 0);
  assert.equal(f.store.getCandidate(c.id).status, 'waiting_for_quote');
  assert.match(f.engine.observability.snapshot('BTC/USD').why, /waiting for a fresh quote/);
  const events = activityPage(f.engine, { category: 'decisions' }).events;
  assert.equal(events.filter(e => e.type === 'candidate_waiting').length, 1);
  assert.equal(events.find(e => e.type === 'candidate_waiting').data.expires, c.expires);
  f.advance(2000);
  for (let i = 0; i < 10; i++) await f.engine.onQuote(quote('BTC/USD', f.now()));
  await task;
  assert.equal(f.store.orders().filter(o => o.kind === 'entry').length, 1);
  assert.equal(f.store.getCandidate(c.id).status, 'approved');
  assert.equal(c.expires, c.ts + 10000);
  assert.equal(f.engine.cryptoQuoteWaits.snapshot().waiting, 0);
  assert.equal(f.engine.cryptoQuoteWaits.snapshot().waited, 1);
  assert.equal(f.engine.cryptoQuoteWaits.snapshot().approved, 1);
  await f.engine.processCandidates({ symbol: c.symbol }, ['range_breakout']);
  assert.equal(f.store.orders().length, 1);
  assert.equal(f.engine.observability.crypto.detected, 1);
});

test('deadline timer expires a signal even when no quote arrives', async t => {
  const f = await setup(t); t.mock.timers.enable({ apis: ['setTimeout'] });
  const { task, c } = start(f);
  await until(() => f.engine.cryptoQuoteWaits.snapshot().waiting === 1);
  f.advance(10000); t.mock.timers.tick(10000); await task;
  assert.equal(f.store.getCandidate(c.id).reason, 'candidate_expired');
  assert.equal(f.engine.cryptoQuoteWaits.snapshot().expired, 1);
  await f.engine.onQuote(quote(c.symbol, f.now()));
  assert.equal(f.store.orders().length, 0);
});

test('a quote arriving exactly at expiry cannot revive the signal', async t => {
  const f = await setup(t), { task, c } = start(f);
  await until(() => f.engine.cryptoQuoteWaits.snapshot().waiting === 1);
  f.advance(10000); await f.engine.onQuote(quote(c.symbol, f.now())); await task;
  assert.equal(c.reason, 'candidate_expired'); assert.equal(f.store.orders().length, 0);
});

test('invalid and stale quotes do not wake a waiting signal', async t => {
  const f = await setup(t), { task, c } = start(f);
  await until(() => f.engine.cryptoQuoteWaits.snapshot().waiting === 1);
  await f.engine.onQuote(quote(c.symbol, f.now()-10000));
  await f.engine.onQuote({ ...quote(c.symbol, f.now()), bid: 101, ask: 100 });
  assert.equal(f.engine.cryptoQuoteWaits.snapshot().waiting, 1);
  assert.equal(f.store.orders().length, 0);
  await f.engine.onQuote(quote(c.symbol, f.now())); await task;
  assert.equal(c.status, 'approved');
});

test('a fresh quote arriving between preflight and wait registration is not lost', async t => {
  const f = await setup(t), check = f.engine.checkEntry.bind(f.engine); let inject = true;
  f.engine.checkEntry = c => {
    const decision = check(c);
    if (inject && decision.reason === 'stale_or_invalid_quote') {
      inject = false; f.engine.quotes.set(c.symbol, quote(c.symbol, f.now()));
    }
    return decision;
  };
  const { task, c } = start(f); await task;
  assert.equal(c.status, 'approved'); assert.equal(f.engine.cryptoQuoteWaits.snapshot().waiting, 0);
});

for (const [name, change, expected, counter] of [
  ['spread', f => f.engine.quotes.set('BTC/USD', { ...quote('BTC/USD', f.now()), bid: 99.8, ask: 100.2 }), 'spread_limit', 'spreadBlocked'],
  ['cost', (f, c) => { c.target = 100.5; }, 'reward_does_not_clear_cost_buffer', 'costBlocked'],
  ['price movement', f => f.engine.quotes.set('BTC/USD', quote('BTC/USD', f.now(), 101)), 'price_moved', 'otherBlocked'],
  ['new feature snapshot', f => f.engine.snapshots.set('BTC/USD', { version: 'new' }), 'superseded_snapshot', 'otherBlocked'],
  ['broker budget', f => { f.broker.entryBudgetAvailable = () => false; }, 'broker_request_budget', 'otherBlocked'],
  ['top-25 eligibility', f => { f.engine.cryptoUniverse = { allowed: () => false }; }, 'crypto_rank_unavailable_or_outside_top25', 'otherBlocked'],
  ['account age', f => { f.engine.account.ts -= 16000; }, 'account_not_ready', 'otherBlocked'],
  ['allocation', f => { f.engine.account.cash = 0; }, 'insufficient_capacity_or_lot_size', 'otherBlocked'],
]) test(`fresh quote rechecks ${name} instead of granting approval`, async t => {
  const f = await setup(t), { task, c } = start(f);
  await until(() => f.engine.cryptoQuoteWaits.snapshot().waiting === 1);
  f.engine.quotes.set(c.symbol, quote(c.symbol, f.now())); change(f, c);
  f.engine.cryptoQuoteWaits.onQuote(c.symbol); await task;
  assert.equal(c.reason, expected); assert.equal(f.store.orders().length, 0);
  assert.equal(f.engine.cryptoQuoteWaits.snapshot()[counter], 1);
});

test('pause cancels waits and resume cannot resurrect them', async t => {
  const f = await setup(t), { task, c } = start(f);
  await until(() => f.engine.cryptoQuoteWaits.snapshot().waiting === 1);
  await f.engine.control('pause'); await task; await f.engine.control('resume');
  await f.engine.onQuote(quote(c.symbol, f.now()));
  assert.equal(c.reason, 'entries_paused'); assert.equal(f.store.orders().length, 0);
});

test('strategy disable and immediate re-enable invalidates the original generation', async t => {
  const f = await setup(t), { task, c } = start(f);
  await until(() => f.engine.cryptoQuoteWaits.snapshot().waiting === 1);
  await f.engine.strategyControls.update({ strategy: c.strategy, enabled: false, expectedRevision: 0 });
  await f.engine.strategyControls.update({ strategy: c.strategy, enabled: true, expectedRevision: 1 });
  await task; await f.engine.onQuote(quote(c.symbol, f.now()));
  assert.equal(c.reason, 'strategy_selection_changed'); assert.equal(f.store.orders().length, 0);
});

test('a quote aging during Jev evaluation waits within the same deadline without paying twice', async t => {
  const f = await setup(t); let calls = 0;
  await f.engine.onQuote(quote('BTC/USD', f.now()));
  f.engine.jev.evaluate = async () => { calls++; f.advance(6000); return { pass: true, requested: true, latencyMs: 6000, quality: .9 }; };
  const { task, c } = start(f);
  await until(() => f.engine.cryptoQuoteWaits.snapshot().waiting === 1);
  assert.equal(c.expires-f.now(), 4000);
  await f.engine.onQuote(quote(c.symbol, f.now())); await task;
  assert.equal(calls, 1); assert.equal(c.status, 'approved');
  assert.equal(f.store.eventsOfType('model_result', 0).length, 1);
});

test('one crypto waiter does not stall another candidate with a fresh quote', async t => {
  const f = await setup(t); await f.engine.onQuote(quote('ETH/USD', f.now()));
  const cs = [candidate('BTC/USD', f.now(), 'btc'), candidate('ETH/USD', f.now(), 'eth')];
  const { task } = start(f, cs);
  await until(() => cs[1].status === 'approved');
  assert.equal(f.engine.cryptoQuoteWaits.snapshot().waiting, 1);
  assert.equal(f.store.orders()[0].symbol, 'ETH/USD');
  f.engine.cryptoQuoteWaits.cancel('engine_stopped'); await task;
});

test('crypto context dispatch does not delay later symbols behind a quote waiter', async () => {
  const visited = []; let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const engine = { cfg: { crypto: ['BTC/USD','ETH/USD'], cryptoLocation: 'us' }, clock: () => 1800000003000,
    onCryptoHistory: async symbol => { visited.push(symbol); if (symbol === 'BTC/USD') await blocked; }, store: { event() {} } };
  const context = new CryptoContext(engine, async () => ({ ok: true, json: async () => ({ bars: {} }) }));
  const task = context.poll(); await until(() => visited.length === 2); release(); await task;
  assert.equal(engine.cryptoContextStatus.state, 'ready');
});

test('two strategies waking on one quote still share the symbol and portfolio gates', async t => {
  const f = await setup(t);
  const cs = [candidate('BTC/USD', f.now(), 'breakout'), { ...candidate('BTC/USD', f.now(), 'pullback'), strategy: 'trend_pullback' }];
  const { task } = start(f, cs);
  await until(() => f.engine.cryptoQuoteWaits.snapshot().waiting === 2);
  await f.engine.onQuote(quote('BTC/USD', f.now())); await task;
  assert.equal(f.store.orders().filter(o => o.kind === 'entry').length, 1);
  assert.equal(cs.filter(c => c.status === 'approved').length, 1);
  assert.equal(cs.filter(c => c.reason === 'symbol_cooldown').length, 1);
});

test('the wait set is bounded and cancellation releases every promise', async t => {
  const f = await setup(t), waits = [];
  for (let i = 0; i < 100; i++) {
    const c = candidate('BTC/USD', f.now(), `queued-${i}`); f.store.candidate(c);
    waits.push(f.engine.cryptoQuoteWaits.wait(c));
  }
  assert.equal(await f.engine.cryptoQuoteWaits.wait(candidate('BTC/USD', f.now(), 'overflow')), 'crypto_quote_wait_capacity');
  f.engine.cryptoQuoteWaits.cancel('engine_stopped');
  assert.ok((await Promise.all(waits)).every(reason => reason === 'engine_stopped'));
  assert.equal(f.engine.cryptoQuoteWaits.snapshot().waiting, 0);
});

test('equity stale-quote behavior is unchanged', async t => {
  const f = await setup(t), { task, c } = start(f, [candidate('SPY', f.now())]); await task;
  assert.equal(c.reason, 'stale_or_invalid_quote'); assert.equal(f.engine.cryptoQuoteWaits.snapshot().waiting, 0);
});

test('restart rejects journaled waits and does not replay orders', async t => {
  const f = await setup(t), c = { ...candidate('BTC/USD', f.now()), status: 'waiting_for_quote' };
  f.store.candidate(c);
  const restarted = new Engine(f.cfg, f.store, f.broker, f.engine.workers, f.now); await restarted.init();
  assert.equal(f.store.getCandidate(c.id).reason, 'crypto_wait_interrupted');
  await restarted.onQuote(quote(c.symbol, f.now())); assert.equal(f.store.orders().length, 0);
});

test('shutdown releases all waiters without an order', async t => {
  const f = await setup(t), { task, c } = start(f);
  await until(() => f.engine.cryptoQuoteWaits.snapshot().waiting === 1);
  f.engine.stopped = true; f.engine.cryptoQuoteWaits.cancel('engine_stopped'); await task;
  assert.equal(c.reason, 'engine_stopped'); assert.equal(f.engine.pendingCandidates, 0); assert.equal(f.store.orders().length, 0);
});
