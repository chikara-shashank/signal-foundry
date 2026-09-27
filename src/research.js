import { isCrypto, terminal, validateQuote } from './util.js';
import { executionExceptions } from './execution-incidents.js';
import { campaignId, campaignEntries, remainingQty } from './position-book.js';

const feeFor = (o, fallback) => Number.isFinite(o.fee) ? o.fee : (o.filledQty ?? 0) * (o.fillPrice ?? 0) * (o.feeRateBps ?? fallback) / 10000;
export function tradeScorecard(orders, cfg, filter = {}) {
  if (filter.experimentId || filter.from || filter.to) {
    const roots = orders.filter(o => o.kind === 'entry' && !o.addition && (!filter.experimentId || (o.experiment?.experimentId ?? 'legacy') === filter.experimentId) &&
      (!filter.from || o.ts >= filter.from) && (!filter.to || o.ts < filter.to));
    const rootsIds=new Set(roots.map(o=>o.id)),entries=orders.filter(o=>o.kind==='entry' && rootsIds.has(campaignId(o)));
    const ids = new Set(entries.map(o => o.id)); orders = [...entries, ...orders.filter(o => o.kind === 'exit' && ids.has(o.entryId))];
  }
  const exceptions = executionExceptions(orders);
  let trades = []; const groups = new Map();
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
    const trade = { symbol: entry.symbol, strategy: entry.strategy, entryId: entry.id, experimentId: entry.experiment?.experimentId ?? 'legacy',
      entryAt: entry.ts, closedAt: fullyClosed ? Math.max(...exits.map(o => o.filledAt ?? o.lastFillObservedAt ?? o.ts ?? 0)) || null : null,
      quantity, fullyClosed, grossPnl, estimatedFees, estimatedNetPnl: grossPnl - estimatedFees,
      observedPeakNet:entry.excursion?.peakNet??null, observedWorstNet:entry.excursion?.worstNet??null,
      observedGiveback:fullyClosed && Number.isFinite(entry.excursion?.peakNet) ? entry.excursion.peakNet-(grossPnl-estimatedFees):null,
      excursionNote:entry.excursion?.basis??'Historical quote excursions were not recorded', exitReason:entry.exitReason??exits.find(x=>x.reason)?.reason??null };
    trades.push(trade);
  }
  // Count a scaled position once, while exposing the added shares separately.
  // Date/version filters follow the original entry and include its entire campaign.
  const lots=trades; trades=[];
  for(const root of orders.filter(o=>o.kind==='entry' && !o.addition)) {
    const entries=campaignEntries(orders,root.id),ids=new Set(entries.map(o=>o.id)),rows=lots.filter(t=>ids.has(t.entryId));
    if(!rows.length)continue;
    const sum=key=>rows.reduce((n,t)=>n+t[key],0),fullyClosed=entries.every(o=>terminal(o.status) && Math.abs(remainingQty(orders,o))<1e-8) && rows.every(t=>t.fullyClosed);
    const peak=root.campaignExcursion?.peakNet ?? root.excursion?.peakNet ?? null;
    const trade={...rows[0],entryId:root.id,entryAt:root.ts,experimentId:root.experiment?.experimentId ?? 'legacy',fullyClosed,
      closedAt:fullyClosed?Math.max(...rows.map(t=>t.closedAt ?? 0))||null:null,quantity:sum('quantity'),
      grossPnl:sum('grossPnl'),estimatedFees:sum('estimatedFees'),estimatedNetPnl:sum('estimatedNetPnl'),
      addedQty:entries.filter(o=>o.addition).reduce((n,o)=>n+(o.filledQty ?? 0),0),
      additionNetPnl:rows.filter(t=>t.entryId!==root.id).reduce((n,t)=>n+t.estimatedNetPnl,0),
      observedPeakNet:peak,observedGiveback:fullyClosed && peak!==null?peak-sum('estimatedNetPnl'):null};
    trades.push(trade);
    const asset=isCrypto(trade.symbol)?'crypto':'equity',key=`${asset}:${trade.strategy}`;
    if(!groups.has(key))groups.set(key,{strategy:trade.strategy,asset,closed:0,partial:0,wins:0,grossPnl:0,estimatedFees:0,netPnl:0,values:[]});
    const g=groups.get(key);g.grossPnl+=trade.grossPnl;g.estimatedFees+=trade.estimatedFees;g.netPnl+=trade.estimatedNetPnl;
    if(fullyClosed){g.closed++;g.wins+=trade.estimatedNetPnl>0?1:0;g.values.push(trade.estimatedNetPnl);}else g.partial++;
  }
  for (const x of exceptions) { const asset=isCrypto(x.symbol)?'crypto':'equity',key=`${asset}:${x.strategy}`;if(!groups.has(key))groups.set(key,{strategy:x.strategy,asset,closed:0,partial:0,wins:0,grossPnl:0,estimatedFees:0,netPnl:0,values:[]}); }
  return { trades, exceptions, pnlAvailable: !exceptions.length, strategies: [...groups.values()].map(({ values, ...g }) => {
    const mean = values.length ? values.reduce((a,b) => a+b,0) / values.length : null;
    const variance = values.length > 1 ? values.reduce((a,b) => a + (b-mean)**2,0) / (values.length-1) : null;
    const unresolved = exceptions.filter(x => x.strategy === g.strategy);
    const wins = values.filter(x=>x>0), losses = values.filter(x=>x<0), average = xs=>xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : null;
    return { ...g, ...(unresolved.length ? { netPnl: null, grossPnl: null } : {}), exceptions: unresolved.length, winRate: g.closed ? g.wins / g.closed : null, meanNetPerClosedTrade: mean,
      averageWin:average(wins), averageLoss:average(losses), profitFactor:losses.length ? wins.reduce((a,b)=>a+b,0)/-losses.reduce((a,b)=>a+b,0) : null,
      standardError: variance === null ? null : Math.sqrt(variance / values.length),
      evidence: g.closed < 30 ? 'insufficient_sample' : 'paper_sample_requires_out_of_sample_validation' };
  }), note: 'Local agent fills only; frozen per-order fee rates or recorded simulator fees. Partial exits are separate. Crypto fee-in-kind or dust residuals remain partial until reconciled; this is not a broker fee ledger. Model/cloud costs and open P/L are excluded.' };
}

