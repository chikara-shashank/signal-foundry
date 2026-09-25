import { validBar } from './util.js';

// Provider minute bars from the configured feed repair stream gaps and warm a restart.
// Minutes without trades stay absent; nothing is interpolated or synthesized.
export class StockHistory {
  inflight = new Map(); pausedUntil = 0;
  constructor(engine, fetchFn = fetch) { this.engine = engine; this.fetch = fetchFn; }
  async bars(symbols, start, end, timeframe = '1Min', {research=false} = {}) {
    const { cfg } = this.engine, out = new Map(symbols.map(s => [s, []])), interval = { '1Min': 60000, '30Min': 1800000 }[timeframe]; let token = null;
    if (!interval) throw new Error('stock_history_timeframe');
    for (let page = 0; page < 10; page++) {
      if(!research&&this.engine.schedule&&!this.engine.schedule.state().equityTracking)throw new Error('stock_history_scheduled_off');
      const query = new URLSearchParams({ symbols: symbols.join(','), timeframe, start: new Date(start).toISOString(), end: new Date(end - 1).toISOString(),
        feed: cfg.feed, adjustment: 'raw', limit: '10000', sort: 'asc' });
      if (token) query.set('page_token', token);
      const r = await this.fetch(`https://data.alpaca.markets/v2/stocks/bars?${query}`, {
        headers: { 'APCA-API-KEY-ID': cfg.key, 'APCA-API-SECRET-KEY': cfg.secret }, redirect: 'error', signal: AbortSignal.timeout(7000),
      });
      if (!r.ok) throw new Error(`stock_history_http_${r.status}`);
      const body = await r.json();
      if (!body || (body.bars !== null && typeof body.bars !== 'object')) throw new Error('stock_history_invalid');
      for (const [symbol, rows] of Object.entries(body.bars ?? {})) {
        if (!out.has(symbol) || !Array.isArray(rows)) throw new Error('stock_history_invalid');
        for (const x of rows) {
          const b = { kind: 'bar', symbol, ts: Date.parse(x.t), open: x.o, high: x.h, low: x.l, close: x.c, volume: x.v, ...(Number.isFinite(x.vw) ? { vwap: x.vw } : {}) };
          if (!validBar(b) || b.ts < start || b.ts + interval > end) throw new Error('stock_history_invalid');
          out.get(symbol).push(b);
        }
      }
      token = body.next_page_token;
      if (!token) break;
    }
    if (token) throw new Error('stock_history_incomplete');
    return out;
  }
  // Before streaming starts: restore the last two hours so contexts are ready immediately.
  async warmup(minutes = 150) {
    const e = this.engine, now = e.clock(), end = Math.floor(now / 60000) * 60000;
    if(e.schedule && !e.schedule.state(now).equityTracking)return;
    if (!e.cfg.equities.length) return;
    try {
      const bars = await this.bars(e.cfg.equities, end - minutes * 60000, end);
      let restored = 0;
      for (const [symbol, rows] of bars) restored += e.backfill(symbol, rows, true);
      e.store.event('bar_backfill', { kind: 'warmup', symbols: e.cfg.equities.length, bars: restored, source: `alpaca_${e.cfg.feed}` }, e.clock());
    } catch (error) { this.unavailable(error, 'warmup'); }
  }
  // Called before a streamed bar is added: fill a short intraday gap so the
  // continuity rule does not discard two hours of context for one lost minute.
  async repair(b) {
    const e = this.engine, last = e.features.history.get(b.symbol)?.at(-1)?.ts;
    if(e.schedule && !e.schedule.state().equityTracking)return;
    if (!Number.isFinite(last) || b.ts - last <= 60000 || b.ts - last > 30 * 60000 || Date.now() < this.pausedUntil) return;
    const pending = this.inflight.get(b.symbol);
    if (pending) return pending;
    const work = (async () => {
      try {
        const rows = (await this.bars([b.symbol], last + 60000, b.ts)).get(b.symbol);
        const restored = e.backfill(b.symbol, rows, false);
        e.store.event('bar_backfill', { kind: 'gap', symbol: b.symbol, missing: (b.ts - last) / 60000 - 1, bars: restored, source: `alpaca_${e.cfg.feed}` }, e.clock());
      } catch (error) { this.unavailable(error, 'gap', b.symbol); }
    })().finally(() => this.inflight.delete(b.symbol));
    this.inflight.set(b.symbol, work);
    return work;
  }
  unavailable(error, kind, symbol) {
    this.pausedUntil = Date.now() + 60000;
    const reason = /^stock_history_\w+$/.test(error?.message) ? error.message : 'stock_history_unavailable';
    this.engine.store.event('bar_backfill', { kind, ...(symbol ? { symbol } : {}), reason, note: 'Continuity rule applies; no synthetic bars.' }, this.engine.clock());
  }
}
