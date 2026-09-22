export const ACTIVITY_TYPES = {
  scans: ['scan_summary', 'quote_rejected'],
  decisions: ['candidate_detected', 'candidate_rejected'],
  jev: ['model_result'],
  orders: ['order_submitting', 'order', 'fill', 'cancel_pending', 'broker_update'],
  controls: ['started', 'shutdown', 'control', 'risk_settings_changed', 'account_policy_changed', 'fault'],
};
export const ALL_ACTIVITY_TYPES = Object.values(ACTIVITY_TYPES).flat();
export const friendlyReason = reason => ({
  entries_paused: 'Entry gate is blocked or operator has paused entries', external_account_activity: 'External holdings or orders need reconciliation',
  symbol_cooldown: 'Waiting for the symbol cooldown after the last entry attempt', symbol_already_allocated: 'This symbol already has a position or reserved order',
  position_limit: 'Maximum number of simultaneous positions reached', gross_limit: 'Portfolio exposure limit reached', group_limit: 'Correlated-group exposure limit reached',
  model_filter: 'Jev context did not pass the configured filter', model_rate_limit: 'Jev request rate or concurrency limit reached',
  model_budget_exhausted: 'Jev monthly spending limit reached', model_unavailable: 'Jev request failed',
  model_timeout: 'Jev did not respond within the remaining request window', model_deadline_expired: 'Jev approval missed the setup validity window',
  superseded_snapshot: 'Newer market information replaced this setup', stale_quote: 'The latest quote is too old', daily_loss_limit: 'Daily loss halt is active',
  broker_orders_present: 'The broker already has an order for this instrument', unresolved_order: 'Waiting to resolve an uncertain order outcome',
  operator_pause: 'Operator paused new entries', no_setup: 'Strategy conditions were not met',
  external_orders_pending: 'External orders are still open; waiting for their cash and position effects',
  managed_position_conflict: 'An agent position does not match its recorded fills',
  agent_accounting_unavailable: 'Agent accounting is waiting for consistent order and position data',
  external_symbol_reserved: 'This symbol is reserved by an external holding or option position',
  clock_not_synchronized: 'Provider clock calibration is unavailable or unreliable; entry timing cannot be trusted',
}[reason] ?? String(reason ?? '').replaceAll('_', ' '));

