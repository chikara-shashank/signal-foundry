import { isCrypto, validateQuote } from './util.js';
import { BAR_STRATEGIES } from './strategy-registry.js';

// Only the price observation waits. The candidate, features and deadline never
// change, and waking a waiter grants no approval or capital reservation.
export class CryptoQuoteWaits {
  pending = new Map();
  constructor(engine) { this.engine = engine; }
  eligible(c) { return this.engine.cfg.mode !== 'demo' && isCrypto(c.symbol) && BAR_STRATEGIES.includes(c.strategy); }
  wait(c) {
    const e = this.engine, now = e.clock();
    if (e.stopped) return Promise.resolve('engine_stopped');
    if (!Number.isFinite(c.expires) || now >= c.expires) return Promise.resolve('candidate_expired');
    // Covers a quote that arrived between preflight and registration.
    if (validateQuote(e.quotes.get(c.symbol), now, e.cfg.maxQuoteAge)) return Promise.resolve(null);
    if (this.pending.has(c.id)) return this.pending.get(c.id).promise;
    if (this.pending.size >= 100) return Promise.resolve('crypto_quote_wait_capacity');
    const firstWait = !c.quoteWait;
    c.quoteWait ??= { startedAt: now, expires: c.expires };
    c.status = 'waiting_for_quote'; c.reason = 'waiting_for_fresh_quote';
    e.store.updateCandidate(c);
    if (firstWait) e.observability.crypto.waited++;
    e.store.event('candidate_waiting', { candidateId: c.id, symbol: c.symbol, strategy: c.strategy,
      reason: c.reason, expires: c.expires }, now);
    e.realtime.eventVersion++;
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    const item = { c, promise, resolve, timer: null };
    this.pending.set(c.id, item);
    const expire = () => {
      if (this.pending.get(c.id) !== item) return;
      const remaining = c.expires - e.clock();
      if (remaining <= 0) this.finish(item, 'candidate_expired');
      else { item.timer = setTimeout(expire, remaining); item.timer.unref?.(); }
    };
    item.timer = setTimeout(expire, c.expires - now); item.timer.unref?.();
    return promise;
  }
  finish(item, reason) {
    if (this.pending.get(item.c.id) !== item) return;
    this.pending.delete(item.c.id); clearTimeout(item.timer);
    const { c } = item;
    c.quoteWait.endedAt = this.engine.clock();
    c.status = 'evaluating'; delete c.reason;
    this.engine.store.updateCandidate(c);
    this.engine.realtime.eventVersion++;
    item.resolve(reason);
  }
  onQuote(symbol) {
    const e = this.engine, now = e.clock();
    for (const item of this.pending.values()) {
      if (item.c.symbol !== symbol) continue;
      if (now >= item.c.expires) this.finish(item, 'candidate_expired');
      else if (validateQuote(e.quotes.get(symbol), now, e.cfg.maxQuoteAge)) this.finish(item, null);
    }
  }
  cancel(reason, matches = () => true) {
    for (const item of this.pending.values()) if (matches(item.c)) this.finish(item, reason);
  }
  snapshot() {
    return { ...this.engine.observability.crypto, waiting: this.pending.size,
      pending: [...this.pending.values()].map(({ c }) => ({ id: c.id, symbol: c.symbol,
        strategy: c.strategy, since: c.quoteWait.startedAt, expires: c.expires })) };
  }
}
