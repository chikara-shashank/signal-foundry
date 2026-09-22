import { Features } from './features.js';
import { sizeEntry } from './risk.js';
import { Jev } from './jev.js';
import { Microstructure, relativeValue } from './microstructure.js';
import { BAR_STRATEGIES } from './strategies.js';
import { marketDiagnostics } from './telemetry.js';
import { Observability } from './observability.js';
import { Realtime } from './realtime.js';
import { Portfolio, quantityTolerance } from './portfolio.js';
import { SignalOutcomes, tradeScorecard } from './research.js';
import { idFor, isCrypto, Mutex, nyDate, positive, terminal, uncertain, validateQuote, floorStep, validBar, quoteOrder } from './util.js';

export class Engine {
  quotes = new Map(); snapshots = new Map(); features = new Features(); mutex = new Mutex();
  account = null; positions = []; session = null; assets = new Map(); ready = false;
  openOrders = [];
  lastLoop = Date.now(); lastReconcile = 0; issues = []; pendingCandidates = 0; stopped = false;
  externalSymbols = new Set();
  externalDetails = { positions: [], orders: [] };
  quoteHistory = new Map();
  microstructure = new Microstructure(); quoteScans = new Map(); quoteBusy = new Set(); pairs = new Map();
  cryptoFeatures = new Features(5); cryptoContextStatus = { state: 'warming', intervalMs: 300000 };
  constructor(cfg, store, broker, workers, clock = () => Date.now()) {
    Object.assign(this, { cfg, store, broker, workers, clock });
    this.jev = new Jev(cfg, store); this.operatorPause = store.get('operatorPause', false);
    this.managed = store.get('managed', {}); this.lastEntry = store.get('lastEntry', {});
    this.feeds = {}; this.startedAt = Date.now();
    this.observability = new Observability(this);
    this.realtime = new Realtime(this);
    this.workers.onEvaluation = report => { this.realtime.timings.strategy.add(report.latencyMs); this.observability.evaluation(report); };
    this.dailyLossLimit = store.get('dailyLossOverride', cfg.dailyLoss);
    if (!Number.isFinite(this.dailyLossLimit) || this.dailyLossLimit < 1 || this.dailyLossLimit > 100000) throw new Error('Invalid saved daily loss ceiling');
    this.portfolio = new Portfolio(this);
    this.outcomes = new SignalOutcomes(this);
  }
  async init() {
    this.store.lease(Date.now());
    const a = await this.broker.account(this.clock());
    if (this.cfg.mode === 'live' && a.id !== this.cfg.expectedAccount) throw new Error('Live account ID mismatch');
    const identity = `${this.cfg.mode}:${a.id}`;
    if (this.store.get('identity', identity) !== identity) throw new Error('Database belongs to another mode/account');
    this.store.set('identity', identity);
    this.store.recoverModelTraces(this.clock());
    if (this.store.get('cashAnchor') === null) this.store.set('cashAnchor', a.cash - this.cashFlow(this.store.orders()));
    this.assets = await this.broker.assets();
    for (const symbol of this.cfg.symbols) if (!this.assets.get(symbol)?.tradable) throw new Error(`Asset unavailable: ${symbol}`);
    for (const o of this.store.orders()) if (o.status === 'reserved') { o.status = 'aborted'; this.store.order(o); }
    for (const s of this.cfg.symbols) for (const b of this.store.bars(s)) {
      const f = this.features.add(b, this.clock());
      if (f && (!isCrypto(s) || this.cfg.mode === 'demo')) this.snapshots.set(s, f);
    }
    this.store.event('started', { mode: this.cfg.mode, fingerprint: this.cfg.fingerprint });
    await this.reconcile();
    if (this.store.get('accountPolicy') !== this.cfg.accountPolicy) {
      this.store.event('account_policy_changed', { mode: this.cfg.accountPolicy, note: this.cfg.accountPolicy === 'shared' ? 'Agent allocation and daily-loss limits apply to the managed book. External holdings remain unmanaged; account-wide history is preserved.' : 'Dedicated-account allocation and daily-loss scope active.' }, this.clock());
      this.store.set('accountPolicy', this.cfg.accountPolicy);
    }
  }
  onQuote(q) {
    if (!this.cfg.symbols.includes(q.symbol)) return;
    if (!validateQuote(q, this.clock(), this.cfg.maxQuoteAge)) {
      const reason = !Number.isFinite(q.ts) ? 'invalid_quote_timestamp' : q.ts > this.clock() + 1000 ? 'quote_timestamp_in_future'
        : this.clock() - q.ts > this.cfg.maxQuoteAge ? 'stale_quote' : 'invalid_bid_ask';
      this.observability.quote(q, false, reason); return;
    }
    const priorQuote = this.quotes.get(q.symbol);
    if (priorQuote && quoteOrder(q) < quoteOrder(priorQuote)) return;
    this.quotes.set(q.symbol, q);
    this.outcomes.quote(q, this.clock());
    const owned = this.managed[q.symbol];
    if (isCrypto(q.symbol) && owned && !owned.exitReason && !this.externalSymbols.has(q.symbol) && (q.bid <= owned.stop || q.bid >= owned.target) && !this.cryptoExitQueued) {
      this.cryptoExitQueued = true;
      void this.mutex.run(() => {
        const current = this.managed[q.symbol];
        if (current?.entryId === owned.entryId && !this.externalSymbols.has(q.symbol)) {
          current.exitReason ||= q.bid <= owned.stop ? 'stop' : 'target';
          this.store.set('managed', this.managed);
          this.store.event('exit_trigger', { symbol: q.symbol, reason: current.exitReason, quoteTs: q.ts, bid: q.bid }, this.clock());
        }
      }).then(() => this.scheduleReconcile()).catch(() => this.fail('exit_trigger_failed')).finally(() => { this.cryptoExitQueued = false; });
    }
    this.realtime.quote(q);
    this.observability.quote(q, true);
    const history = this.quoteHistory.get(q.symbol) ?? [];
    const point = { ts: q.ts, bid: q.bid, ask: q.ask };
    if (history.length && Math.floor(history.at(-1).ts / 100) === Math.floor(q.ts / 100)) history[history.length - 1] = point;
    else history.push(point);
    if (history.length > 600) history.splice(0, history.length - 600);
    this.quoteHistory.set(q.symbol, history);
    const micro = this.microstructure.add(q), now = this.clock(), base = this.snapshots.get(q.symbol);
    let scan = Promise.resolve();
    if (!isCrypto(q.symbol) && micro && base && now - (base.bar.ts + 60000) < 90000 && this.cfg.strategies.includes('order_flow_continuation') &&
        now - (this.quoteScans.get(q.symbol) ?? 0) >= this.cfg.quoteScanMs && !this.quoteBusy.has(q.symbol) && this.pendingCandidates < 100 &&
        now - (this.lastEntry[q.symbol] ?? 0) >= this.cfg.cooldown) {
      this.quoteScans.set(q.symbol, now); this.quoteBusy.add(q.symbol);
      const f = { ...base, barVersion: base.version, version: `${base.version}:${Math.floor(now / this.cfg.quoteScanMs)}`, micro };
      scan = this.processCandidates(f, ['order_flow_continuation']).finally(() => this.quoteBusy.delete(q.symbol));
    }
    // Simulator transitions share the same account coordinator as real orders.
    if (this.broker.onQuote) this.mutex.run(() => this.broker.onQuote(q)).catch(() => this.fail('simulation_error'));
    return scan;
  }
  async onBar(b, warmup = false) {
    if (!validBar(b)) return;
    const now = this.clock(), f = this.features.add(b, now);
    if (b.ts + 60000 > now + 1000) return;
    if (!this.store.bar(b)) return;
    // Crypto execution context comes from authoritative 5m provider bars.
    // Minute bars remain available to charts; gaps are never forward-filled.
    if (isCrypto(b.symbol) && this.cfg.mode !== 'demo') return;
    if (!f || warmup) return;
    this.snapshots.set(b.symbol, f);
    for (const [a, z] of [['SPY', 'QQQ'], ['BTC/USD', 'ETH/USD']]) {
      if (b.symbol !== a && b.symbol !== z) continue;
      const ah = this.features.history.get(a) ?? [], bh = this.features.history.get(z) ?? [];
      if (!ah.length || ah.at(-1)?.ts !== bh.at(-1)?.ts) continue;
      const result = relativeValue(ah, bh);
      if (result && this.pairs.get(result.pair)?.ts !== result.ts) { this.pairs.set(result.pair, result); this.store.event('relative_value_research', result, now); }
    }
    this.store.event('market_sample', { bar: b, quote: this.quotes.get(b.symbol) ?? null }, now);
    if (now - (b.ts + 60000) > 10000 || this.pendingCandidates >= 100) return;
    await this.processCandidates(f, BAR_STRATEGIES);
  }
  async onCryptoHistory(symbol, bars, warmup = true) {
    if (!this.cfg.crypto.includes(symbol) || this.stopped) return;
    const prior = this.snapshots.get(symbol)?.version, now = this.clock();
    this.cryptoFeatures.history.delete(symbol);
    let latest = null;
    const unique = [...new Map(bars.map(b => [b.ts, b])).values()].sort((a, b) => a.ts - b.ts);
    for (const b of unique) latest = this.cryptoFeatures.add(b, now);
    // An actual gap or invalid latest context invalidates old approvals too.
    if (!latest) { this.snapshots.delete(symbol); return; }
    latest.maxHold = this.cfg.cryptoMaxHold;
    this.snapshots.set(symbol, latest);
    this.store.event('crypto_context', { symbol, bars: latest.count, intervalMs: latest.intervalMs, source: 'provider_5m', version: latest.version }, now);
    if (!warmup && latest.version !== prior && now - (latest.bar.ts + 300000) <= 20000 && this.pendingCandidates < 100) await this.processCandidates(latest, BAR_STRATEGIES);
  }
  onTrade(t) { this.realtime.trades.apply(t, this.clock()); }
  onBrokerUpdate(update) {
    this.store.event('broker_update', update, this.clock()); this.realtime.eventVersion++;
    this.scheduleReconcile();
  }
  scheduleReconcile() {
    // Stream messages are observations, never order/account authority. Resolve
    // against REST through the existing mutex before changing reservations.
    if (!this.streamReconcile && !this.stopped) {
      this.streamReconcile = setTimeout(async () => {
        try { if (!this.stopped) await this.reconcile(); }
        catch { this.fail('broker_reconciliation_failed'); }
        finally { this.streamReconcile = null; }
      }, 250);
      this.streamReconcile.unref();
    }
  }
  async processCandidates(f, strategies) {
    const now = this.clock();
    this.pendingCandidates++;
    try {
      const started = performance.now();
      const candidates = await this.workers.evaluate(f, now, strategies.filter(s => this.cfg.strategies.includes(s)));
      const workerLatencyMs = performance.now() - started;
      for (const c of candidates) {
        c.workerLatencyMs = workerLatencyMs;
        c.config = this.cfg.fingerprint;
        if (!this.store.candidate(c)) continue;
        this.observability.counts.candidates++;
        this.store.event('candidate_detected', { candidateId: c.id, symbol: c.symbol, strategy: c.strategy, price: c.reference }, now);
        const preflight = await this.mutex.run(() => this.checkEntry(c));
        c.preflight = preflight;
        c.model = await this.jev.evaluate(c, this.clock(), preflight.ok ? null : preflight.reason);
        this.outcomes.start(c);
        if (c.model.requested) this.realtime.timings.jev.add(c.model.latencyMs);
        this.store.event('model_result', { candidateId: c.id, symbol: c.symbol, strategy: c.strategy, mode: this.cfg.jevMode,
          requested: c.model.requested === true, pass: c.model.pass, error: c.model.error ?? null, coherence: c.model.coherence ?? null,
          quality: c.model.quality ?? null, regime: c.model.regime ?? null, latencyMs: c.model.latencyMs ?? null, cost: c.model.cost ?? null }, this.clock());
        this.realtime.eventVersion++;
        if (!preflight.ok) { this.reject(c, preflight.reason); continue; }
        if (this.cfg.jevMode === 'filter' && !c.model.pass) { this.reject(c, c.model.error ?? 'model_filter'); continue; }
        await this.mutex.run(() => this.enter(c));
      }
    } catch { this.fail('strategy_worker_failure'); }
    finally { this.pendingCandidates--; }
  }
  reject(c, reason) { c.status = 'rejected'; c.reason = reason; this.store.updateCandidate(c); this.observability.rejected(c); }
  fail(reason) { this.ready = false; this.issues = [...new Set([...this.issues, reason])]; this.store.event('fault', { reason }, this.clock()); }
  pending() { return this.store.orders().filter(o => !terminal(o.status) || (o.kind === 'entry' && o.filledQty > 0 && !o.settledAt)); }
  cashFlow(orders) {
    return orders.reduce((total, o) => total + (o.kind === 'entry' ? -1 : 1) * (o.filledQty ?? 0) * (o.fillPrice ?? 0) +
      (o.legs ?? []).reduce((sum, leg) => sum + (leg.filledQty ?? 0) * (leg.fillPrice ?? 0), 0), 0);
  }
  checkEntry(c) {
    const deny = reason => ({ ok: false, reason });
    const now = this.clock();
    if (this.timebase && !this.timebase.status().synchronized) return deny('clock_not_synchronized');
    const paperTest = c.strategy === 'operator_paper_test';
    if (paperTest && (this.cfg.mode !== 'paper' || this.cfg.brokerUrl !== 'https://paper-api.alpaca.markets')) return deny('paper_test_only');
    if (!this.ready || this.stopped || this.operatorPause) { c.blockers = [...this.issues, ...(this.operatorPause ? ['operator_pause'] : []), ...(this.stopped ? ['engine_stopped'] : [])]; return deny('entries_paused'); }
    if (this.pending().some(o => uncertain(o.status))) return deny('unresolved_order');
    if (this.broker.entryBudgetAvailable && !this.broker.entryBudgetAvailable()) return deny('broker_request_budget');
    if (this.openOrders.some(o => o.symbol === c.symbol || o.legs?.some(l => l.symbol === c.symbol && !terminal(l.status)))) return deny('broker_orders_present');
    if (this.cfg.accountPolicy === 'shared' && this.portfolio.state.reservedSymbols.includes(c.symbol)) return deny('external_symbol_reserved');
    if (now - (this.lastEntry[c.symbol] ?? 0) < this.cfg.cooldown) return deny('symbol_cooldown');
    if (!paperTest && this.snapshots.get(c.symbol)?.version !== (c.features.barVersion ?? c.features.version)) return deny('superseded_snapshot');
    if (c.strategy === 'order_flow_continuation' && now - c.features.micro.ts > 1000) return deny('microstructure_signal_expired');
    const riskConfig = paperTest ? { ...this.cfg, maxPosition: Math.min(this.cfg.maxPosition, isCrypto(c.symbol) ? 25 : c.reference * 1.02) } : this.cfg;
    const shared = this.cfg.accountPolicy === 'shared';
    const riskAccount = shared ? { ...this.account, cash: Math.min(this.account.cash, this.portfolio.state.cashAvailable) } : this.account;
    const decision = sizeEntry(c, this.quotes.get(c.symbol), riskAccount, shared ? this.portfolio.positions : this.positions, this.pending(), riskConfig, this.assets.get(c.symbol), now, this.session);
    return decision;
  }
  async enter(c) {
    this.store.assertLease();
    const decision = this.checkEntry(c);
    if (!decision.ok) return this.reject(c, decision.reason);
    const now = this.clock();
    const o = { id: idFor('e', [this.cfg.mode, this.account.id, c.id]), symbol: c.symbol, kind: 'entry', candidateId: c.id, strategy: c.strategy,
      status: 'reserved', ts: now, ...decision, entryDeadline: Math.min(c.expires, now + this.cfg.entryTtl), timeInForce: isCrypto(c.symbol) ? 'ioc' : 'day', feeRateBps: isCrypto(c.symbol) ? this.cfg.cryptoFee : this.cfg.equityFee, maxHold: c.maxHold ?? this.cfg.maxHold, legs: [], filledQty: 0, fillPrice: 0 };
    this.store.order(o);
    this.observability.counts.riskApproved++;
    c.status = 'approved'; c.orderId = o.id; c.allocation = decision; this.store.updateCandidate(c);
    this.lastEntry[c.symbol] = now; this.store.set('lastEntry', this.lastEntry);
    await this.submit(o);
  }
  async paperTest(symbol, requestId) {
    if (this.cfg.mode !== 'paper' || this.cfg.brokerUrl !== 'https://paper-api.alpaca.markets') throw new Error('Paper tests require MODE=paper');
    if (!this.cfg.symbols.includes(symbol) || !/^[a-f0-9-]{36}$/i.test(requestId)) throw new Error('Invalid paper test request');
    return this.mutex.run(async () => {
      const now = this.clock(), id = idFor('c', ['paper-test', this.account?.id, symbol, requestId]);
      const previous = this.store.getCandidate(id); if (previous) return previous;
      const q = this.quotes.get(symbol), f = this.snapshots.get(symbol);
      const c = { id, symbol, strategy: 'operator_paper_test', ts: now, expires: now + 2000, reference: q?.ask ?? 0,
        stop: (q?.bid ?? 0) * .99, target: (q?.ask ?? 0) * 1.02, maxHold: 60000,
        features: { version: f?.version ?? now, regime: f?.regime ?? 'unknown' }, status: 'discovered',
        model: { mode: 'not_used_for_operator_test', pass: true } };
      this.store.candidate(c);
      if (now - this.store.get('lastPaperTest', 0) < 60000) { this.reject(c, 'paper_test_cooldown'); return c; }
      this.store.set('lastPaperTest', now);
      // Explicit connectivity test, not a discovered alpha signal. All financial/freshness gates still apply.
      await this.enter(c); return c;
    });
  }
  async submit(o) {
    this.store.assertLease();
    this.observability.counts.submissions++;
    this.store.event('order_submitting', { orderId: o.id, symbol: o.symbol, strategy: o.strategy, kind: o.kind, qty: o.qty }, this.clock());
    const started = performance.now();
    o.status = 'submitting'; this.store.order(o);
    try { this.merge(o, await this.broker.submit(o)); this.realtime.timings.orderAck.add(performance.now() - started); }
    catch (error) {
      this.realtime.timings.orderFailure.add(performance.now() - started);
      // Even a non-2xx duplicate-ID response may refer to an accepted order.
      o.status = error.notSent ? 'aborted' : 'unknown'; this.store.order(o);
      this.fail(error.notSent ? 'broker_request_budget' : 'unresolved_order');
    }
    o.submissionLatencyMs = performance.now() - started; this.store.order(o);
    this.store.event('order', { id: o.id, symbol: o.symbol, kind: o.kind, status: o.status }, this.clock());
    this.realtime.eventVersion++;
  }
  merge(local, remote) {
    const priorFill = local.filledQty ?? 0;
    const previousLegs = local.legs ?? [];
    Object.assign(local, remote, { id: local.id });
    this.observability.fill(local, null, priorFill);
    if (local.filledQty > priorFill) local.lastFillObservedAt = this.clock();
    for (const leg of local.legs ?? []) {
      const previous = previousLegs.find(x => x.brokerId === leg.brokerId);
      this.observability.fill(leg, local, previous?.filledQty ?? 0);
      if (leg.filledQty > (previous?.filledQty ?? 0)) leg.lastFillObservedAt = this.clock();
      else if (previous?.lastFillObservedAt) leg.lastFillObservedAt = previous.lastFillObservedAt;
    }
    if (local.filledQty > priorFill && local.kind === 'entry') {
      delete local.settledAt;
      const previousReason = this.managed[local.symbol]?.exitReason;
      this.managed[local.symbol] = { entryId: local.id, strategy: local.strategy, stop: local.stop, target: local.target, maxHold: local.maxHold ?? this.cfg.maxHold, openedAt: local.ts, exitReason: previousReason ?? (local.exitAfterFill ? 'operator_flatten' : null) };
      this.store.set('managed', this.managed);
    }
    this.store.order(local);
    this.realtime.eventVersion++;
  }
  async cancel(o) {
    this.store.assertLease();
    try { await this.broker.cancel(o); o.cancelRequestedAt = this.clock(); this.store.order(o); }
    catch { this.store.event('cancel_pending', { id: o.id }, this.clock()); }
  }
  async reconcile() {
    return this.mutex.run(async () => {
      let now = this.clock(); this.lastLoop = Date.now(); this.store.lease(Date.now());
      this.outcomes.sweep(now);
      try {
        const [session, open] = await Promise.all([this.broker.clock(now), this.broker.openOrders()]);
        now = this.clock();
        const locals = this.store.orders();
        for (const o of locals) {
          // Continue querying parent while position exists, to refresh bracket legs.
          if (terminal(o.status) && !(o.kind === 'entry' && (this.managed[o.symbol]?.entryId === o.id || (o.filledQty > 0 && !o.settledAt)))) continue;
          const remote = await this.broker.find(o.id, o.brokerId);
          if (remote) this.merge(o, remote);
          else if (!terminal(o.status)) { o.status = 'unknown'; this.store.order(o); }
        }
        const positions = await this.broker.positions();
        // Read cash after order/position reconciliation before releasing fill reservations.
        const account = await this.broker.account(this.clock());
        if (`${this.cfg.mode}:${account.id}` !== this.store.get('identity')) throw new Error('account_changed');
        this.account = account; this.session = session; this.positions = positions; this.openOrders = open;
        // Gross fill cash flow is an upper bound: actual fees can reduce cash further.
        // An unexpected cash increase needs investigation in this dedicated account.
        const cashUpperBound = this.store.get('cashAnchor') + this.cashFlow(locals);
        const shared = this.cfg.accountPolicy === 'shared';
        const cashCoherent = shared ? Number.isFinite(account.cash) : Number.isFinite(cashUpperBound) && account.cash <= cashUpperBound + .02;
        for (const o of locals) if (o.kind === 'entry' && o.filledQty > 0 && !o.settledAt) {
          const exited = locals.filter(x => x.kind === 'exit' && x.entryId === o.id).reduce((s, x) => s + (x.filledQty ?? 0), 0) + (o.legs ?? []).reduce((s, x) => s + (x.filledQty ?? 0), 0);
          const expected = Math.max(0, o.filledQty - exited), actual = positions.find(p => p.symbol === o.symbol)?.qty ?? 0;
          const tolerance = quantityTolerance(o, this.cfg, this.assets.get(o.symbol));
          if (cashCoherent && ((expected === 0 && actual === 0) || (actual > 0 && Math.abs(actual - expected) <= tolerance))) { o.settledAt = this.clock(); this.store.order(o); }
        }
        this.store.set('lastAccountSnapshot', { account, positions: this.positions, ts: now });
        const ownIds = new Set(this.store.orders().map(o => o.id));
        const unmatchedOrders = open.filter(o => !ownIds.has(o.id) && !locals.some(x => x.legs?.some(l => l.brokerId === o.brokerId)));
        const externalOrders = unmatchedOrders.length > 0;
        const book = this.portfolio.refresh(positions, this.store.orders(), account, now);
        const ownedSymbols = new Set(this.portfolio.positions.map(p => p.symbol));
        this.externalSymbols = new Set(positions.filter(p => !ownedSymbols.has(p.symbol)).map(p => p.symbol));
        for (const symbol of book.conflicts) this.externalSymbols.add(symbol);
        const externalPositions = this.externalSymbols.size > 0;
        this.externalDetails = {
          positions: positions.filter(p => this.externalSymbols.has(p.symbol)).map(p => ({ symbol: p.symbol, qty: p.qty,
            marketValue: p.marketValue, unrealized: p.unrealized, configured: this.cfg.symbols.includes(p.symbol),
            reason: this.managed[p.symbol] ? 'Managed quantity does not match the local fill journal' : shared ? 'External holding; monitored separately and excluded from agent allocation' : 'No matching entry in this engine journal' })),
          orders: unmatchedOrders.map(o => ({ symbol: o.symbol, side: o.side, qty: o.qty, status: o.status, clientId: o.id })),
        };
        const invalidAccount = ![account.equity, account.cash, account.buyingPower].every(Number.isFinite);
        const invalidPosition = this.positions.some(p => !positive(p.qty) || !Number.isFinite(p.marketValue));
        this.issues = [];
        if (this.timebase && !this.timebase.status().synchronized) this.issues.push('clock_not_synchronized');
        if (!shared && (externalOrders || externalPositions)) this.issues.push('external_account_activity');
        if (shared && externalOrders) this.issues.push('external_orders_pending');
        if (shared && book.conflicts.length) this.issues.push('managed_position_conflict');
        if (shared && !book.valid) this.issues.push('agent_accounting_unavailable');
        if (!cashCoherent) this.issues.push('cash_not_reconciled');
        if (invalidAccount || invalidPosition || account.blocked) this.issues.push('account_restricted');
        if (this.pending().some(o => uncertain(o.status))) this.issues.push('unresolved_order');
        if (this.pending().some(o => o.kind === 'entry' && o.filledQty > 0 && !o.settledAt)) this.issues.push('fill_not_reconciled');
        if (this.workers.status().some(w => !w.alive)) this.issues.push('strategy_worker_failure');
        const day = nyDate(now), baseline = this.store.get(`equity:${day}`);
        if (baseline === null && positive(account.equity)) this.store.set(`equity:${day}`, account.equity);
        this.dailyPnl = account.equity - (baseline ?? account.equity);
        if (!shared && this.dailyPnl <= -this.dailyLossLimit) this.store.set(`lossHalt:${day}`, true);
        if (this.store.get(this.lossHaltKey(now), false)) this.issues.push('daily_loss_limit');
        this.ready = this.issues.length === 0;
        for (const o of this.pending().filter(o => o.kind === 'entry')) {
          if (now >= (o.entryDeadline ?? o.ts + this.cfg.entryTtl) || this.operatorPause || this.issues.includes('daily_loss_limit')) {
            if (!terminal(o.status) && !uncertain(o.status) && (!o.cancelRequestedAt || now - o.cancelRequestedAt > 5000)) await this.cancel(o);
          }
        }
        await this.manageExits(now);
        this.lastReconcile = Date.now(); this.lastLoop = Date.now();
        if (now - (this.lastEquityRecord ?? 0) >= 5000) {
          this.store.event('equity', { equity: account.equity, cash: account.cash, dailyPnl: this.dailyPnl,
            unrealized: positions.reduce((sum, p) => sum + (Number.isFinite(p.unrealized) ? p.unrealized : 0), 0),
            observedAt: account.ts }, now);
          this.store.event('agent_equity', { dailyPnl: book.dailyPnl, unrealized: book.unrealized, observedAt: account.ts }, now);
          this.lastEquityRecord = now;
        }
      } catch {
        this.fail('broker_reconciliation_failed'); this.lastLoop = Date.now();
      }
    });
  }
  async manageExits(now) {
    const all = this.store.orders();
    for (const [symbol, m] of Object.entries(this.managed)) {
      if (this.externalSymbols.has(symbol)) continue;
      const p = this.positions.find(p => p.symbol === symbol), parent = all.find(o => o.id === m.entryId);
      if (!p) {
        if (parent && terminal(parent.status) && (!parent.filledQty || parent.settledAt)) { delete this.managed[symbol]; this.store.set('managed', this.managed); }
        continue;
      }
      const q = this.quotes.get(symbol), fresh = validateQuote(q, now, this.cfg.maxQuoteAge);
      const native = parent?.legs?.filter(l => !terminal(l.status)) ?? [];
      const activeStop = native.some(l => ['stop', 'stop_limit'].includes(l.type) && !['held', 'pending_new'].includes(l.status));
      if (this.issues.includes('daily_loss_limit')) m.exitReason = 'daily_loss_limit';
      if (parent && ['canceled', 'expired', 'rejected'].includes(parent.status)) m.exitReason ||= 'partial_entry_canceled';
      if (!isCrypto(symbol) && this.session.open && this.session.close - now < 5 * 60000) m.exitReason ||= 'session_end';
      if (now - m.openedAt > m.maxHold) m.exitReason ||= 'holding_time';
      if (fresh && q.bid <= m.stop && !activeStop) m.exitReason ||= 'stop';
      if (fresh && q.bid >= m.target && !native.some(l => l.type === 'limit')) m.exitReason ||= 'target';
      if (!m.exitReason) continue;
      this.store.set('managed', this.managed);
      if (this.pending().some(o => o.symbol === symbol && o.kind === 'exit')) continue;
      if (parent && !terminal(parent.status)) { await this.cancel(parent); continue; }
      if (native.length) {
        for (const leg of native) { this.store.assertLease(); try { await this.broker.cancel(leg); } catch { /* Reconcile before another attempt. */ } }
        continue;
      }
      // If positions report reserved shares, wait for cancellation settlement.
      if (!positive(p.availableQty) || (!isCrypto(symbol) && !this.session.open)) continue;
      const qty = floorStep(Math.min(p.qty, p.availableQty), isCrypto(symbol) ? this.assets.get(symbol).min_trade_increment : 1);
      if (!positive(qty)) continue;
      if (isCrypto(symbol) && qty < this.assets.get(symbol).min_order_size) {
        if (!m.belowMinimum) {
          m.belowMinimum = true; this.store.set('managed', this.managed);
          this.store.event('exit_trigger', { symbol, reason: 'remaining_crypto_below_minimum', qty, note: 'Residual remains owned; no repeated invalid order submissions.' }, now);
        }
        continue;
      }
      const attempts = all.filter(o => o.kind === 'exit' && o.entryId === m.entryId).length;
      const o = { id: idFor('x', [m.entryId, attempts]), entryId: m.entryId, symbol, kind: 'exit', qty, status: 'reserved', ts: now, reserved: 0, reason: m.exitReason, feeRateBps: isCrypto(symbol) ? this.cfg.cryptoFee : this.cfg.equityFee, filledQty: 0, legs: [] };
      this.store.order(o); await this.submit(o);
    }
  }
  async control(action) {
    return this.mutex.run(async () => {
      if (action === 'pause') this.operatorPause = true;
      else if (action === 'resume') this.operatorPause = false;
      else if (action === 'cancel_entries') {
        this.operatorPause = true;
        for (const o of this.pending().filter(o => o.kind === 'entry' && !terminal(o.status) && !uncertain(o.status))) await this.cancel(o);
      } else if (action === 'flatten') {
        this.operatorPause = true;
        for (const m of Object.values(this.managed)) m.exitReason = 'operator_flatten';
        this.store.set('managed', this.managed);
        for (const o of this.pending().filter(o => o.kind === 'entry')) {
          o.exitAfterFill = true; this.store.order(o);
          if (!terminal(o.status) && !uncertain(o.status)) await this.cancel(o);
        }
      } else throw new Error('Unknown action');
      this.store.set('operatorPause', this.operatorPause); this.store.event('control', { action }, this.clock());
    });
  }
  async updateRiskSettings(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
      Object.keys(request).some(k => !['dailyLoss', 'expectedDailyLoss'].includes(k)) ||
      typeof request.dailyLoss !== 'number' || !Number.isFinite(request.dailyLoss) || request.dailyLoss < 1 || request.dailyLoss > 100000 ||
      Math.abs(request.dailyLoss * 100 - Math.round(request.dailyLoss * 100)) > 1e-6 || typeof request.expectedDailyLoss !== 'number') {
      throw Object.assign(new Error('Daily loss ceiling must be between $1 and $100,000, with at most two decimals.'), { status: 400 });
    }
    return this.mutex.run(() => {
      this.store.assertLease();
      if (request.expectedDailyLoss !== this.dailyLossLimit) throw Object.assign(new Error('The ceiling changed in another session. Refresh and review the current value.'), { status: 409 });
      const now = this.clock(), day = nyDate(now), previous = this.dailyLossLimit;
      const baseline = this.store.get(`equity:${day}`);
      const pnl = this.cfg.accountPolicy === 'shared' ? this.portfolio.state.dailyPnl : Number.isFinite(this.account?.equity) && Number.isFinite(baseline) ? this.account.equity - baseline : null;
      this.store.transaction(() => {
        this.store.set('dailyLossOverride', request.dailyLoss);
        if (pnl !== null && pnl <= -request.dailyLoss) this.store.set(this.lossHaltKey(now), true);
        if (previous !== request.dailyLoss) this.store.event('risk_settings_changed', { previousDailyLoss: previous, dailyLoss: request.dailyLoss }, now);
      });
      this.dailyLossLimit = request.dailyLoss;
      const halted = this.store.get(this.lossHaltKey(now), false);
      if (halted) { this.ready = false; this.issues = [...new Set([...this.issues, 'daily_loss_limit'])]; }
      return { dailyLoss: this.dailyLossLimit, halted, day };
    });
  }
  lossHaltKey(now) { return `${this.cfg.accountPolicy === 'shared' ? 'agentLossHalt' : 'lossHalt'}:${nyDate(now)}`; }
  research() {
    const now = this.clock();
    if (this.researchCache && now - this.researchCache.now < 10000) return this.researchCache;
    const recent = this.store.candidates(300);
    this.researchCache = { now, mode: this.cfg.mode, ...tradeScorecard(this.store.orders(), this.cfg), outcomes: this.outcomes.summary(),
      crypto: { ...this.cryptoContextStatus, feePerSideBps: this.cfg.cryptoFee, maximumHoldingMs: this.cfg.cryptoMaxHold,
        symbols: this.cfg.crypto.map(symbol => ({ symbol, bars: this.cryptoFeatures.history.get(symbol)?.length ?? 0,
          coverage: this.snapshots.get(symbol)?.coverage ?? null,
          contextAt: this.snapshots.get(symbol)?.bar.ts ?? null, latestDecision: recent.find(c => c.symbol === symbol) ?? null })) } };
    return this.researchCache;
  }
  status() {
    const now = this.clock();
    const clockBlocked = this.timebase && !this.timebase.status().synchronized;
    return { version: '1.6.0', cryptoContext: this.cryptoContextStatus, brokerBudget: this.broker.budgetStatus?.() ?? null, timings: this.realtime.summary(), mode: this.cfg.mode, accountPolicy: this.cfg.accountPolicy, portfolio: this.portfolio.state, now, startedAt: this.startedAt, ready: this.ready && !clockBlocked, paused: this.operatorPause,
      issues: [...new Set([...this.issues, ...(clockBlocked ? ['clock_not_synchronized'] : [])])],
      diagnostics: marketDiagnostics(this),
      reconciliation: { ...this.externalDetails, policy: this.cfg.accountPolicy, blocking: this.issues.some(x => ['external_account_activity', 'external_orders_pending', 'managed_position_conflict', 'agent_accounting_unavailable'].includes(x)), reservedSymbols: this.portfolio.state.reservedSymbols, observedAt: this.lastReconcile,
        guidance: this.cfg.accountPolicy === 'shared' ? 'External holdings remain in this account and are never adopted or closed by the agents. Their symbols and option underlyings are reserved. Agent limits use only the managed book; pending external orders and managed-quantity discrepancies still block new entries.' : 'Entries require an account reconciled with this engine journal. Existing holdings and orders from other tools remain external. Restore the matching journal if these were engine orders, or reconcile them separately in your broker account. Resume and changing the loss ceiling do not adopt external holdings.' },
      account: this.account && { equity: this.account.equity, cash: this.account.cash, buyingPower: this.account.buyingPower }, dailyPnl: this.dailyPnl ?? 0,
      positions: this.positions.map(p => ({ ...p, management: this.externalSymbols.has(p.symbol) ? null : this.managed[p.symbol] ?? null })), orders: this.store.orders().slice(-100).reverse(),
      candidates: this.store.candidates(60), events: this.store.events(40).filter(e => e.type !== 'market_sample'),
      market: this.cfg.symbols.map(symbol => ({ symbol, quote: this.quotes.get(symbol) ?? null, bars: (isCrypto(symbol) && this.cfg.mode !== 'demo' ? this.cryptoFeatures : this.features).history.get(symbol)?.length ?? 0, features: this.snapshots.get(symbol) ?? null })),
      workers: this.workers.status(), feeds: this.feeds, lastReconcile: this.lastReconcile, pairs: [...this.pairs.values()],
      microstructure: this.cfg.symbols.map(symbol => ({ symbol, ...this.microstructure.snapshot(symbol, now) })),
      jev: { mode: this.cfg.jevMode, model: this.cfg.jevModel, spent: this.store.spend(new Date(now).toISOString().slice(0, 7)), budget: this.cfg.jevBudget },
      limits: { scope: this.cfg.accountPolicy === 'shared' ? 'agent' : 'account', capital: this.cfg.capital, maxGross: this.cfg.maxGross, maxPosition: this.cfg.maxPosition, maxPositions: this.cfg.maxPositions === 0 ? null : this.cfg.maxPositions, dailyLoss: this.dailyLossLimit,
        dailyLossDefault: this.cfg.dailyLoss, dailyLossOverride: this.store.get('dailyLossOverride') !== null, dailyLossHalted: this.store.get(this.lossHaltKey(now), false) },
      warnings: [...(this.cfg.mode === 'demo' ? ['Synthetic accelerated data; results have no investment meaning.'] : []), ...(this.cfg.crypto.length ? ['Crypto exits depend on this service and network availability.'] : []), 'Strategies and model thresholds are unvalidated research hypotheses.'] };
  }
  healthyForHeartbeat() {
    if (this.timebase && !this.timebase.status().synchronized) return false;
    if (!this.ready || Date.now() - this.lastReconcile > 30000) return false;
    if (this.cfg.mode === 'demo') return true;
    const relevant = [...this.cfg.crypto, ...(this.session?.open ? this.cfg.equities : [])];
    return relevant.every(s => validateQuote(this.quotes.get(s), this.clock(), 60000));
  }
}
