import test from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { TradeHistory, TimingWindow, createQuoteStream } from '../src/realtime.js';
import { parseFeedFrame, parseMessage, AlpacaFeed } from '../src/feeds.js';
import { AlpacaOrderFeed, orderObservation } from '../src/order-feed.js';
import { createDashboard } from '../src/server.js';
import { chartData } from '../src/telemetry.js';
import { fixture, quote, testConfig } from './helpers.js';
import { LiveQuotes } from '../public/live.js';
const t0 = Date.parse('2026-09-22T15:00:00Z');
const trade = (id, ms, price = 100, size = 1) => ({ kind: 'trade', symbol: 'SPY', ts: t0 + ms, stamp: new Date(t0 + ms).toISOString(), id: String(id), price, size, exchange: 'Q' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('trade-print candles use event order, exact volume and no invented empty seconds', () => {
  const h = new TradeHistory(['SPY']);
  h.apply(trade(1, 850, 105, 2), t0 + 1000); h.apply(trade(2, 150, 100, 3), t0 + 1000); h.apply(trade(3, 500, 98, 4), t0 + 1000);
  h.apply(trade(4, 2200, 104), t0 + 2300);
  const bars = h.bars('SPY', 1, t0 + 2300);
  assert.equal(bars.length, 2); assert.equal(bars[0].open, 100); assert.equal(bars[0].close, 105); assert.equal(bars[0].high, 105); assert.equal(bars[0].low, 98); assert.equal(bars[0].volume, 9);
  assert.equal(bars[0].partial, false); assert.equal(bars[1].partial, true);
  assert.deepEqual(bars.map(b => b.ts), [t0, t0 + 2000]);
  assert.equal(h.bars('SPY', 5, t0 + 5000)[0].volume, 10);
});

test('duplicate prints, invalid values, future and expired trades cannot corrupt OHLC', () => {
  const h = new TradeHistory(['SPY']);
  assert.equal(h.apply(trade(1, 100), t0 + 1000), true);
  assert.equal(h.apply(trade(1, 100), t0 + 1000), false);
  assert.equal(h.apply(trade(2, 100, Infinity), t0 + 1000), false);
  assert.equal(h.apply(trade(3, 5000), t0 + 1000), false);
  assert.equal(h.apply(trade(4, -4000000), t0 + 1000), false);
  assert.equal(h.bars('SPY', 1, t0 + 1000)[0].volume, 1);
});

test('corrections retain original event time, recompute extrema and cancellations remove empty bars', () => {
  const h = new TradeHistory(['SPY']);
  h.apply(trade(1, 100, 200), t0 + 1000); h.apply(trade(2, 200, 100), t0 + 1000);
  h.apply({ ...trade(3, 3000, 101), kind: 'correction', originalId: '1' }, t0 + 3000);
  let bars = h.bars('SPY', 1, t0 + 4000); assert.equal(bars.length, 1); assert.equal(bars[0].high, 101); assert.equal(bars[0].open, 101); assert.equal(bars[0].close, 100);
  for (const id of ['2', '3']) h.apply({ ...trade(id, 4000), kind: 'cancel', originalId: id }, t0 + 4000);
  assert.equal(h.bars('SPY', 1, t0 + 4000).length, 0);
});

test('capacity, reconnect and unknown corrections never imply complete historical coverage', () => {
  const h = new TradeHistory(['SPY'], 2);
  for (let i = 0; i < 3; i++) h.apply(trade(i, i * 1000), t0 + 3000);
  assert.equal(h.symbols.get('SPY').trades.size, 2); assert.equal(h.bars('SPY', 1, t0 + 3000).length, 2);
  h.connected(['SPY'], t0 + 3100); assert.equal(h.bars('SPY', 1, t0 + 4000).length, 0);
  h.apply(trade(4, 3200), t0 + 4000); assert.equal(h.bars('SPY', 1, t0 + 4000).length, 0);
  h.apply(trade(5, 4100), t0 + 5000);
  h.apply({ ...trade(6, 5000), kind: 'correction', originalId: 'unknown' }, t0 + 5000);
  assert.equal(h.bars('SPY', 1, t0 + 6000).length, 0); assert.equal(h.symbols.get('SPY').lostCorrections, 1);
});

test('nanosecond ordering and int64 provider IDs survive parsing without collisions', () => {
  const parsed = parseFeedFrame('[{"T":"t","S":"BTC/USD","i":3447222699101865076,"t":"2026-09-22T15:00:00.100000009Z","p":100,"s":1},{"T":"t","S":"BTC/USD","i":3447222699101865077,"t":"2026-09-22T15:00:00.100000001Z","p":90,"s":2}]');
  assert.notEqual(parsed[0].i, parsed[1].i);
  const h = new TradeHistory(['BTC/USD']); parsed.forEach(x => h.apply(parseMessage(x), t0 + 1000));
  const b = h.bars('BTC/USD', 1, t0 + 1000)[0]; assert.equal(b.open, 90); assert.equal(b.close, 100); assert.equal(b.volume, 3);
});

test('short candle API uses trade history while strategy history remains unchanged', async () => {
  const f = await fixture();
  try {
    f.engine.onTrade(trade(1, 0));
    const data = chartData(f.engine, 'SPY', '1s'); assert.equal(data.intervalMs, 1000); assert.equal(data.bars.length, 1);
    assert.equal(f.engine.features.history.size, 0); assert.equal(chartData(f.engine, 'SPY', 1).bars.length, 0);
  } finally { f.store.close(); }
});

test('corrections preserve nanosecond order within the same millisecond', () => {
  const h = new TradeHistory(['SPY']);
  h.apply({ ...trade(1, 100, 100), stamp: '2026-09-22T15:00:00.100000001Z' }, t0 + 1000);
  h.apply({ ...trade(2, 100, 105), stamp: '2026-09-22T15:00:00.100000009Z' }, t0 + 1000);
  h.apply({ ...trade(3, 2000, 102), kind: 'correction', originalId: '2' }, t0 + 2000);
  const b = h.bars('SPY', 1, t0 + 2000)[0];
  assert.equal(b.open, 100); assert.equal(b.close, 102); assert.equal(b.high, 102);
});

test('timing windows are bounded and separate absent observations from zero duration', () => {
  const t = new TimingWindow(4); assert.equal(t.summary().p50, null);
  for (const n of [NaN, -1, 0, 1, 2, 3, 99]) t.add(n);
  assert.deepEqual(t.summary(), { samples: 4, total: 5, p50: 2, p95: 99, last: 99 });
});

test('authenticated SSE sends quote/short-bar deltas, expires quote freshness and cleans up', async () => {
  const f = await fixture(), server = createDashboard(f.engine, f.cfg); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`, headers = { Authorization: `Bearer ${f.cfg.token}` }, controller = new AbortController();
  try {
    assert.equal((await fetch(base + '/api/stream?symbol=SPY')).status, 401);
    assert.equal((await fetch(base + '/api/stream?symbol=BAD', { headers })).status, 400);
    assert.equal((await fetch(base + '/api/stream?symbol=SPY', { headers: { ...headers, Origin: 'https://invalid.example' } })).status, 403);
    await f.engine.onQuote(quote('SPY', f.now())); f.engine.onTrade(trade(1, 0));
    const r = await fetch(base + '/api/stream?symbol=SPY&interval=1s', { headers, signal: controller.signal }), reader = r.body.getReader();
    const read = async () => { const result = await reader.read(); return JSON.parse(new TextDecoder().decode(result.value).split('\n\n')[0].slice(6)); };
    const first = await read(); assert.equal(first.quoteFresh, true); assert.equal(first.barDelta.reset, true); assert.equal(first.barDelta.upsert.length, 1);
    const second = await read(); assert.equal(second.barDelta.upsert.length, 0); assert.equal(second.barDelta.reset, false);
    f.advance(6000); const third = await read(); assert.equal(third.quoteFresh, false); assert.ok(third.sequence > first.sequence);
    assert.ok(!JSON.stringify(first).includes(f.cfg.token)); assert.equal(first.pushIntervalMs, 100);
    await reader.cancel();
  } finally { controller.abort(); server.closeStreams(); await new Promise(resolve => server.close(resolve)); f.store.close(); }
});

test('slow SSE clients are disconnected instead of accumulating an unbounded queue', async context => {
  let mono = 0; context.mock.method(performance, 'now', () => mono);
  const f = await fixture(), stream = createQuoteStream(f.engine), response = new EventEmitter(); let destroyed = false;
  Object.assign(response, { writableNeedDrain: true, writeHead() {}, flushHeaders() {}, end() { this.emit('close'); }, destroy() { destroyed = true; this.emit('close'); }, write() { throw new Error('must skip blocked writer'); } });
  try {
    stream.open({ socket: { setNoDelay() {} } }, response, 'SPY', '1'); assert.equal(stream.size, 1);
    await delay(130); assert.equal(destroyed, false);
    mono = 6000; await delay(130); assert.equal(destroyed, true); assert.equal(stream.size, 0);
  } finally { stream.close(); f.store.close(); }
});

class SocketMock extends EventTarget {
  static sockets = []; sent = [];
  constructor(url) { super(); this.url = url; SocketMock.sockets.push(this); }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.dispatchEvent(new Event('close')); }
  message(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
}

test('market socket subscribes to trades as well as bars/quotes and routes prints away from strategy bars', async () => {
  const f = await fixture(), feed = new AlpacaFeed('equities', 'wss://test', ['SPY'], f.cfg, f.engine, SocketMock);
  const connected = feed.connect(), ws = SocketMock.sockets.at(-1);
  try {
    ws.dispatchEvent(new Event('open')); ws.message([{ T: 'success', msg: 'authenticated' }]);
    assert.deepEqual(ws.sent[1].trades, ['SPY']);
    ws.message([{ T: 'subscription', quotes: ['SPY'], bars: ['SPY'], trades: ['SPY'] }]);
    f.advance(2000); ws.message([{ T: 't', S: 'SPY', i: 1, t: new Date(f.now()).toISOString(), p: 100, s: 1 }]);
    assert.equal(f.engine.realtime.trades.bars('SPY', 1, f.now()).length, 1); assert.equal(f.engine.features.history.size, 0);
    ws.close(); await connected;
  } finally { feed.stop(); f.store.close(); }
});

test('paper order socket decodes binary events, sanitizes data and never submits orders', async () => {
  const observations = [], cfg = testConfig(), engine = { feeds: {}, onBrokerUpdate: x => observations.push(x) };
  const feed = new AlpacaOrderFeed(cfg, engine, SocketMock), connected = feed.connect(), ws = SocketMock.sockets.at(-1);
  ws.message({ stream: 'authorization', data: { status: 'authorized' } });
  ws.message({ stream: 'listening', data: { streams: ['trade_updates'] } });
  const bytes = new TextEncoder().encode(JSON.stringify({ stream: 'trade_updates', data: { event: 'fill', token: 'secret-canary', order: { client_order_id: 'manual-order', symbol: 'SPY', side: 'buy', filled_qty: '1', filled_avg_price: '101' } } }));
  ws.dispatchEvent(new MessageEvent('message', { data: bytes.buffer }));
  assert.equal(observations.length, 1); assert.equal(observations[0].status, 'fill'); assert.match(observations[0].note, /external/); assert.doesNotMatch(JSON.stringify(observations), /secret-canary/);
  assert.equal(orderObservation({ event: 'unsupported' }), null);
  ws.close(); await connected; feed.stop();
});

test('browser overlay rejects stale selection/REST frames and marks live position P/L', () => {
  const live = new LiveQuotes(() => {}, () => {});
  live.connected = true; live.frame = { symbol: 'SPY', interval: '1s', intervalMs: 1000, serverMono: 20, now: 10, quote: { bid: 102, ask: 103 }, quoteFresh: true, clockTrusted: true }; live.barList = [{ ts: 1 }];
  const data = { symbol: 'SPY', interval: '1s', serverMono: 10, bars: [], position: { qty: 2, entryPrice: 100 }, positionPnl: {} };
  assert.equal(live.overlay(data).positionPnl.value, 4); assert.equal(live.overlay(data).bars.length, 1);
  assert.equal(live.overlay({ ...data, serverMono: 30 }).serverMono, 30);
  assert.equal(live.overlay({ ...data, symbol: 'QQQ' }).symbol, 'QQQ');
});

test('bursty broker notifications coalesce reconciliation and never adopt a streamed position', async () => {
  const f = await fixture(); let reconciles = 0;
  const original = f.engine.reconcile.bind(f.engine); f.engine.reconcile = async () => { reconciles++; await original(); };
  try {
    const observation = orderObservation({ event: 'fill', order: { client_order_id: 'external', symbol: 'SPY', side: 'buy', filled_qty: '100', filled_avg_price: '100' } });
    for (let i = 0; i < 25; i++) f.engine.onBrokerUpdate(observation);
    assert.equal(f.engine.positions.length, 0); assert.equal(f.store.orders().length, 0);
    await delay(330); assert.equal(reconciles, 1); assert.equal(f.engine.positions.length, 0); assert.equal(f.store.orders().length, 0);
  } finally { clearTimeout(f.engine.streamReconcile); f.store.close(); }
});
