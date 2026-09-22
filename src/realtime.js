import { validateQuote } from './util.js';

export const INTERVALS = new Map([['1s', 1000], ['5s', 5000], ['15s', 15000], ['1', 60000], ['5', 300000], ['15', 900000]]);
export function intervalWidth(value) { return INTERVALS.get(String(value)) ?? null; }

export class TimingWindow {
  constructor(limit = 1000) { this.limit = limit; this.values = []; this.total = 0; }
  add(value) { if (!Number.isFinite(value) || value < 0) return; this.total++; this.values.push(value); if (this.values.length > this.limit) this.values.shift(); }
  summary() {
    const xs = [...this.values].sort((a, b) => a - b), at = p => xs.length ? xs[Math.ceil(xs.length * p) - 1] : null;
    return { samples: xs.length, total: this.total, p50: at(.5), p95: at(.95), last: this.values.at(-1) ?? null };
  }
}

// Display-only trade-print history. Never replaces the provider's strategy bars.
// Retention and count caps are explicit; no bars are synthesized across gaps.
export class TradeHistory {
  constructor(symbols, cap = Math.max(1000, Math.floor(200000 / symbols.length))) {
    this.cap = cap; this.symbols = new Map(symbols.map(s => [s, { trades: new Map(), revision: 0, coverageAfter: 0, lostCorrections: 0, connectedAt: 0 }]));
  }
  connected(symbols, now) {
    for (const symbol of symbols) { const s = this.symbols.get(symbol); if (!s) continue; s.trades.clear(); s.connectedAt = now; s.coverageAfter = Math.ceil(now / 1000) * 1000; s.revision++; }
  }
  apply(t, now) {
    const s = this.symbols.get(t.symbol);
    if (!s || !Number.isFinite(t.ts) || t.ts > now + 1000 || t.ts < now - 3600000) return false;
    const key = id => `${t.exchange ?? ''}:${id}`;
    if (t.kind === 'cancel' || t.kind === 'correction') {
      const old = s.trades.get(key(t.originalId));
      if (!old) {
        // An unresolvable correction means historical OHLC cannot be asserted.
        s.trades.clear(); s.coverageAfter = Math.ceil(now / 1000) * 1000; s.lostCorrections++; s.revision++; return false;
      }
      s.trades.delete(key(t.originalId)); s.revision++;
      if (t.kind === 'cancel') return true;
      t = { ...t, ts: old.ts, stamp: old.stamp, id: t.id };
    }
    if (!(t.price > 0) || !(t.size > 0) || !Number.isFinite(t.price) || !Number.isFinite(t.size) || t.id == null || !/^[\w-]{1,80}$/.test(String(t.id))) return false;
    if (s.trades.has(key(t.id))) return false;
    const stamp = /^\d{9}$/.test(t.stamp ?? '') ? t.stamp : (t.stamp?.match(/\.(\d{1,9})/)?.[1] ?? '').padEnd(9, '0');
    s.trades.set(key(t.id), { ts: t.ts, stamp, price: t.price, size: t.size }); s.revision++;
    while (s.trades.size > this.cap || (s.trades.size && s.trades.values().next().value.ts < now - 3600000)) {
      const [id, old] = s.trades.entries().next().value;
      s.trades.delete(id); s.coverageAfter = Math.max(s.coverageAfter, Math.floor(old.ts / 1000) * 1000 + 1000);
    }
    return true;
  }
  bars(symbol, seconds, now) {
    const s = this.symbols.get(symbol), width = seconds * 1000;
    if (!s || ![1, 5, 15].includes(seconds)) return [];
    const cutoff = Math.max(now - 3600000, s.coverageAfter), groups = new Map();
    for (const t of s.trades.values()) {
      const ts = Math.floor(t.ts / width) * width;
      if (ts < cutoff) continue;
      let b = groups.get(ts);
      if (!b) { b = { ts, open: t.price, close: t.price, high: t.price, low: t.price, volume: 0, trades: 0, first: t, last: t }; groups.set(ts, b); }
      if (t.ts < b.first.ts || (t.ts === b.first.ts && t.stamp < b.first.stamp)) { b.first = t; b.open = t.price; }
      if (t.ts > b.last.ts || (t.ts === b.last.ts && t.stamp > b.last.stamp)) { b.last = t; b.close = t.price; }
      b.high = Math.max(b.high, t.price); b.low = Math.min(b.low, t.price); b.volume += t.size; b.trades++;
    }
    return [...groups.values()].sort((a, b) => a.ts - b.ts).slice(-240).map(({ first, last, ...b }) => ({ ...b, partial: b.ts + width > now }));
  }
}

