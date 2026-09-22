import { isCrypto, nyDate, positive, validateQuote } from './util.js';

// OCC option roots also reserve their configured underlying against new entries.
// No option price is converted into an equity price or an agent-owned position.
export function relatedSymbol(symbol) { return symbol.match(/^([A-Z][A-Z0-9.]{0,5})\d{6}[CP]\d{8}$/)?.[1] ?? symbol; }
export function quantityTolerance(entry, cfg, asset) {
  return isCrypto(entry.symbol) ? entry.filledQty * (entry.feeRateBps ?? cfg.cryptoFee) / 10000 * 1.5 + (asset?.min_trade_increment ?? 1e-8) : 1e-7;
}

export class Portfolio {
  constructor(engine) { this.engine = engine; this.state = { valid: false, managedGross: 0, externalGross: 0, dailyPnl: null, unrealized: null, cashAvailable: 0, conflicts: [], reservedSymbols: [] }; this.positions = []; }
  refresh(positions, orders, account, now) {
    const e = this.engine, cfg = e.cfg, shared = cfg.accountPolicy === 'shared';
    const matched = new Set(), conflicts = new Set(); let cashFlow = 0, fees = 0, mark = 0, unrealized = 0, valid = true;
    const fee = (o, parent) => {
      if (!Number.isFinite(o.filledQty) || o.filledQty < 0 || (o.filledQty > 0 && !positive(o.fillPrice))) { valid = false; return; }
      if (!o.filledQty) return;
      fees += Number.isFinite(o.fee) && o.fee >= 0 ? o.fee : o.filledQty * o.fillPrice * (o.feeRateBps ?? parent?.feeRateBps ?? (isCrypto(o.symbol ?? parent?.symbol) ? cfg.cryptoFee : cfg.equityFee)) / 10000;
    };
    for (const entry of orders.filter(o => o.kind === 'entry')) {
      fee(entry); if (!(entry.filledQty > 0)) continue;
      cashFlow -= entry.filledQty * entry.fillPrice;
      const exits = [...orders.filter(o => o.kind === 'exit' && o.entryId === entry.id), ...(entry.legs ?? [])];
      let exited = 0; const seen = new Set();
      for (const exit of exits) {
        const id = exit.brokerId ?? exit.id;
        if (id && seen.has(id)) continue; if (id) seen.add(id);
        fee(exit, entry); exited += exit.filledQty ?? 0; cashFlow += (exit.filledQty ?? 0) * (exit.fillPrice ?? 0);
      }
      const expected = entry.filledQty - exited, tolerance = quantityTolerance(entry, cfg, e.assets.get(entry.symbol));
      const p = positions.find(x => x.symbol === entry.symbol), owned = e.managed[entry.symbol]?.entryId === entry.id;
      // A native exit may reach the order endpoint before the position endpoint.
      // Both increases and reductions in a managed quantity need reconciliation.
      if (expected < -tolerance || (expected > tolerance && (!owned || !p || Math.abs(p.qty - expected) > tolerance)) ||
          (owned && expected <= tolerance && p?.qty > tolerance)) {
        conflicts.add(entry.symbol); valid = false; continue;
      }
      if (expected > tolerance && p) {
        const q = e.quotes.get(entry.symbol), price = validateQuote(q, now, cfg.maxQuoteAge) ? q.bid : p.marketValue / p.qty;
        if (!positive(price)) { valid = false; continue; }
        matched.add(entry.symbol); mark += p.qty * price; unrealized += p.qty * (price - entry.fillPrice);
      }
    }
    this.positions = positions.filter(p => matched.has(p.symbol));
    const external = positions.filter(p => !matched.has(p.symbol));
    const totalPnl = cashFlow + mark - fees;
    valid &&= [cashFlow, fees, totalPnl, account.cash, account.buyingPower].every(Number.isFinite);
    const prior = e.store.get('agentPnlTracking');
    if (valid && !prior) {
      e.store.set('agentPnlTracking', { startedAt: now });
      // Never silently reset an already-triggered halt when migrating a book
      // that contains agent fills. This account's empty agent journal is distinct.
      if (orders.some(o => o.filledQty > 0) && e.store.get(`lossHalt:${nyDate(now)}`, false)) e.store.set(`agentLossHalt:${nyDate(now)}`, true);
    }
    const day = nyDate(now), baselineKey = `agentPnlBaseline:${day}`;
    if (valid && e.store.get(baselineKey) === null) e.store.set(baselineKey, { value: totalPnl, ts: now });
    const baseline = e.store.get(baselineKey), dailyPnl = valid && baseline ? totalPnl - baseline.value : null;
    if (dailyPnl !== null && dailyPnl <= -e.dailyLossLimit) e.store.set(`agentLossHalt:${day}`, true);
    let cashAvailable = account.cash;
    if (shared && valid) {
      if (e.store.get('sharedCashAnchor') === null) {
        const unresolvedDebit = orders.filter(o => o.kind === 'entry' && o.filledQty > 0 && !o.settledAt).reduce((sum, o) => sum + o.filledQty * o.fillPrice, 0);
        e.store.set('sharedCashAnchor', account.cash - cashFlow + fees - unresolvedDebit);
      }
      // Own fills affect this ceiling even if broker cash lags. External credits
      // do not increase it. Actual cash/buying power still cap every submission.
      cashAvailable = Math.max(0, Math.min(account.cash, account.buyingPower, e.store.get('sharedCashAnchor') + cashFlow - fees, cfg.capital + cashFlow - fees));
    }
    this.state = { policy: cfg.accountPolicy, valid, totalPnl: valid ? totalPnl : null, dailyPnl, unrealized: valid ? unrealized : null,
      cashAvailable: valid ? cashAvailable : 0, estimatedFees: fees, baselineAt: baseline?.ts ?? null,
      managedGross: this.positions.reduce((sum, p) => sum + Math.abs(p.marketValue), 0),
      externalGross: external.reduce((sum, p) => sum + Math.abs(p.marketValue), 0),
      conflicts: [...conflicts], reservedSymbols: [...new Set(external.flatMap(p => [p.symbol, relatedSymbol(p.symbol)]))],
      accountDailyHalt: e.store.get(`lossHalt:${day}`, false), agentDailyHalt: e.store.get(`agentLossHalt:${day}`, false),
      note: 'Agent P/L uses local fills and current marks, with reported simulator fees or estimated broker trading fees. External positions, external cash transfers and model/cloud charges are excluded. Daily change starts at the first valid agent observation of the New York date.' };
    return this.state;
  }
}
