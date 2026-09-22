import { isCrypto, terminal, validateQuote } from './util.js';

const feeFor = (o, fallback) => Number.isFinite(o.fee) ? o.fee : (o.filledQty ?? 0) * (o.fillPrice ?? 0) * (o.feeRateBps ?? fallback) / 10000;
export function tradeScorecard(orders, cfg) {
  const trades = [], groups = new Map();
  for (const entry of orders.filter(o => o.kind === 'entry' && o.filledQty > 0)) {
    const rate = entry.feeRateBps ?? (isCrypto(entry.symbol) ? cfg.cryptoFee : cfg.equityFee);
    const exits = [...new Map([...orders.filter(o => o.kind === 'exit' && o.entryId === entry.id), ...(entry.legs ?? [])].map(o => [o.brokerId ?? o.id, o])).values()].filter(o => o.filledQty > 0);
    const quantity = exits.reduce((n, o) => n + o.filledQty, 0);
    if (!quantity || quantity > entry.filledQty + 1e-8) continue;
    const fraction = quantity / entry.filledQty;
    const grossPnl = exits.reduce((n, o) => n + o.filledQty * (o.fillPrice - entry.fillPrice), 0);
    const estimatedFees = feeFor(entry, rate) * fraction + exits.reduce((n, o) => n + feeFor(o, rate), 0);
    // A missing crypto quantity is not silently labeled a fee or a closed trade.
    const fullyClosed = terminal(entry.status) && Math.abs(quantity - entry.filledQty) < 1e-8 && exits.every(o => terminal(o.status));
    const trade = { symbol: entry.symbol, strategy: entry.strategy, entryId: entry.id, quantity, fullyClosed, grossPnl, estimatedFees, estimatedNetPnl: grossPnl - estimatedFees };
    trades.push(trade);
    const asset = isCrypto(entry.symbol) ? 'crypto' : 'equity', key = `${asset}:${entry.strategy}`;
    if (!groups.has(key)) groups.set(key, { strategy: entry.strategy, asset, closed: 0, partial: 0, wins: 0, grossPnl: 0, estimatedFees: 0, netPnl: 0, values: [] });
    const g = groups.get(key); g.grossPnl += grossPnl; g.estimatedFees += estimatedFees; g.netPnl += trade.estimatedNetPnl;
    if (fullyClosed) { g.closed++; g.wins += trade.estimatedNetPnl > 0 ? 1 : 0; g.values.push(trade.estimatedNetPnl); } else g.partial++;
  }
  return { trades, strategies: [...groups.values()].map(({ values, ...g }) => {
    const mean = values.length ? values.reduce((a,b) => a+b,0) / values.length : null;
    const variance = values.length > 1 ? values.reduce((a,b) => a + (b-mean)**2,0) / (values.length-1) : null;
    return { ...g, winRate: g.closed ? g.wins / g.closed : null, meanNetPerClosedTrade: mean,
      standardError: variance === null ? null : Math.sqrt(variance / values.length),
      evidence: g.closed < 30 ? 'insufficient_sample' : 'paper_sample_requires_out_of_sample_validation' };
  }), note: 'Local agent fills only; frozen per-order fee rates or recorded simulator fees. Partial exits are separate. Crypto fee-in-kind or dust residuals remain partial until reconciled; this is not a broker fee ledger. Model/cloud costs and open P/L are excluded.' };
}

// Forward observations, not pretend fills. At most one overlapping observation
// per symbol prevents a 250ms scanner from reporting thousands of independent bets.
export class SignalOutcomes {
  pending = new Map();
  constructor(engine) { this.engine = engine; }
  start(c) {
    if (!c.preflight?.ok || !c.model?.requested || !Number.isFinite(c.model.quality) || this.pending.has(c.symbol)) return;
    const e = this.engine, now = e.clock();
    this.pending.set(c.symbol, { candidateId: c.id, symbol: c.symbol, strategy: c.strategy, ts: now,
      modelPass: c.model.pass, modelQuality: c.model.quality, fingerprint: e.cfg.fingerprint,
      feeBps: isCrypto(c.symbol) ? e.cfg.cryptoFee : e.cfg.equityFee, slippageBps: e.cfg.slippage,
      delayMs: 1000, horizonMs: isCrypto(c.symbol) ? 900000 : 180000, entry: null });
  }
  quote(q, now) {
    const p = this.pending.get(q.symbol); if (!p) return;
    const entryAt = p.ts + p.delayMs, exitAt = entryAt + p.horizonMs;
    if (!validateQuote(q, now, this.engine.cfg.maxQuoteAge)) return;
    if (!p.entry && q.ts >= entryAt && q.ts <= entryAt + 5000) p.entry = q.ask * (1 + p.slippageBps / 10000);
    if (!p.entry && now > entryAt + 5000 || now > exitAt + 5000) return this.finish(p, null, 'missing_quote');
    if (p.entry && q.ts >= exitAt && q.ts <= exitAt + 5000) {
      const exit = q.bid * (1 - p.slippageBps / 10000);
      const netBps = ((exit * (1-p.feeBps/10000)) / (p.entry * (1+p.feeBps/10000)) - 1) * 10000;
      this.finish(p, netBps, 'observed');
    }
  }
  sweep(now) { for (const p of this.pending.values()) if (now > p.ts + p.delayMs + (p.entry ? p.horizonMs : 0) + 5000) this.finish(p, null, 'missing_quote'); }
  finish(p, netBps, state) {
    this.engine.store.event('signal_outcome', { ...p, state, netBps, hypothetical: true }, this.engine.clock()); this.pending.delete(p.symbol);
  }
  summary() {
    const rows = this.engine.store.eventsOfType('signal_outcome', this.engine.clock() - 7 * 86400000, 5000), groups = new Map();
    for (const r of rows) {
      const key = `${r.symbol}:${r.strategy}:${r.modelPass}:${r.fingerprint}`;
      if (!groups.has(key)) groups.set(key, { symbol: r.symbol, strategy: r.strategy, modelPass: r.modelPass, fingerprint: r.fingerprint, count: 0, missing: 0, totalNetBps: 0 });
      const g = groups.get(key); if (r.state === 'observed') { g.count++; g.totalNetBps += r.netBps; } else g.missing++;
    }
    return { pending: this.pending.size, rows: [...groups.values()].map(g => ({ ...g, meanNetBps: g.count ? g.totalNetBps/g.count : null })),
      note: 'Forward quote markouts after a 1s entry delay: 3m equities / 15m crypto, ask-to-bid with fees and slippage. One overlapping sample per symbol; missing quotes excluded. These are hypothetical observations, not executable returns or a causal test of Jev. Pending observations are lost on restart; last 7 days, at most 5,000 records.' };
  }
}
