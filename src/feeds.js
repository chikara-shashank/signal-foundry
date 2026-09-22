import { sleep, validBar } from './util.js';

// Preserve provider int64 trade IDs, including crypto IDs beyond JS safe integers.
export const parseFeedFrame = text => JSON.parse(text, (key, value, context) =>
  ['i', 'oi', 'ci'].includes(key) && typeof value === 'number' && !Number.isSafeInteger(value) ? context.source : value);

export function parseMessage(x) {
  const ts = Date.parse(x.t);
  if (x.T === 'q') return { kind: 'quote', symbol: x.S, ts, bid: Number(x.bp), ask: Number(x.ap), bidSize: Number(x.bs), askSize: Number(x.as) };
  if (['t', 'c', 'x'].includes(x.T)) return { kind: x.T === 't' ? 'trade' : x.T === 'c' ? 'correction' : 'cancel', symbol: x.S, ts, stamp: x.t,
    id: x.T === 'c' ? x.ci : x.i, originalId: x.T === 'c' ? x.oi : x.i, exchange: x.x ?? '',
    price: Number(x.T === 'c' ? x.cp : x.p), size: Number(x.T === 'c' ? x.cs : x.s) };
  if (x.T === 'b') {
    const b = { kind: 'bar', symbol: x.S, ts, open: Number(x.o), high: Number(x.h), low: Number(x.l), close: Number(x.c), volume: Number(x.v) };
    return validBar(b) ? b : null;
  }
  return null;
}

export class AlpacaFeed {
  stopped = false; socket = null; timer = null;
  constructor(name, url, symbols, cfg, engine, Socket = WebSocket) { Object.assign(this, { name, url, symbols, cfg, engine, Socket }); }
  async run() {
    let failures = 0;
    while (!this.stopped) {
      try { await this.connect(); } catch { /* Status contains a sanitized reason. */ }
      if (this.stopped) break;
      failures++; const delay = Math.min(60000, 1000 * 2 ** Math.min(failures, 6)) + Math.random() * 500;
      this.engine.feeds[this.name] = { ...this.engine.feeds[this.name], status: 'reconnecting', retryMs: Math.round(delay) };
      await sleep(delay);
    }
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = this.socket = new this.Socket(this.url); let authenticated = false, settled = false, lastData = Date.now();
      this.engine.feeds[this.name] = { ...this.engine.feeds[this.name], status: 'connecting' };
      const fail = reason => {
        if (settled) return; settled = true; clearInterval(this.timer); ws.close();
        this.engine.feeds[this.name] = { status: reason, lastError: reason, errorAt: Date.now() }; reject(new Error(reason));
      };
      const authDeadline = Date.now() + 15000;
      this.timer = setInterval(() => {
        if (!authenticated && Date.now() > authDeadline) fail('authentication_timeout');
        if (authenticated && (this.name === 'crypto' || this.engine.session?.open) && Date.now() - lastData > 90000) fail('data_timeout');
      }, 5000);
      ws.addEventListener('open', () => ws.send(JSON.stringify({ action: 'auth', key: this.cfg.key, secret: this.cfg.secret })));
      ws.addEventListener('message', event => {
        try {
          if (typeof event.data !== 'string' || event.data.length > 2000000) return fail('invalid_frame');
          const messages = parseFeedFrame(event.data);
          if (!Array.isArray(messages) || messages.length > 20000) return fail('invalid_frame');
          for (const x of messages) {
            if (x.T === 'error') return fail(`feed_error_${Number(x.code) || 0}`);
            if (x.T === 'success' && x.msg === 'authenticated') {
              authenticated = true; ws.send(JSON.stringify({ action: 'subscribe', bars: this.symbols, quotes: this.symbols, trades: this.symbols }));
            }
            if (x.T === 'subscription') {
              if (!this.symbols.every(s => x.bars?.includes(s) && x.quotes?.includes(s) && x.trades?.includes(s))) return fail('incomplete_subscription');
              this.engine.realtime.trades.connected(this.symbols, this.engine.clock());
              this.engine.feeds[this.name] = { status: 'streaming', lastMessage: Date.now() };
            }
            const item = parseMessage(x);
            if (!item || !authenticated || !this.symbols.includes(item.symbol)) continue;
            lastData = Date.now();
            this.engine.feeds[this.name] = { ...this.engine.feeds[this.name], status: 'streaming', lastMessage: Date.now(),
              providerTimestamp: item.ts, providerAgeMs: this.engine.clock() - item.ts, hostAgeMs: Date.now() - item.ts, lastKind: item.kind };
            if (item.kind === 'quote') this.engine.onQuote(item);
            else if (item.kind === 'bar') void this.engine.onBar(item).catch(() => this.engine.fail('bar_processing_error'));
            else this.engine.onTrade(item);
          }
        } catch { fail('feed_parse_error'); }
      });
      ws.addEventListener('error', () => fail('connection_error'));
      ws.addEventListener('close', () => { if (!settled) { settled = true; clearInterval(this.timer); resolve(); } });
    });
  }
  stop() { this.stopped = true; clearInterval(this.timer); this.socket?.close(); }
}

// Deliberately artificial price regimes exercise both accepted and rejected setups.
export class DemoFeed {
  stopped = false; index = 0;
  constructor(cfg, engine, setTime) {
    Object.assign(this, { cfg, engine, setTime });
    const saved = engine.store.get('demoFeed');
    this.prices = new Map(saved?.prices ?? []);
    this.start = saved?.start ?? Math.floor(Date.now() / 60000) * 60000 - 100 * 60000;
    this.index = saved?.index ?? 0; this.resumed = !!saved;
  }
  async step(warmup = false) {
    const ts = this.start + this.index * 60000, now = ts + 60001; this.setTime(now);
    for (const [j, symbol] of this.cfg.symbols.entries()) {
      const base = symbol === 'BTC/USD' ? 60000 : symbol === 'ETH/USD' ? 3000 : 100 + j * 30;
      const open = this.prices.get(symbol) ?? base;
      const phase = this.index % 48, move = phase < 30 ? .0008 : phase < 35 ? -.0015 : phase < 39 ? .0025 : -.0005;
      const close = open * (1 + move + Math.sin(this.index * 1.7 + j) * .0003);
      const b = { symbol, ts, open, high: Math.max(open, close) * 1.0004, low: Math.min(open, close) * .9996, close, volume: phase >= 35 && phase < 39 ? 2500 : 1000 + Math.round(200 * Math.sin(this.index + j)) };
      this.prices.set(symbol, close);
      this.engine.onQuote({ symbol, ts: now, bid: close * .9998, ask: close * 1.0002 });
      if (!warmup) await this.engine.reconcile();
      await this.engine.onBar(b, warmup);
    }
    if (!warmup) {
      this.setTime(now + 1000);
      for (const [symbol, close] of this.prices) this.engine.onQuote({ symbol, ts: now + 1000, bid: close * .9998, ask: close * 1.0002 });
      await this.engine.reconcile();
    }
    this.index++;
    this.engine.store.set('demoFeed', { start: this.start, index: this.index, prices: [...this.prices] });
    this.engine.store.set('demoClock', now + (warmup ? 0 : 1000));
  }
  async run() {
    this.engine.feeds.demo = { status: 'synthetic_accelerated' };
    if (!this.resumed) for (let i = 0; i < 100 && !this.stopped; i++) await this.step(true);
    while (!this.stopped) { await this.step(); await this.engine.reconcile(); await sleep(this.cfg.demoInterval); }
  }
  stop() { this.stopped = true; }
}