// Forward observations, not pretend fills. At most one overlapping observation
// per symbol prevents a 250ms scanner from reporting thousands of independent bets.
export class SignalOutcomes {
  pending = new Map();
  constructor(engine) { this.engine = engine; this.pending = new Map(engine.store.get('pendingSignalOutcomes',[])); }
  start(c) {
    if (!c.preflight?.ok || !c.model?.requested || !Number.isFinite(c.model.quality) || this.pending.has(c.symbol)) return;
    const e = this.engine, now = e.clock();
    this.pending.set(c.symbol, { candidateId: c.id, symbol: c.symbol, strategy: c.strategy, ts: now,
      modelPass: c.model.pass, modelQuality: c.model.quality, fingerprint: e.cfg.fingerprint,
      feeBps: isCrypto(c.symbol) ? e.cfg.cryptoFee : e.cfg.equityFee, slippageBps: e.cfg.slippage,
      delayMs: 1000, horizonMs: isCrypto(c.symbol) ? 900000 : 180000, entry: null });
    this.engine.store.set('pendingSignalOutcomes',[...this.pending]);
  }
  quote(q, now) {
    const p = this.pending.get(q.symbol); if (!p) return;
    const entryAt = p.ts + p.delayMs, exitAt = entryAt + p.horizonMs;
    if (!validateQuote(q, now, this.engine.cfg.maxQuoteAge)) return;
    if (!p.entry && q.ts >= entryAt && q.ts <= entryAt + 5000) {
      p.entry = q.ask * (1 + p.slippageBps / 10000);
      this.engine.store.set('pendingSignalOutcomes',[...this.pending]);
    }
    if (!p.entry && now > entryAt + 5000 || now > exitAt + 5000) return this.finish(p, null, 'missing_quote');
    if (p.entry && q.ts >= exitAt && q.ts <= exitAt + 5000) {
      const exit = q.bid * (1 - p.slippageBps / 10000);
      const netBps = ((exit * (1-p.feeBps/10000)) / (p.entry * (1+p.feeBps/10000)) - 1) * 10000;
      this.finish(p, netBps, 'observed');
    }
  }
  sweep(now) { for (const p of this.pending.values()) if (now > p.ts + p.delayMs + (p.entry ? p.horizonMs : 0) + 5000) this.finish(p, null, 'missing_quote'); }
  finish(p, netBps, state) {
    this.pending.delete(p.symbol);
    this.engine.store.transaction(()=>{
      this.engine.store.event('signal_outcome', { ...p, state, netBps, hypothetical: true }, this.engine.clock());
      this.engine.store.set('pendingSignalOutcomes',[...this.pending]);
    });
  }
  summary() {
    const rows = this.engine.store.eventsOfType('signal_outcome', this.engine.clock() - 7 * 86400000, 5000), groups = new Map();
    for (const r of rows) {
      const key = `${r.symbol}:${r.strategy}:${r.modelPass}:${r.fingerprint}`;
      if (!groups.has(key)) groups.set(key, { symbol: r.symbol, strategy: r.strategy, modelPass: r.modelPass, fingerprint: r.fingerprint, count: 0, missing: 0, totalNetBps: 0 });
      const g = groups.get(key); if (r.state === 'observed') { g.count++; g.totalNetBps += r.netBps; } else g.missing++;
    }
    return { pending: this.pending.size, rows: [...groups.values()].map(g => ({ ...g, meanNetBps: g.count ? g.totalNetBps/g.count : null })),
      note: 'Forward quote markouts after a 1s entry delay: 3m equities / 15m crypto, ask-to-bid with fees and slippage. One overlapping sample per symbol; missing quotes excluded. These are hypothetical observations, not executable returns or a causal test of Jev. Pending observations survive restart; missed windows become missing quotes. Last 7 days, at most 5,000 records.' };
  }
}