export class Observability {
  constructor(engine) {
    this.engine = engine; this.reports = new Map(); this.lastScanLog = new Map(); this.reasons = new Map(); this.lastQuoteLog = new Map(); this.filledIds = new Set();
    this.counts = { candidates: 0, riskApproved: 0, riskRejected: 0, modelRejected: 0, submissions: 0, filledOrders: 0, quotesAccepted: 0, quotesRejected: 0 };
  }
  quote(q, accepted, reason) {
    this.counts[accepted ? 'quotesAccepted' : 'quotesRejected']++;
    if (accepted) return;
    const now = this.engine.clock(), key = `${q.symbol}:${reason}`;
    if (!this.lastQuoteLog.has(key) || now - this.lastQuoteLog.get(key) >= 60000) {
      this.lastQuoteLog.set(key, now);
      this.engine.store.event('quote_rejected', { symbol: q.symbol, reason, providerTs: Number.isFinite(q.ts) ? q.ts : null,
        ageMs: Number.isFinite(q.ts) ? now - q.ts : null }, now);
    }
  }
  evaluation(report) {
    if (!this.engine.cfg.symbols.includes(report.symbol) || !this.engine.cfg.strategies.includes(report.strategy)) return;
    const key = `${report.symbol}:${report.strategy}`;
    this.reports.set(key, report);
    if (!report.matched) {
      const reasonKey = `${report.strategy}:${report.reason}`;
      this.reasons.set(reasonKey, { strategy: report.strategy, reason: report.reason, count: (this.reasons.get(reasonKey)?.count ?? 0) + 1 });
      if (!this.lastScanLog.has(key) || report.ts - this.lastScanLog.get(key) >= 60000) {
        this.lastScanLog.set(key, report.ts);
        this.engine.store.event('scan_summary', { symbol: report.symbol, strategy: report.strategy, reason: report.reason,
          passed: report.passed, total: report.checks.length, failedCheck: report.checks.find(c => !c.pass),
          note: 'Sampled at most once per strategy/instrument/minute; counters include all completed checks.' }, report.ts);
      }
    }
  }
  rejected(c) {
    const model = c.reason === 'model_filter' || c.reason?.startsWith('model_') || c.reason?.startsWith('invalid_model');
    this.counts[model ? 'modelRejected' : 'riskRejected']++;
    this.engine.store.event('candidate_rejected', { candidateId: c.id, symbol: c.symbol, strategy: c.strategy, reason: c.reason,
      stage: model ? 'Jev filter' : 'Entry checks', blockers: c.blockers ?? [] }, this.engine.clock());
  }
  fill(order, parent, previousQty = 0) {
    if (!(order.filledQty > previousQty)) return;
    const id = order.brokerId ?? order.id;
    if (!this.filledIds.has(id)) { this.filledIds.add(id); this.counts.filledOrders++; }
    this.engine.store.event('fill', { orderId: order.id, symbol: order.symbol ?? parent?.symbol,
      strategy: order.strategy ?? parent?.strategy, side: order.side ?? (order.kind === 'entry' ? 'buy' : 'sell'),
      qty: order.filledQty, addedQty: order.filledQty - previousQty, price: order.fillPrice,
      note: 'Observed cumulative fill quantity and average price; not a raw exchange execution print.' }, this.engine.clock());
  }
  snapshot(symbol) {
    const e = this.engine, now = e.clock(), workers = e.workers.status();
    const checks = workers.reduce((sum, w) => sum + (w.evaluated ?? 0), 0);
    const model = e.jev.stats;
    const report = e.cfg.strategies.map(strategy => this.reports.get(`${symbol}:${strategy}`) ?? { symbol, strategy, ts: null, checks: [], matched: false,
      reason: strategy === 'order_flow_continuation' ? 'Waiting for sufficient quote-size observations and fresh bar context' : 'Waiting for completed bars and strategy context' });
    const q = e.quotes.get(symbol), fresh = q && now - q.ts <= e.cfg.maxQuoteAge;
    const latest = e.store.candidatesForSymbol(symbol, 0, 1)[0];
    let why = e.timebase && !e.timebase.status().synchronized ? 'Provider clock calibration is not reliable. New entries are blocked until it recovers.'
      : e.operatorPause ? 'New entries are paused by the operator.' : !e.ready ? `Entries are blocked: ${e.issues.map(friendlyReason).join('; ')}.`
      : e.cfg.accountPolicy === 'shared' && e.portfolio.state.reservedSymbols.includes(symbol) ? `${symbol} is reserved by an external holding or related option. Agents can consider other available instruments.`
      : !q ? `${symbol} has no accepted quote yet. A connected feed alone does not establish usable prices.`
      : !fresh ? `${symbol}'s last quote is stale. Waiting for fresh data.`
      : e.managed[symbol] ? `${symbol} already has a managed position. The engine is monitoring its exit conditions.`
      : latest?.status === 'rejected' ? `Last ${symbol} setup: ${friendlyReason(latest.reason)}. That is a historical decision; the engine continues checking new data.`
      : `There is no open ${symbol} position. Inspect the latest strategy checks below to see which conditions were met.`;
    return { sessionId: String(e.startedAt), startedAt: e.startedAt, now, symbol, mode: e.cfg.mode,
      counts: { ...this.counts, checks, matchedChecks: workers.reduce((sum, w) => sum + (w.matched ?? 0), 0),
        workerErrors: workers.reduce((sum, w) => sum + (w.errors ?? 0), 0), modelRequests: model.requests },
      journal: e.store.journalSummary(), workers, reports: report, why,
      topReasons: [...this.reasons.values()].sort((a, b) => b.count - a.count).slice(0, 5),
      jev: { ...model, busy: e.jev.busy, mode: e.cfg.jevMode, model: e.cfg.jevModel, minCoherence: e.cfg.jevCoherence, minQuality: e.cfg.jevQuality,
        description: e.cfg.jevMode === 'off' ? 'Jev is disabled. The numerical strategies and risk coordinator drive this run.'
          : e.cfg.jevMode === 'shadow' ? 'Jev classifies matched setups for observation. Its answer does not veto entries in shadow mode.'
          : 'Jev classifies matched setups. Coherence, quality and regime thresholds must pass before entry checks.',
        state: e.cfg.jevMode === 'off' ? 'OFF' : e.jev.busy ? 'CLASSIFYING' : model.requests === 0 ? 'WAITING FOR AN ELIGIBLE SETUP' : model.last?.error ? 'LAST CHECK FAILED OR SKIPPED' : 'WAITING FOR NEXT SETUP' },
      note: 'Pipeline and worker counters cover this engine process. Journal totals include earlier runs. One completed check is one strategy applied to one instrument snapshot; it is not a Jev request or an order.' };
  }
}

export function activityPage(engine, { after = 0, category = 'all', symbol = '', limit = 100 }) {
  const types = category === 'all' ? ALL_ACTIVITY_TYPES : ACTIVITY_TYPES[category];
  if (!types || (symbol && !engine.cfg.symbols.includes(symbol)) || !Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid activity query');
  const page = engine.store.activityPage(after, types, symbol, limit);
  const fields = new Set(['symbol', 'strategy', 'reason', 'stage', 'candidateId', 'orderId', 'id', 'kind', 'side', 'status', 'qty', 'addedQty', 'price',
    'blockers', 'passed', 'total', 'note', 'model', 'mode', 'coherence', 'quality', 'regime', 'latencyMs', 'cost', 'requested', 'pass', 'error',
    'action', 'dailyLoss', 'previousDailyLoss', 'providerTs', 'ageMs', 'pending', 'fingerprint']);
  return { ...page, events: page.events.map(event => {
    const data = Object.fromEntries(Object.entries(event.data).filter(([key]) => fields.has(key)));
    if (event.data.failedCheck) data.failedCheck = Object.fromEntries(Object.entries(event.data.failedCheck).filter(([k]) => ['name', 'actual', 'operator', 'target', 'unit', 'pass'].includes(k)));
    return { ...event, data, category: Object.entries(ACTIVITY_TYPES).find(([, list]) => list.includes(event.type))?.[0] };
  }) };
}
