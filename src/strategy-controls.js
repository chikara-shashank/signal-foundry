import { STRATEGY_REGISTRY, strategyDefinition, noiseUnavailable } from './strategy-registry.js';
import { tradeScorecard } from './research.js';
import { terminal, uncertain, validateQuote } from './util.js';
import { qualification } from './strategy-manifest.js';
import { supportsAdditions, ADD_POLICY } from './pyramiding.js';
import { campaignMark } from './position-book.js';

const invalid = message => Object.assign(new Error(message), { status: 400 });
const conflict = message => Object.assign(new Error(message), { status: 409 });

export class StrategyControls {
  constructor(engine) {
    this.engine = engine;
    const saved = engine.store.get('strategySettings');
    if (saved && (!Number.isSafeInteger(saved.revision) || saved.revision < 0 || !saved.strategies || typeof saved.strategies !== 'object')) throw new Error('Invalid saved strategy settings');
    this.state = { revision: saved?.revision ?? 0, strategies: {} };
    for (const { id } of STRATEGY_REGISTRY) {
      const setting = saved?.strategies[id];
      if (setting && (typeof setting.enabled !== 'boolean' || !Number.isSafeInteger(setting.generation) || setting.generation < 0 || !Number.isFinite(setting.changedAt))) throw new Error('Invalid saved strategy setting: ' + id);
      // New strategies default off. The explicitly requested carry experiment is
      // seeded by OVERNIGHT_ENTRIES; a saved manual choice always wins.
      if(setting?.addToWinners!==undefined && typeof setting.addToWinners!=='boolean')throw new Error('Invalid saved add-to-winners setting: '+id);
      const requestedCarry=id==='close_strength_carry'&&engine.cfg.overnight.enabled&&['paper','shadow'].includes(engine.cfg.mode);
      this.state.strategies[id] = { addToWinners:false,...(setting ?? { enabled: requestedCarry || (!saved && engine.cfg.strategies.includes(id)), generation: 0, changedAt: 0 }) };
    }
  }
  enabled(id) { return this.state.strategies[id]?.enabled === true; }
  additionsEnabled(id) { return supportsAdditions(id) && this.state.strategies[id]?.addToWinners === true; }
  generation(id) { return this.state.strategies[id]?.generation ?? -1; }
  enabledIds() { return STRATEGY_REGISTRY.filter(s => this.enabled(s.id)).map(s => s.id); }
  unavailable(id) {
    const e = this.engine, definition = strategyDefinition(id);
    if (!definition) return 'Historical strategy; no installed execution handler.';
    if (id === 'noise_area' && e.portfolio.state.reservedSymbols.includes(e.cfg.noiseSymbol)) return 'Underlying reserved by an external holding; no idle capital reserved.';
    if (definition.trigger === 'session') {
      if (id === 'monthly_trend') return !['paper','shadow'].includes(e.cfg.mode) ? 'Monthly trend is a paper/shadow experiment.' : !e.cfg.overnight.enabled ? 'Overnight entries are disabled in configuration.' : !e.monthlyTrend || !e.schedule ? 'Daily history and calendar services are not running.' : e.cfg.universe?.mode !== 'all' && !e.cfg.equities.some(s => ['SPY','QQQ','IWM'].includes(s)) ? 'Add SPY, QQQ or IWM to the equity universe.' : null;
      if(id==='close_strength_carry')return !['paper','shadow'].includes(e.cfg.mode)?'Carry entries are a paper/shadow experiment.':!e.cfg.overnight.enabled?'Overnight entries are disabled in configuration.':!e.desk||!e.schedule?'Closing research and calendar services are not running.':null;
      if (id === 'vwap_trend') return !['paper','shadow'].includes(e.cfg.mode) ? 'VWAP trend is a paper/shadow experiment.' : !['SPY','QQQ'].includes(e.cfg.noiseSymbol) ? 'Research supports SPY/QQQ only; choose NOISE_AREA_SYMBOL accordingly.' : !e.vwapTrend || !e.schedule ? 'Session VWAP and calendar services are not running.' : (e.cfg.universe?.mode !== 'all' && !e.cfg.equities.includes(e.cfg.noiseSymbol)) ? 'Add NOISE_AREA_SYMBOL to the equity universe.' : null;
      if (id !== 'noise_area') return 'Session execution handler is not installed.';
      return noiseUnavailable(e.cfg) ?? (!e.noiseArea ? 'Session execution handler is not running.' : null);
    }
    if (definition.trigger === 'quote' && !e.cfg.equities.length) return 'Requires an equity in the configured universe.';
    const worker = e.workers.status().find(w => w.strategy === id);
    return worker?.alive ? null : worker?.restartAt ? 'Strategy worker is recovering automatically.' : 'Strategy worker is unavailable; restart budget exhausted or no handler installed.';
  }
  async update(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
      Object.keys(request).some(k => !['strategy', 'enabled', 'addToWinners', 'expectedRevision'].includes(k)) ||
      !strategyDefinition(request.strategy) || !['enabled','addToWinners'].some(k=>Object.hasOwn(request,k)) ||
      ['enabled','addToWinners'].some(k=>Object.hasOwn(request,k) && typeof request[k]!=='boolean') ||
      !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) throw invalid('Choose an installed strategy, a boolean enabled setting and the current revision.');
    const e = this.engine;
    return e.mutex.run(async () => {
      e.store.assertLease();
      if (request.expectedRevision !== this.state.revision) throw conflict('Strategy settings changed in another session. Refresh and review the current selection.');
      const reason = this.unavailable(request.strategy);
      if (request.enabled && reason) throw conflict(reason);
      const previous = this.state.strategies[request.strategy];
      const enabled=request.enabled ?? previous.enabled, addToWinners=request.addToWinners ?? previous.addToWinners;
      if(request.addToWinners===true && (!supportsAdditions(request.strategy) || e.cfg.mode==='live' || !e.cfg.breakoutProtection))throw conflict('Add to winners requires a protected range/failed-breakout strategy in paper or simulation mode.');
      if (previous.enabled !== enabled || previous.addToWinners !== addToWinners) {
        const now = e.clock(), setting = { enabled, addToWinners, generation: previous.generation + 1, changedAt: now };
        const next = { revision: this.state.revision + 1, strategies: { ...this.state.strategies, [request.strategy]: setting } };
        e.store.transaction(() => {
          e.store.set('strategySettings', next);
          // Cancellation intent survives failures, restarts and even an immediate re-enable.
          for (const order of e.pending().filter(o => o.kind === 'entry' && o.strategy === request.strategy && (!enabled || (!addToWinners && o.addition)) && !terminal(o.status) && o.filledQty < o.qty)) {
            order.entryDisableRequested = true; e.store.order(order);
          }
          e.store.event('strategy_settings_changed', { strategy: request.strategy, previousEnabled: previous.enabled, enabled, previousAddToWinners:previous.addToWinners,addToWinners, revision: next.revision }, now);
        });
        this.state = next;
        e.realtime.eventVersion++;
        for (const order of e.pending().filter(o => o.kind === 'entry' && o.strategy === request.strategy && o.entryDisableRequested && !terminal(o.status) && !uncertain(o.status) && o.filledQty < o.qty)) await e.cancel(order);
      }
      return this.snapshot();
    });
  }
  snapshot(filter = {}) {
    const e = this.engine, now = e.clock(), orders = e.store.orders(), scorecard = tradeScorecard(orders, e.cfg, filter);
    const ids = [...new Set([...STRATEGY_REGISTRY.map(s => s.id), ...orders.filter(o => o.kind === 'entry').map(o => o.strategy ?? 'unknown')])];
    const openPnlAvailable = e.portfolio.state.valid && e.lastReconcile > 0 && Date.now() - e.lastReconcile < 30000 && !e.issues.includes('broker_reconciliation_failed');
    const strategies = ids.map(id => {
      const definition = strategyDefinition(id), setting = this.state.strategies[id];
      const trades = scorecard.trades.filter(t => (t.strategy ?? 'unknown') === id), closed = trades.filter(t => t.fullyClosed);
      const exceptions = scorecard.exceptions.filter(x => x.strategy === id);
      const owned = Object.entries(e.managed).filter(([, m]) => {
        const entry=orders.find(o=>o.id===m.entryId);
        return m.strategy === id && (!filter.experimentId || (entry?.experiment?.experimentId ?? 'legacy') === filter.experimentId) && (!filter.from || entry?.ts >= filter.from) && (!filter.to || entry?.ts < filter.to);
      });
      let openGrossPnl = openPnlAvailable ? 0 : null;
      for (const [symbol, m] of owned) {
        const p = e.portfolio.positions.find(p => p.symbol === symbol), entry = orders.find(o => o.id === m.entryId), q = e.quotes.get(symbol);
        if (!p || !entry || openGrossPnl === null) { openGrossPnl = null; continue; }
        const mark = validateQuote(q, now, e.cfg.maxQuoteAge) ? q.bid : p.marketValue / p.qty;
        if (!Number.isFinite(mark) || !Number.isFinite(entry.fillPrice)) openGrossPnl = null;
        else { const book=campaignMark(orders,entry.id,mark); openGrossPnl += p.qty*mark-book.cost; }
      }
      const wins = closed.filter(t => t.estimatedNetPnl > 0).length;
      return { id, name: definition?.name ?? id.replaceAll('_', ' '), description: definition?.description ?? 'Retained journal history; execution is not configurable here.',
        qualification: qualification(e,id),
        riskPolicy: id === 'noise_area' ? { sizing:'fixed_notional', notional:e.cfg.noiseNotional, nominalStopRisk:e.cfg.noiseNotional*e.cfg.noiseStopBps/10000, reservation:e.noiseReservation(), dailyLoss:e.dailyLossLimit }
          : { sizing:'stop_risk_budget', risk:e.cfg.risk, maxPosition:e.cfg.maxPosition, dailyLoss:e.dailyLossLimit, ...(id==='close_strength_carry'?{overnight:e.cfg.overnight}: {}) },
        trigger: definition?.trigger ?? 'historical', installed: !!definition, enabled: setting?.enabled ?? false,
        additions:{supported:supportsAdditions(id),enabled:this.additionsEnabled(id),available:e.cfg.mode!=='live' && e.cfg.breakoutProtection,
          policy:ADD_POLICY,closed:closed.filter(t=>t.addedQty>0).length,
          realizedNetPnl:exceptions.length?null:trades.reduce((n,t)=>n+(t.additionNetPnl ?? 0),0),
          filledLots:orders.filter(o=>{const root=orders.find(x=>x.id===o.campaignId);return o.addition && o.strategy===id && o.filledQty>0 && root &&
            (!filter.experimentId || (root.experiment?.experimentId ?? 'legacy')===filter.experimentId) && (!filter.from || root.ts>=filter.from) && (!filter.to || root.ts<filter.to);}).length,
          note:'New positions only. One addition up to 25%; existing versioned positions retain their original policy. Additional-share P/L is not a causal improvement estimate.'},
        unavailableReason: this.unavailable(id), generation: setting?.generation ?? null, changedAt: setting?.changedAt ?? null,
        closed: closed.length, wins, winRate: closed.length ? wins / closed.length : null, partial: trades.length - closed.length,
        excursions: {recorded:closed.filter(t=>t.observedPeakNet!==null).length,profitableThenLost:closed.filter(t=>t.observedPeakNet>0&&t.estimatedNetPnl<0).length},
        grossPnl: trades.reduce((sum, t) => sum + t.grossPnl, 0), estimatedFees: trades.reduce((sum, t) => sum + t.estimatedFees, 0),
        realizedNetPnl: exceptions.length ? null : trades.reduce((sum, t) => sum + t.estimatedNetPnl, 0), exceptions, openPositions: owned.length, openGrossPnl,
        pendingCancellations: orders.filter(o => o.kind === 'entry' && o.strategy === id && o.entryDisableRequested && !terminal(o.status) && o.filledQty < o.qty).length };
    });
    const experiments = [...new Map(orders.filter(o => o.kind === 'entry').map(o => [o.experiment?.experimentId ?? 'legacy', { id:o.experiment?.experimentId ?? 'legacy', strategy:o.strategy, codeHash:o.experiment?.codeHash ?? null }])).values()];
    for (const s of strategies) if (!experiments.some(x => x.id === s.qualification.experimentId)) experiments.push({ id:s.qualification.experimentId, strategy:s.id, codeHash:s.qualification.codeHash });
    if(filter.experimentId&&!experiments.some(x=>x.id===filter.experimentId))experiments.push({id:filter.experimentId,strategy:'Selected historical version',codeHash:null});
    return { filter, experiments, revision: this.state.revision, sessionId: String(e.startedAt), mode: e.cfg.mode, now, paused: e.operatorPause, ready: e.ready && !e.operatorPause && Object.values(e.entryAvailability()).some(x=>x.ready) && (e.broker.entryBudgetAvailable?.() ?? true),
      strategies, note: 'Cumulative local strategy fills across restarts. Realized net includes partial exits and recorded or estimated trading fees; model/cloud costs are excluded. Win rate counts only fully closed trades with positive net P/L. Open P/L is separate, before fees, using fresh bids or the last reconciled broker mark. Switching off preserves history and position management; cancellation and fills can race. Partial-entry cancellations may trigger a protective exit.' };
  }
}
