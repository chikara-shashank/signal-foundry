import test from 'node:test';
import assert from 'node:assert/strict';
import { AlpacaFeed } from '../src/feeds.js';
import { StockHistory } from '../src/stock-history.js';
import { BrokerError } from '../src/broker.js';
import { faultDetail } from '../src/util.js';
import { fixture } from './helpers.js';

const start = Date.parse('2026-09-22T13:00:00Z');
const bar = (i, symbol = 'SPY') => ({ kind: 'bar', symbol, ts: start + i * 60000, open: 100 + i * .01, high: 100.2 + i * .01, low: 99.9 + i * .01, close: 100.1 + i * .01, volume: 1000 });
const row = b => ({ t: new Date(b.ts).toISOString(), o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume });
function provider(count = 120) {
  const requests = [];
  const fetchFn = async url => {
    const q = new URL(url).searchParams, from = Date.parse(q.get('start')), to = Date.parse(q.get('end')), bars = {};
    requests.push(q);
    for (const symbol of q.get('symbols').split(',')) bars[symbol] = Array.from({ length: count }, (_, i) => bar(i, symbol)).filter(b => b.ts >= from && b.ts <= to).map(row);
    return { ok: true, status: 200, json: async () => ({ bars, next_page_token: null }) };
  };
  return { requests, fetchFn };
}
const backfills = f => f.store.events(200).filter(e => e.type === 'bar_backfill').map(e => e.data);

test('feed backoff escalates only across consecutive failures and resets after a healthy session', async () => {
  const f = await fixture(), delays = []; let t = 1e12, calls = 0;
  const feed = new AlpacaFeed('equities', 'wss://test', ['SPY'], f.cfg, f.engine, undefined, async ms => { delays.push(ms); if (delays.length === 9) feed.stop(); });
  feed.now = () => t;
  feed.connect = async () => {
    calls++;
    // The eighth session subscribes and streams for 31 seconds before the server closes it.
    if (calls === 8) { feed.sessionError = null; feed.streamedAt = t; t += 31000; return; }
    feed.sessionError = 'connection_error'; throw new Error('connection_error');
  };
  try {
    await feed.run();
    const base = delays.map(d => Math.floor(d / 1000) * 1000);
    assert.deepEqual(base, [2000, 4000, 8000, 16000, 32000, 60000, 60000, 2000, 4000]);
    assert.ok(delays.every((d, i) => d - base[i] < 500));
    const events = f.store.events(20).filter(e => e.type === 'feed_disconnect').map(e => e.data);
    assert.equal(events.length, 9); assert.equal(events.at(-1).reconnects, 1);
    assert.equal(events.find(e => e.reconnects === 8).reason, 'closed_unknown'); assert.equal(events.find(e => e.reconnects === 8).streamedMs, 31000);
    assert.equal(f.engine.feeds.equities.reconnects, 9);
  } finally { f.store.close(); }
});

test('a streamed minute gap is repaired from provider bars before continuity is evaluated', async () => {
  const f = await fixture(), { requests, fetchFn } = provider();
  f.engine.stockHistory = new StockHistory(f.engine, fetchFn);
  try {
    for (let i = 0; i < 40; i++) await f.engine.onBar(bar(i));
    assert.equal(requests.length, 0);
    await f.engine.onBar(bar(43)); // Minutes 40-42 never arrived on the stream.
    assert.equal(requests.length, 1);
    assert.equal(requests[0].get('symbols'), 'SPY'); assert.equal(requests[0].get('timeframe'), '1Min'); assert.equal(requests[0].get('feed'), f.cfg.feed);
    const history = f.engine.features.history.get('SPY');
    assert.equal(history.length, 44); assert.ok(history.every((b, i) => b.ts === start + i * 60000));
    assert.equal(f.engine.snapshots.get('SPY').version, bar(43).ts);
    assert.equal(f.store.bars('SPY', 200).length, 44);
    assert.deepEqual(backfills(f).map(x => [x.kind, x.missing, x.bars]), [['gap', 3, 3]]);
    await f.engine.onBar(bar(44)); assert.equal(requests.length, 1); // Contiguous bars need no request.
  } finally { f.store.close(); }
});

test('unavailable provider history leaves the continuity reset in place and pauses retries', async () => {
  const f = await fixture(); let calls = 0;
  f.engine.stockHistory = new StockHistory(f.engine, async () => { calls++; return { ok: false, status: 403, json: async () => ({}) }; });
  try {
    for (let i = 0; i < 40; i++) await f.engine.onBar(bar(i));
    await f.engine.onBar(bar(43));
    assert.equal(calls, 1); assert.equal(f.engine.features.history.get('SPY').length, 1);
    assert.equal(backfills(f)[0].reason, 'stock_history_http_403');
    await f.engine.onBar(bar(46)); assert.equal(calls, 1);
  } finally { f.store.close(); }
});

test('warmup restores provider bars so a restart has context before the stream starts', async () => {
  const f = await fixture(), { requests, fetchFn } = provider();
  const history = new StockHistory(f.engine, fetchFn);
  try {
    assert.equal(f.engine.snapshots.get('SPY'), undefined);
    await history.warmup();
    assert.equal(requests.length, 1); assert.equal(requests[0].get('symbols'), 'SPY,QQQ');
    assert.equal(f.engine.features.history.get('SPY').length, 120);
    assert.equal(f.engine.snapshots.get('SPY').version, bar(119).ts); assert.ok(f.engine.snapshots.get('SPY').trend15 !== null);
    assert.equal(backfills(f)[0].bars, 240);
    await history.warmup(); assert.equal(backfills(f)[0].bars, 0); // Already-held bars are not duplicated.
  } finally { f.store.close(); }
});

test('fault events classify errors without URLs, bodies or credentials', async () => {
  assert.equal(faultDetail(new BrokerError(503)), 'broker_http_503');
  assert.equal(faultDetail(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })), 'TypeError:ECONNRESET');
  assert.equal(faultDetail(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), 'TimeoutError');
  assert.equal(faultDetail(new Error('https://paper-api.alpaca.markets/v2/account?key=secret-canary')), 'Error');
  const f = await fixture();
  try {
    f.broker.clock = async () => { throw new BrokerError(502); };
    await f.engine.reconcile();
    const fault = f.store.events(20).find(e => e.type === 'fault');
    assert.deepEqual(fault.data, { reason: 'broker_reconciliation_failed', detail: 'broker_http_502' });
    assert.equal(f.engine.ready, false);
  } finally { f.store.close(); }
});
