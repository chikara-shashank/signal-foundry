import { validBar } from './util.js';

// Provider aggregates cover sparse trading without inventing absent minute bars.
// A separate read-only market-data endpoint never shares the order transport.
export class CryptoContext {
  busy = false; lastBucket = null; retryAt = 0;
  constructor(engine, fetchFn = fetch) { this.engine = engine; this.fetch = fetchFn; }
  async poll() {
    const e = this.engine, now = e.clock(), end = Math.floor(now / 300000) * 300000;
    if (!e.cfg.crypto.length || this.busy || end === this.lastBucket || now < this.retryAt || now - end < 2000) return;
    this.busy = true;
    try {
      const bars = new Map(e.cfg.crypto.map(s => [s, []])); let token = null;
      for (let page = 0; page < 4; page++) {
        const query = new URLSearchParams({ symbols: e.cfg.crypto.join(','), timeframe: '5Min', start: new Date(end - 180 * 300000).toISOString(), end: new Date(end - 1).toISOString(), limit: '1000', sort: 'asc' });
        if (token) query.set('page_token', token);
        const r = await this.fetch(`https://data.alpaca.markets/v1beta3/crypto/${e.cfg.cryptoLocation}/bars?${query}`, {
          headers: { 'APCA-API-KEY-ID': e.cfg.key, 'APCA-API-SECRET-KEY': e.cfg.secret }, redirect: 'error', signal: AbortSignal.timeout(7000),
        });
        if (!r.ok) throw new Error(`crypto_history_http_${r.status}`);
        const body = await r.json();
        if (!body.bars || typeof body.bars !== 'object') throw new Error('crypto_history_invalid');
        for (const [symbol, rows] of Object.entries(body.bars)) {
          if (!bars.has(symbol) || !Array.isArray(rows) || rows.length > 1000) throw new Error('crypto_history_invalid');
          for (const x of rows) {
            const b = { symbol, ts: Date.parse(x.t), open: x.o, high: x.h, low: x.l, close: x.c, volume: x.v };
            if (!validBar(b) || b.ts % 300000 || b.ts + 300000 > end || b.ts < end - 180 * 300000) throw new Error('crypto_history_invalid');
            bars.get(symbol).push(b);
          }
        }
        token = body.next_page_token;
        if (!token) break;
      }
      if (token) throw new Error('crypto_history_incomplete');
      const initial = this.lastBucket === null;
      for (const [symbol, rows] of bars) await e.onCryptoHistory(symbol, rows, initial);
      this.lastBucket = end;
      e.cryptoContextStatus = { state: 'ready', observedAt: e.clock(), intervalMs: 300000, nextAt: end + 302000 };
    } catch (error) {
      this.retryAt = e.clock() + 30000;
      const reason = /^crypto_history_\w+$/.test(error.message) ? error.message : 'crypto_history_unavailable';
      e.cryptoContextStatus = { state: 'retrying', observedAt: e.clock(), intervalMs: 300000, reason, nextAt: this.retryAt };
      e.store.event('crypto_context', { reason, note: 'No synthetic bars or historical orders; retrying read-only context.' }, e.clock());
    } finally { this.busy = false; }
  }
}
