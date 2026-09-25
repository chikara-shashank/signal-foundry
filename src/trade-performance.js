import { campaignId } from './position-book.js';
import { isCrypto, positive, terminal, validateQuote } from './util.js';

const DAY = 86400000;
export const TRADE_MARK_INTERVAL = 10000;
const fillTime = o => positive(o.filledAt) ? o.filledAt : positive(o.lastFillObservedAt) ? o.lastFillObservedAt : null;
const timeSource = o => positive(o.filledAt) ? 'fill' : positive(o.lastFillObservedAt) ? 'first observed fill' : 'unavailable';

// One campaign is one entry plus its explicitly linked additions. Never join
// unrelated trades just because they share a ticker, or use order intent as fill time.
export function tradeCampaigns(engine) {
  const orders = engine.store.orders(), groups = new Map(), exits = new Map(), now = engine.clock();
  for (const o of orders) {
    if (o.kind === 'entry') {
      const id = campaignId(o); if (!groups.has(id)) groups.set(id, []); groups.get(id).push(o);
    } else if (o.kind === 'exit') {
      if (!exits.has(o.entryId)) exits.set(o.entryId, []); exits.get(o.entryId).push(o);
    }
  }
  const rows = [];
  for (const [id, lots] of groups) {
    if (!lots.some(o => o.filledQty > 0)) continue;
    const root = lots.find(o => o.id === id), first = root ?? lots[0];
    let problem = !root || lots.some(o => o.symbol !== first.symbol || o.strategy !== first.strategy || (o.addition && !root?.addPolicy)) ? 'Invalid campaign linkage' : null;
    let cost = 0, proceeds = 0, fees = 0, exitFeeRateValue = 0, bought = 0, sold = 0, settled = true;
    const fills = [];
    const fee = (o, parent = o) => {
      const rate = o.feeRateBps ?? parent.feeRateBps ?? (isCrypto(first.symbol) ? engine.cfg.cryptoFee : engine.cfg.equityFee);
      const value = o.fee ?? o.filledQty * o.fillPrice * rate / 10000;
      if (!Number.isFinite(value) || value < 0 || !Number.isFinite(rate) || rate < 0) problem = 'Invalid fee record';
      return value;
    };
    for (const entry of lots) {
      const closing = [...new Map([...(exits.get(entry.id) ?? []), ...(entry.legs ?? [])].map(o => [o.brokerId ?? o.id, o])).values()];
      const qty = entry.filledQty ?? 0, exited = closing.reduce((n, o) => n + (o.filledQty ?? 0), 0);
      if (entry.replacedBy || closing.some(o => o.replacedBy)) problem = 'Replaced order requires review';
      if (exited > qty + 1e-8) problem = 'Exit quantity exceeds entry fills';
      settled &&= terminal(entry.status) && closing.every(o => terminal(o.status));
      for (const o of [entry, ...closing]) {
        const n = o.filledQty ?? 0;
        if (!Number.isFinite(n) || n < 0 || (n > 0 && !positive(o.fillPrice))) problem = 'Invalid fill record';
        if (!(n > 0)) continue;
        const buy = o === entry;
        fees += fee(o, entry);
        if (buy) { bought += n; cost += n * o.fillPrice; }
        else { sold += n; proceeds += n * o.fillPrice; }
        fills.push({ id: o.id ?? o.brokerId, type: buy ? entry.addition ? 'add' : 'entry' : 'exit', ts: fillTime(o), timeSource: timeSource(o), qty: n, price: o.fillPrice });
      }
      exitFeeRateValue += (qty - exited) * (entry.feeRateBps ?? (isCrypto(first.symbol) ? engine.cfg.cryptoFee : engine.cfg.equityFee)) / 10000;
    }
    const remaining = bought - sold, flat = Math.abs(remaining) <= 1e-8;
    const status = flat && settled ? 'closed' : flat ? 'settling' : 'active';
    const entryFill = fills.find(f => f.type === 'entry');
    const firstObserved = positive(root?.firstFillObservedAt) ? root.firstFillObservedAt : null;
    const useFirstObserved = firstObserved != null && (entryFill?.ts == null || firstObserved < entryFill.ts);
    const exitFills = fills.filter(f => f.type === 'exit');
    const closedAt = status === 'closed' && exitFills.length && exitFills.every(f => f.ts != null) ? Math.max(...exitFills.map(f => f.ts)) : null;
    const quote = engine.quotes.get(first.symbol);
    const syncFresh = engine.lastReconcile > 0 && Date.now() - engine.lastReconcile <= 30000 && !engine.issues.includes('broker_reconciliation_failed');
    if (status !== 'closed' && (!engine.portfolio.state.valid || engine.portfolio.state.conflicts.includes(first.symbol))) problem ??= 'Position reconciliation unavailable';
    // The journal may change between reconciliations. A fresh quote alone cannot
    // make an unconfirmed position quantity safe to value.
    if (!flat && (engine.managed[first.symbol]?.entryId !== id || Math.abs((engine.positions.find(p => p.symbol === first.symbol)?.qty ?? 0) - remaining) > 1e-7)) problem ??= 'Position quantity not reconciled';
    const fresh = validateQuote(quote, now, engine.cfg.maxQuoteAge);
    const available = !problem && (status === 'closed' || (syncFresh && (flat || fresh)));
    const bid = !flat && available ? quote.bid : null;
    const estimatedExitFees = !flat && available ? bid * exitFeeRateValue : 0;
    const net = available ? proceeds + (flat ? 0 : remaining * bid) - cost - fees - estimatedExitFees : null;
    const entryFees = lots.filter(o => o.filledQty > 0).reduce((n, o) => n + fee(o), 0);
    const capital = cost + entryFees;
    const returnPct = net != null && positive(capital) && Number.isFinite(net) ? net / capital * 100 : null;
    rows.push({ id, symbol: first.symbol, strategy: first.strategy, status, entryAt: useFirstObserved ? firstObserved : entryFill?.ts ?? null,
      entryTimeSource: useFirstObserved ? 'first observed entry fill' : entryFill?.timeSource ?? 'unavailable', intentAt: first.ts, closedAt,
      qty: remaining, boughtQty: bought, soldQty: sold, entryPrice: bought > 0 ? cost / bought : null,
      capital, net, returnPct, bid,
      asOf: status === 'closed' ? closedAt : available ? now : null, quoteAt: bid != null ? quote.ts : null,
      reason: problem ?? (!available ? !syncFresh ? 'Broker reconciliation is stale' : 'Waiting for a fresh bid' : null),
      fills, estimatedExitFees });
  }
  return rows;
}

