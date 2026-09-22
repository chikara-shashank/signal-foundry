import { positive, quoteOrder } from './util.js';

// Best-quote OFI; this is a feed-dependent L1 proxy, not an order-level book.
export class Microstructure {
  states = new Map();
  add(q) {
    if (!positive(q.bidSize) || !positive(q.askSize)) { this.states.delete(q.symbol); return null; }
    let state = this.states.get(q.symbol) ?? { previous: null, events: [] };
    const p = state.previous;
    if (p && quoteOrder(q) <= quoteOrder(p)) return this.snapshot(q.symbol, Math.max(q.ts, p.ts));
    if (p && q.ts - p.ts > 5000) state = { previous: null, events: [] };
    const prev = state.previous;
    const ofi = prev ? (q.bid >= prev.bid ? q.bidSize : 0) - (q.bid <= prev.bid ? prev.bidSize : 0)
      - (q.ask <= prev.ask ? q.askSize : 0) + (q.ask >= prev.ask ? prev.askSize : 0) : 0;
    state.events.push({ ts: q.ts, ofi, depth: (q.bidSize + q.askSize) / 2, mid: (q.bid + q.ask) / 2 });
    state.events = state.events.filter(e => q.ts - e.ts <= 5000).slice(-2000);
    state.previous = q; this.states.set(q.symbol, state);
    return this.snapshot(q.symbol, q.ts);
  }
  snapshot(symbol, now) {
    const s = this.states.get(symbol); if (!s || now - s.previous.ts > 1000) return null;
    const es = s.events.filter(e => now - e.ts <= 5000), q = s.previous, mid = (q.bid + q.ask) / 2;
    if (!es.length) return null;
    const averageDepth = es.reduce((v, e) => v + e.depth, 0) / es.length;
    const microprice = (q.ask * q.bidSize + q.bid * q.askSize) / (q.bidSize + q.askSize);
    return { ts: q.ts, observations: es.length, spanMs: es.at(-1).ts - es[0].ts, imbalance: (q.bidSize - q.askSize) / (q.bidSize + q.askSize),
      normalizedOfi: es.reduce((v, e) => v + e.ofi, 0) / averageDepth, microprice, mid,
      micropriceSkewBps: (microprice / mid - 1) * 10000, returnBps: (mid / es[0].mid - 1) * 10000, source: 'best_quote_proxy' };
  }
}

// Fit only prior observations. A z-score is a research candidate, not a
// cointegration test, executable arbitrage, or proof of mean reversion.
export function relativeValue(a, b, lookback = 60) {
  const bByTime = new Map(b.map(x => [x.ts, x]));
  const pairs = a.filter(x => bByTime.has(x.ts)).map(x => [x, bByTime.get(x.ts)]).slice(-(lookback + 1));
  if (pairs.length !== lookback + 1 || pairs.some((p, i) => i && p[0].ts - pairs[i - 1][0].ts !== 60000)) return null;
  const training = pairs.slice(0, -1), last = pairs.at(-1), xs = training.map(p => Math.log(p[1].close)), ys = training.map(p => Math.log(p[0].close));
  const mean = v => v.reduce((s, x) => s + x, 0) / v.length, mx = mean(xs), my = mean(ys);
  const xx = xs.reduce((v, x) => v + (x - mx) ** 2, 0); if (xx < 1e-12) return null;
  const beta = xs.reduce((v, x, i) => v + (x - mx) * (ys[i] - my), 0) / xx, intercept = my - beta * mx;
  const residuals = ys.map((y, i) => y - intercept - beta * xs[i]);
  const sd = Math.sqrt(residuals.reduce((s, x) => s + x * x, 0) / (lookback - 2)); if (sd < 1e-8) return null;
  const deviation = Math.log(last[0].close) - intercept - beta * Math.log(last[1].close);
  const denominator = residuals.slice(0, -1).reduce((s, x) => s + x * x, 0);
  const phi = residuals.slice(1).reduce((s, x, i) => s + x * residuals[i], 0) / denominator;
  return { pair: `${last[0].symbol} / ${last[1].symbol}`, ts: last[0].ts, beta, zscore: deviation / sd, residualStd: sd,
    descriptiveHalfLifeBars: phi > 0 && phi < 1 ? -Math.log(2) / Math.log(phi) : null, status: 'research_only_no_hedged_execution', trainingEndsAt: training.at(-1)[0].ts };
}