export class Realtime {
  constructor(engine) {
    this.engine = engine; this.trades = new TradeHistory(engine.cfg.symbols); this.quoteReceived = new Map(); this.eventVersion = 0;
    this.timings = Object.fromEntries(['feed', 'strategy', 'jev', 'orderAck', 'orderFailure'].map(k => [k, new TimingWindow()]));
  }
  quote(q) { this.quoteReceived.set(q.symbol, performance.now()); if (this.engine.cfg.mode !== 'demo') this.timings.feed.add(this.engine.clock() - q.ts); }
  summary() { return Object.fromEntries(Object.entries(this.timings).map(([k, v]) => [k, v.summary()])); }
  frame(symbol, interval) {
    const e = this.engine, now = e.clock(), q = e.quotes.get(symbol), width = intervalWidth(interval);
    return { symbol, interval, intervalMs: width, sessionId: String(e.startedAt), now, serverMono: performance.now(),
      quote: q ?? null, quoteFresh: validateQuote(q, now, e.cfg.maxQuoteAge), maxQuoteAge: e.cfg.maxQuoteAge,
      clockTrusted: !e.timebase || e.timebase.status().synchronized,
      heldMs: q ? performance.now() - this.quoteReceived.get(symbol) : null,
      eventVersion: this.eventVersion,
      bars: width < 60000 ? this.trades.bars(symbol, width / 1000, now) : null };
  }
}

// Authenticated SSE via fetch, bounded connections and bounded slow-client queues.
export function createQuoteStream(engine) {
  const clients = new Set(); let timer = null, sequence = 0;
  const tick = () => {
    const cache = new Map();
    for (const c of clients) {
      if (c.res.writableNeedDrain) { if (performance.now() - c.lastWrite > 5000) c.res.destroy(); continue; }
      try {
        const key = `${c.symbol}:${c.interval}`;
        if (!cache.has(key)) cache.set(key, engine.realtime.frame(c.symbol, c.interval));
        const { bars, ...frame } = cache.get(key);
        let delta = null;
        if (bars) {
          const current = new Map(bars.map(b => [b.ts, JSON.stringify(b)]));
          delta = { reset: !c.bars, upsert: bars.filter(b => c.bars?.get(b.ts) !== current.get(b.ts)), remove: [...(c.bars?.keys() ?? [])].filter(ts => !current.has(ts)) };
          c.bars = current;
        }
        const payload = { ...frame, sequence: ++sequence, pushIntervalMs: 100, ...(delta ? { barDelta: delta } : {}) };
        c.res.write(`data: ${JSON.stringify(payload)}\n\n`); c.lastWrite = performance.now();
      } catch { c.res.destroy(); }
    }
  };
  return {
    open(req, res, symbol, interval) {
      if (clients.size >= 8) { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Close unused live dashboard tabs' })); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' }); res.flushHeaders();
      req.socket.setNoDelay(true); const c = { res, symbol, interval, lastWrite: performance.now(), bars: null }; clients.add(c);
      res.on('close', () => { clients.delete(c); if (!clients.size) { clearInterval(timer); timer = null; } });
      if (!timer) { timer = setInterval(tick, 100); timer.unref(); }
    },
    close() { clearInterval(timer); timer = null; for (const c of clients) c.res.end(); clients.clear(); },
    get size() { return clients.size; },
  };
}