// Run after reconciliation, never on the quote or order submission path. Reads
// from the dashboard do not write history or cause any broker requests.
export function recordTradeMarks(engine) {
  const now = engine.clock();
  if (now - (engine.lastTradeMarkAt ?? -Infinity) < TRADE_MARK_INTERVAL) return;
  const rows = tradeCampaigns(engine).filter(r => r.status !== 'closed' && r.returnPct != null);
  engine.store.transaction(() => {
    for (const r of rows) engine.store.tradeMark(r.id, { ts: now, returnPct: r.returnPct, net: r.net, qty: r.qty, capital: r.capital, bid: r.bid, quoteAt: r.quoteAt });
  });
  engine.lastTradeMarkAt = now;
}

// Thin each bucket to endpoints and extrema. Keep timestamps and gap markers;
// the browser must never connect over an unobserved interval.
export function thinTradeMarks(points, max = 320, gapMs = 30000) {
  const stride = Math.max(1, Math.ceil(points.length / Math.max(1, max / 4))), result = [];
  let previous = null;
  for (let i = 0; i < points.length; i += stride) {
    const group = points.slice(i, i + stride), keep = new Set([0, group.length - 1]);
    let min = 0, maxIndex = 0;
    for (let j = 0; j < group.length; j++) {
      if (group[j].returnPct < group[min].returnPct) min = j;
      if (group[j].returnPct > group[maxIndex].returnPct) maxIndex = j;
      const before = points[i + j - 1];
      if (before && group[j].ts - before.ts > gapMs) { keep.add(j); if (j) keep.add(j - 1); }
    }
    keep.add(min); keep.add(maxIndex);
    for (const j of [...keep].sort((a, b) => a - b)) {
      const p = group[j], rawIndex = i + j;
      // Connect only if every underlying interval was observed.
      const breakBefore = previous != null && points.slice(previous + 1, rawIndex + 1).some((v, k) => v.ts - points[previous + k].ts > gapMs);
      result.push({ ...p, breakBefore }); previous = rawIndex;
    }
  }
  return result;
}

export function tradePerformanceData(engine, days = 1) {
  if (![1, 7, 30].includes(days)) throw new Error('Choose a 1, 7 or 30 day range');
  const now = engine.clock(), since = now - days * DAY;
  const all = tradeCampaigns(engine).filter(r => r.status !== 'closed' || (r.closedAt ?? r.intentAt) >= since)
    .sort((a, b) => Number(a.status === 'closed') - Number(b.status === 'closed') || (b.closedAt ?? b.entryAt ?? b.intentAt) - (a.closedAt ?? a.entryAt ?? a.intentAt));
  const gapMs = engine.cfg.mode === 'demo' ? 120000 : 30000;
  const trades = all.slice(0, 100).map(row => {
    // A delayed broker fill report may reveal that an exit preceded our last
    // observation. Do not draw valuations after the subsequently confirmed exit.
    const raw = engine.store.tradeMarks(row.id, since, Math.min(now, row.closedAt ?? now), 3001), historyLimited = raw.length > 3000;
    const points = thinTradeMarks(raw.slice(-3000), 320, gapMs);
    return { ...row, points, historyLimited };
  });
  return { now, since, days, mode: engine.cfg.mode, gapMs, trades, total: all.length, truncated: all.length > trades.length,
    recordingError: engine.tradeMarkError ?? null,
    note: 'Engine-owned stock/crypto campaigns only; options research and external holdings are excluded. Return = (realized proceeds + remaining shares at the bid − all filled buy costs − trading fees, including estimated exit fees) / (all filled buy costs + entry fees). Additions and partial exits are included. Fees are provisional; model and operating costs are excluded. Entry triangles mark a 0% reference, not an after-cost valuation. Fill markers use cumulative average fills, not individual executions. Solid paths are recorded observations; dotted connectors show endpoints only. Missing observations are not reconstructed.' };
}
