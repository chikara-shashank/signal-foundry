import { hash, nyDate, validateQuote } from './util.js';
import { ALTERNATIVES_POLICY as A } from './trade-alternatives-policy.js';
import { routesFor } from './trade-alternatives.js';
import { optionLegs } from './options-structure.js';
import { spreadEconomics } from './options-pricing.js';
import { relatedSymbol } from './portfolio.js';
import { PAPER_ROUTE_POLICY as P, routeActive, finished, shortBody, spreadBody, mergeRouteOrder, routeExposure, validatePaperBody } from './paper-route-orders.js';

// Separate signed-position journal: legacy long-only exits never see these orders.
export class PaperRoutes {
  constructor(engine) {
    this.engine = engine;
    this.state = engine.store.get('paperRoutes', { schema: 1, enabled: false, revision: 0, trades: [], seen: {}, cursor: 0 });
    if (this.state.schema !== 1 || !Array.isArray(this.state.trades)) throw new Error('Invalid paper route journal');
    this.stats = { valid: !this.state.trades.some(routeActive), cashFlow: 0, fees: 0, mark: 0, unrealized: 0, totalPnl: 0, symbols: [], conflicts: [] };
    this.lastFrame = null; this.lastDecision = null; this.lastReconcile = 0;
  }
  paperOnly() { return this.engine.cfg.mode === 'paper' && this.engine.cfg.brokerUrl === 'https://paper-api.alpaca.markets'; }
  enabled() { return this.paperOnly() && this.state.enabled; }
  active() { return this.state.trades.filter(routeActive); }
  needsData() { return this.enabled() || this.active().length > 0; }
  reserved(symbol) { return this.active().some(t => t.symbol === relatedSymbol(symbol)); }
  owns(symbol) { return this.stats.symbols.includes(symbol); }
  ownsOrder(o) { return this.state.trades.some(t => t.orders.some(x => o.id && x.id === o.id || o.brokerId && (x.brokerId === o.brokerId || x.legs?.some(l => l.brokerId === o.brokerId)))); }
  capitalReserved() { return this.active().reduce((n,t) => n + t.reserved, 0); }
  watched() { return this.active().filter(t => t.candidate).flatMap(t => optionLegs(t.candidate).map(l => l.contract)); }
  accountingOrders() { return this.state.trades.flatMap(t => t.orders.flatMap(o => o.body.legs ? o.legs ?? [] : [o])); }
  save(type, data) {
    const e = this.engine; e.store.assertLease();
    e.store.transaction(() => { e.store.set('paperRoutes', this.state); if (type) e.store.event(`paper_route_${type}`, data, e.clock()); });
  }
  async update(request) {
    if (!request || Object.keys(request).some(k => !['enabled','expectedRevision'].includes(k)) || typeof request.enabled !== 'boolean' || !Number.isInteger(request.expectedRevision)) throw Object.assign(new Error('Invalid paper route settings'), { status: 400 });
    return this.engine.mutex.run(() => {
      if (!this.paperOnly()) throw Object.assign(new Error('Broker paper account required'), { status: 409 });
      if (request.expectedRevision !== this.state.revision) throw Object.assign(new Error('Refresh paper route settings'), { status: 409 });
      if (request.enabled !== this.state.enabled) { this.state.enabled = request.enabled; this.state.revision++; this.save('settings', request); }
      return this.snapshot();
    });
  }
  snapshot() {
    return { enabled: this.enabled(), available: this.paperOnly(), revision: this.state.revision, paperOnly: true, policy: P, stats: this.stats,
      lastReconcile: this.lastReconcile, lastDecision: this.lastDecision, trades: this.state.trades.slice(-20).reverse(),
      entryGate: this.engine.cfg.jevMode === 'filter' ? 'jev_route_review_required' : null,
      note: 'Broker-paper executions, separate from shadow comparisons. These routes have no direction/structure-specific Jev review yet, so Jev filter mode blocks new entries. Owned exits remain managed. One active route; stock shorts and one-contract debit verticals only. Options exits require this service. No live execution or automatic sizing promotion.' };
  }
  async send(t, body, kind) {
    if (!this.paperOnly()) throw new Error('paper_routes_forbidden_in_live');
    if (kind === 'entry' && this.engine.cfg.jevMode === 'filter') throw new Error('jev_route_review_required');
    const id = 'sf-pr-' + hash([t.id, kind, t.orders.length]).slice(0,24);
    const o = { id, body: validatePaperBody({ ...body, client_order_id: id }), kind, ts: this.engine.clock(), status: 'submitting', filledQty: 0, legs: [] };
    t.orders.push(o); this.save('submitting', { tradeId: t.id, order: o });
    this.stats.valid = false;
    this.engine.ready = false; this.engine.issues = [...new Set([...this.engine.issues, 'paper_route_reconciliation_required'])];
    try { mergeRouteOrder(o, await this.engine.broker.submitPaperRoute(o.body)); }
    catch (error) { o.status = error.notSent ? 'aborted' : 'unknown'; o.error = error.notSent ? 'request_budget' : 'submission_outcome_unknown'; }
    this.save('order', { tradeId: t.id, order: o });
    this.engine.scheduleReconcile?.();
    return o;
  }
  async cancel(o) {
    if (!this.paperOnly() || !o.brokerId || finished(o) || this.engine.clock() - (o.cancelAt ?? 0) < 5000) return;
    o.cancelAt = this.engine.clock(); this.save('cancel_requested', { orderId: o.brokerId });
    try { await this.engine.broker.cancel(o); } catch { /* Confirmation must come from reconciliation. */ }
  }
  entryBlock(f) {
    const e = this.engine, now = e.clock(), a = e.account;
    if (!this.enabled()) return 'disabled';
    if (e.cfg.jevMode === 'filter') return 'jev_route_review_required';
    if (!e.ready || e.stopped || e.operatorPause || !this.stats.valid || now - this.lastReconcile > 15000) return 'engine_not_ready';
    if (!a || a.blocked || now - a.ts > 15000 || e.timebase && !e.timebase.status().synchronized) return 'account_or_clock_unavailable';
    if (e.store.get(e.lossHaltKey(now), false) || e.riskLevels.halted() || e.store.get(`paperRouteHalt:${nyDate(now)}`, false)) return 'loss_limit';
    if (!e.session?.open || e.session.close - now < P.maxHoldMs + P.closeBufferMs || now - f.now > 5000 || f.now > now + 1000 || !f.marketOpen || f.source !== 'alpaca_opra' || f.stockFeed !== 'sip' || !(f.clockUncertaintyMs >= 0 && f.clockUncertaintyMs <= 1000)) return 'session_or_data_unavailable';
    if (this.active().length >= P.maxPositions) return 'route_position_limit';
    if (!e.broker.entryBudgetAvailable()) return 'broker_request_budget';
    return null;
  }
  async observe(f) {
    this.lastFrame = f;
    const e = this.engine, now = e.clock(), blocked = this.entryBlock(f);
    if (blocked) { this.lastDecision = { at: now, reason: blocked }; return; }
    const brake = e.riskLevels.brakeFactor(), riskCap = Math.min(P.maxRisk * brake,
      e.riskLevels.active ? e.account.equity * e.riskLevels.policy.maxAccountRiskPct / 100 : Infinity);
    const candidates = [];
    for (const symbol of ['SPY','QQQ']) {
      const bar = f.contexts?.[symbol]?.barEnd;
      if (!Number.isFinite(bar) || (this.state.seen[symbol] ?? 0) >= bar) continue;
      if (e.managed[symbol] || e.positions.some(p => relatedSymbol(p.symbol) === symbol) || e.pending().some(o => relatedSymbol(o.symbol) === symbol) ||
          e.openOrders.some(o => relatedSymbol(o.symbol ?? '') === symbol || o.legs?.some(l => relatedSymbol(l.symbol) === symbol))) continue;
      this.state.seen[symbol] = bar;
      for (const r of routesFor(symbol, f).filter(r => r.state === 'pending' && ['stock_short','call_debit','put_debit'].includes(r.id))) {
        const t = { id: hash([e.account.id, symbol, bar, r.id]).slice(0,24), symbol, route: r.id, at: now, bar, orders: [],
          closeBy: Math.min(now + P.maxHoldMs, f.session.close - P.closeBufferMs), context: f.contexts[symbol], candidate: r.candidate ?? null,
          account: e.account.id, symbols: r.candidate ? optionLegs(r.candidate).map(l => l.contract.symbol) : [symbol] };
        if (r.id === 'stock_short') {
          if (e.account.shortingEnabled !== true || e.account.equity < 2000) continue;
          t.limit = Math.floor(r.limit * 100) / 100; t.stop = Math.ceil(r.stop * 100) / 100; t.target = Math.floor(r.target * 100) / 100;
          const unitRisk = t.stop - t.limit + t.stop * A.stockSlippageBps / 10000 + (t.limit + t.stop) * A.stockFeeBps / 10000;
          t.qty = Math.min(r.quantity, Math.floor(P.shortNotional * brake / t.limit), Math.floor(riskCap / unitRisk)); if (t.qty < 1) continue;
          t.risk = unitRisk * t.qty; t.reserved = t.qty * t.limit * 1.5;
        } else {
          if (!(e.account.optionsTradingLevel >= 3)) continue;
          t.limit = Math.ceil(r.limit * 100 - 1e-8) / 100; t.qty = 1; t.risk = t.limit * 100 + 4 * P.optionFee;
          t.reserved = Math.max(r.candidate.width * 100, t.risk);
          if (!(e.account.optionsBuyingPower >= t.reserved)) continue;
        }
        if (!(t.risk > 0 && t.risk <= riskCap)) continue;
        const pending = e.pending().filter(o => o.kind === 'entry').reduce((n,o) => n + o.reserved, 0);
        const gross = e.cfg.accountPolicy === 'shared' ? e.portfolio.state.managedGross : e.positions.reduce((n,p) => n + Math.abs(p.marketValue), 0);
        const capacity = Math.min(e.cfg.capital - gross - pending, e.cfg.maxGross - gross - pending,
          e.cfg.maxGroup - e.positions.filter(p => !p.symbol.includes('/')).reduce((n,p) => n + Math.abs(p.marketValue),0) - pending,
          e.account.cash - pending, e.account.buyingPower - pending, e.portfolio.state.cashAvailable - pending);
        if (t.reserved > capacity || e.cfg.maxPositions > 0 && e.portfolio.positions.length + e.pending().filter(o => o.kind === 'entry').length >= e.cfg.maxPositions) continue;
        candidates.push(t);
      }
    }
    this.save();
    if (!candidates.length) { this.lastDecision = { at: now, reason: 'no_eligible_route_with_capacity' }; return; }
    // Fixed rotation among eligible hypotheses; this is paper execution validation, not a profit forecast.
    const t = candidates[this.state.cursor++ % candidates.length]; this.state.trades.push(t);
    this.lastDecision = { at: now, symbol: t.symbol, route: t.route, reason: 'submitted_to_paper_broker' };
    await this.send(t, t.route === 'stock_short' ? shortBody(t) : spreadBody(t), 'entry');
  }
  async reconcile(open, positions, account, now) {
    if (this.active().length && !this.paperOnly()) throw new Error('paper_route_exposure_in_wrong_mode');
    if (this.state.trades.some(t => t.account !== account.id)) throw new Error('paper_route_account_changed');
    const conflicts = [], symbols = []; let cashFlow = 0, fees = 0, mark = 0, unrealized = 0;
    for (const t of this.state.trades) {
      if (routeActive(t)) {
        if (t.incident) conflicts.push(t.symbol);
        for (const o of t.orders) {
          if (finished(o) && (o.kind !== 'entry' || t.route !== 'stock_short')) continue;
          try {
            const remote = open.find(x => x.id === o.id) ?? await this.engine.broker.find(o.id, o.brokerId, 'protection');
            if (remote) mergeRouteOrder(o, remote); else if (!finished(o)) o.status = 'unknown';
          } catch { o.error = 'order_reconciliation_unavailable'; conflicts.push(t.symbol); }
        }
        if (t.orders.some(o => !finished(o) && ['unknown','submitting'].includes(o.status))) conflicts.push(t.symbol);
      }
      const x = routeExposure(t); cashFlow += x.cashFlow; fees += x.fees;
      if (!routeActive(t)) continue;
      let tradeMark = 0;
      for (const [symbol, qty] of Object.entries(x.expected)) {
        const p = positions.find(p => p.symbol === symbol);
        if (!Number.isFinite(qty) || Math.abs(qty - (p?.qty ?? 0)) > 1e-7 || qty && (!Number.isFinite(p.marketValue) || Math.sign(p.marketValue) !== Math.sign(qty))) { conflicts.push(t.symbol); continue; }
        if (qty) { symbols.push(symbol); tradeMark += p.marketValue; unrealized += Number.isFinite(p.unrealized) ? p.unrealized : 0; }
      }
      if (t.route !== 'stock_short') {
        const legs = optionLegs(t.candidate), quantities = legs.map(l => x.expected[l.contract.symbol]);
        if (!(quantities.every(q => q === 0) || legs.every((l,i) => quantities[i] === (l.side === 'long' ? 1 : -1)))) conflicts.push(t.symbol);
        // Assignment/exercise may create stock exposure. Never adopt or flatten an unproven lot.
        if (positions.some(p => p.symbol === t.symbol)) conflicts.push(t.symbol);
      } else if (x.expected[t.symbol] > 0 || x.expected[t.symbol] < -t.qty) conflicts.push(t.symbol);
      mark += tradeMark; t.net = x.cashFlow + tradeMark - x.fees;
      const allTerminal = t.orders.every(o => finished(o) && (t.route !== 'stock_short' || (o.legs ?? []).every(finished)));
      if (!conflicts.includes(t.symbol) && allTerminal && Object.values(x.expected).every(q => Math.abs(q) < 1e-7)) t.closedAt = now;
    }
    this.stats = { valid: conflicts.length === 0, cashFlow, fees, mark, unrealized, totalPnl: cashFlow + mark - fees, symbols: [...new Set(symbols)], conflicts: [...new Set(conflicts)] };
    const key = `paperRouteBaseline:${nyDate(now)}`;
    if (this.stats.valid && this.engine.store.get(key) === null) this.engine.store.set(key, this.stats.totalPnl);
    this.stats.dailyPnl = this.stats.valid ? this.stats.totalPnl - (this.engine.store.get(key) ?? this.stats.totalPnl) : null;
    if (this.stats.dailyPnl !== null && this.stats.dailyPnl <= -P.dailyLoss) this.engine.store.set(`paperRouteHalt:${nyDate(now)}`, true);
    this.lastReconcile = now; this.save();
  }
  flatten() { for (const t of this.active()) t.exitReason ||= 'operator_flatten'; this.save('flatten_requested', {}); }
  async manage(now) {
    const e = this.engine;
    if (!this.paperOnly()) return;
    for (const t of this.active()) {
      const entry = t.orders[0]; if (!entry) continue;
      const x = routeExposure(t), held = Object.values(x.expected).some(q => q !== 0);
      if (!finished(entry) && (now - entry.ts >= P.entryTtlMs || e.operatorPause || !this.enabled() || t.exitReason || e.store.get(e.lossHaltKey(now), false))) await this.cancel(entry);
      if (!held) {
        if (finished(entry) && t.route === 'stock_short') for (const leg of entry.legs ?? []) if (!finished(leg)) await this.cancel(leg);
        continue;
      }
      if (this.stats.conflicts.includes(t.symbol)) continue;
      if (now >= t.closeBy || e.session?.close - now <= P.closeBufferMs) t.exitReason ||= 'holding_deadline';
      if (e.store.get(e.lossHaltKey(now), false) || e.store.get(`paperRouteHalt:${nyDate(now)}`, false) || e.riskLevels.halted()) t.exitReason ||= 'loss_limit';
      if (['canceled','expired','rejected'].includes(entry.status)) t.exitReason ||= 'partial_entry';
      if (t.route === 'stock_short') {
        const q = this.lastFrame?.spots?.[t.symbol] ?? e.quotes.get(t.symbol);
        const native = (entry.legs ?? []).filter(o => !finished(o));
        if (validateQuote(q, now, e.cfg.maxQuoteAge) && (q.ask >= t.stop || q.ask <= t.target)) t.exitReason ||= q.ask >= t.stop ? 'stop' : 'target';
        if (now - entry.ts > 30000 && !native.some(l => ['stop','stop_limit'].includes(l.type) && !['held','pending_new'].includes(l.status))) t.exitReason ||= 'broker_stop_missing';
      } else {
        const f = this.lastFrame;
        if (!f || now - f.now > P.quoteGapMs) t.exitReason ||= 'option_quote_gap';
        if (f && now - f.now <= P.quoteGapMs) {
          const value = spreadEconomics(t.candidate, f.quotes, now, undefined, false);
          if (!value.reason) t.lastQuoteAt = value.oldestQuote;
          if (!value.reason && value.exitValue <= t.limit * .5) t.exitReason ||= 'option_stop';
          if (!value.reason && value.exitValue >= t.limit * 1.5) t.exitReason ||= 'option_target';
          const short = t.candidate.short, spot = f.spots[t.symbol]?.price;
          if (short && (short.type === 'call' ? spot >= short.strike : spot <= short.strike)) t.exitReason ||= 'short_leg_in_money';
        }
        if (now - (t.lastQuoteAt ?? t.at) > P.quoteGapMs) t.exitReason ||= 'option_quote_gap';
      }
      if (!t.exitReason) continue; this.save();
      if (!e.session?.open || e.schedule && !e.schedule.state().regular || e.timebase && !e.timebase.status().synchronized) continue;
      if (!finished(entry)) { await this.cancel(entry); continue; }
      if (t.orders.some(o => o.kind === 'exit' && !finished(o))) continue;
      const native = t.route === 'stock_short' ? (entry.legs ?? []).filter(o => !finished(o)) : [];
      if (native.length) { for (const leg of native) await this.cancel(leg); continue; }
      if (t.symbols.some(symbol => { const p = e.positions.find(p => p.symbol === symbol); return !p || Math.abs(p.availableQty) + 1e-7 < Math.abs(x.expected[symbol]); })) continue;
      if (t.orders.filter(o => o.kind === 'exit').length >= 3) { t.incident = 'exit_attempts_exhausted'; this.stats.valid = false; this.stats.conflicts = [t.symbol]; this.save('exit_attempts_exhausted', { tradeId: t.id }); continue; }
      await this.send(t, t.route === 'stock_short' ? { symbol: t.symbol, side: 'buy', qty: String(-x.expected[t.symbol]), type: 'market', time_in_force: 'day' } : spreadBody(t, true), 'exit');
    }
  }
}
