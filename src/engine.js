import { Features } from './features.js';
import { sizeEntry } from './risk.js';
import { Jev } from './jev.js';
import { Microstructure, relativeValue } from './microstructure.js';
import { BAR_STRATEGIES, SESSION_STRATEGIES } from './strategies.js';
import { marketDiagnostics } from './telemetry.js';
import { Observability } from './observability.js';
import { Realtime } from './realtime.js';
import { Portfolio, quantityTolerance } from './portfolio.js';
import { SignalOutcomes, tradeScorecard } from './research.js';
import { StrategyControls } from './strategy-controls.js';
import { QUOTE_STRATEGIES } from './strategy-registry.js';
import { updateIncidents, protectionHealth } from './execution-incidents.js';
import { strategyManifest, qualification } from './strategy-manifest.js';
import { Accounting } from './accounting.js';
import { CryptoQuoteWaits } from './crypto-quote-waits.js';
import { ResearchContext } from './research-context.js';
import { TradeAlternatives } from './trade-alternatives.js';
import { PaperRoutes } from './paper-routes.js';
import { jevEntryGate } from './jev-entry-gate.js';
import { RiskLevels } from './risk-levels.js';
import { RELEASE } from './release.js';
import { breakoutPolicy, observeBreakout, breakoutInvalidated } from './breakout-exits.js';
import { additionPolicy, additionCandidate, checkAddition, observeCampaign } from './pyramiding.js';
import { campaignId, campaignEntries, campaignQty, remainingQty } from './position-book.js';
import { recordTradeMarks } from './trade-performance.js';
import { isCarryStrategy, carryGuard, overnightAllocation, adverseNews } from './overnight-policy.js';
import { idFor, isCrypto, Mutex, nyDate, positive, terminal, uncertain, validateQuote, floorStep, validBar, quoteOrder, faultDetail } from './util.js';

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
  cryptoExitQueued = new Set(); orderRefreshAt = new Map(); dirtyOrderSymbols = new Set();
  exitEntries = new Map();
  campaignBooks = new Map();
  protection = { state: 'starting', observedAt: 0, reason: null };
  constructor(cfg, store, broker, workers, clock = () => Date.now()) {
    Object.assign(this, { cfg, store, broker, workers, clock });
    this.jev = new Jev(cfg, store); this.operatorPause = store.get('operatorPause', false);
    this.managed = store.get('managed', {}); this.lastEntry = store.get('lastEntry', {});
    this.exitTriggers = store.get('exitTriggers', {});
    this.feeds = {}; this.startedAt = Date.now();
    this.observability = new Observability(this);
    this.cryptoQuoteWaits = new CryptoQuoteWaits(this);
    this.realtime = new Realtime(this);
    this.workers.onEvaluation = report => { this.realtime.timings.strategy.add(report.latencyMs); this.observability.evaluation(report); };
    this.dailyLossLimit = store.get('dailyLossOverride', cfg.dailyLoss);
    if (!Number.isFinite(this.dailyLossLimit) || this.dailyLossLimit < 1 || this.dailyLossLimit > 100000) throw new Error('Invalid saved daily loss ceiling');
    this.portfolio = new Portfolio(this);
    this.outcomes = new SignalOutcomes(this);
    this.strategyControls = new StrategyControls(this);
    this.riskLevels = new RiskLevels(this);
    this.accounting = new Accounting(this);
    this.researchContext = new ResearchContext(this);
    this.tradeAlternatives = new TradeAlternatives(cfg, store);
    this.paperRoutes = new PaperRoutes(this);
  }
  async init() {
    this.store.lease(Date.now());
    const a = await this.broker.account(this.clock());
    if (this.cfg.mode === 'live' && a.id !== this.cfg.expectedAccount) throw new Error('Live account ID mismatch');
    const identity = `${this.cfg.mode}:${a.id}`;
    if (this.store.get('identity', identity) !== identity) throw new Error('Database belongs to another mode/account');
    for (const trigger of Object.values(this.exitTriggers)) {
      const owned = this.managed[trigger.symbol];
      if (owned?.entryId === trigger.entryId) owned.exitReason ||= trigger.reason;
    }
    this.store.transaction(()=>{this.store.set('managed',this.managed);this.store.set('exitTriggers',{});});this.exitTriggers={};
    this.store.set('identity', identity);
    // A restart never revives a queued signal from the previous process.
    for (const c of this.store.candidatesByStatus('waiting_for_quote')) {
      c.status = 'rejected'; c.reason = 'crypto_wait_interrupted'; this.store.updateCandidate(c);
      this.store.event('candidate_rejected', { candidateId: c.id, symbol: c.symbol, strategy: c.strategy, reason: c.reason }, this.clock());
    }
    this.store.set('strategySettings', this.strategyControls.state);
    this.store.recoverModelTraces(this.clock());
    if (this.store.get('cashAnchor') === null) this.store.set('cashAnchor', a.cash - this.cashFlow(this.store.orders()));
    this.assets = await this.broker.assets();
    this.universe?.validateRestoredAssets();
    for (const symbol of this.cfg.symbols) if (!this.assets.get(symbol)?.tradable && !this.managed[symbol]) throw new Error(`Asset unavailable: ${symbol}`);
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
    if(this.stopped)return;
    if(!isCrypto(q.symbol)&&this.schedule&&!this.schedule.state().equityTracking)return;
    if (!this.cfg.symbols.includes(q.symbol)) return;
    if (!validateQuote(q, this.clock(), this.cfg.maxQuoteAge)) {
      const reason = !Number.isFinite(q.ts) ? 'invalid_quote_timestamp' : q.ts > this.clock() + 1000 ? 'quote_timestamp_in_future'
        : this.clock() - q.ts > this.cfg.maxQuoteAge ? 'stale_quote' : 'invalid_bid_ask';
      this.observability.quote(q, false, reason); return;
    }
    const priorQuote = this.quotes.get(q.symbol);
    if (priorQuote && quoteOrder(q) < quoteOrder(priorQuote)) return;
    this.quotes.set(q.symbol, q);
    this.cryptoQuoteWaits.onQuote(q.symbol);
    this.outcomes.quote(q, this.clock());
    const owned = this.managed[q.symbol];
    if (owned && !this.externalSymbols.has(q.symbol)) {
      const entry = this.exitEntries.get(owned.entryId) ?? this.store.getOrder(owned.entryId);
      if (entry) {
        this.exitEntries.set(entry.id, entry);
        const beforeArmed = owned.excursion?.armedAt, beforeAddFloor=owned.addFloor, reason = observeBreakout(owned, entry, q, this.clock(), this.positions.find(p=>p.symbol===q.symbol)?.qty ?? entry.filledQty);
        observeCampaign(this,owned,entry,q);
        if (owned.excursion && (!owned.excursion.persistedAt || this.clock() - owned.excursion.persistedAt >= 1000 || beforeArmed !== owned.excursion.armedAt || beforeAddFloor!==owned.addFloor || reason)) {
          this.store.assertLease(); owned.excursion.persistedAt = this.clock();
          this.store.set('managed', this.managed);
          entry.excursion = { ...owned.excursion }; this.store.order(entry);
          if (owned.campaignExcursion) { entry.campaignExcursion={...owned.campaignExcursion}; this.store.order(entry); }
        }
        if (reason) this.latchExit(q.symbol, owned.entryId, reason, { quoteTs: q.ts, bid: q.bid, floor: owned.excursion?.floor });
      }
    }
    const triggerKey = owned ? `${q.symbol}:${owned.entryId}` : null;
    if (isCrypto(q.symbol) && owned && !owned.exitReason && !this.externalSymbols.has(q.symbol) && (q.bid <= owned.stop || q.bid >= owned.target) && !this.cryptoExitQueued.has(triggerKey)) {
      this.store.assertLease();
      this.exitTriggers[triggerKey] = { symbol: q.symbol, entryId: owned.entryId, reason: q.bid <= owned.stop ? 'stop' : 'target', quoteTs: q.ts };
      this.store.set('exitTriggers', this.exitTriggers);
      this.cryptoExitQueued.add(triggerKey);
      void this.mutex.run(() => {
        const current = this.managed[q.symbol];
        if (current?.entryId === owned.entryId && !this.externalSymbols.has(q.symbol)) {
          current.exitReason ||= q.bid <= owned.stop ? 'stop' : 'target';
          this.store.set('managed', this.managed);
          this.store.event('exit_trigger', { symbol: q.symbol, reason: current.exitReason, quoteTs: q.ts, bid: q.bid }, this.clock());
        }
        delete this.exitTriggers[triggerKey]; this.store.set('exitTriggers', this.exitTriggers);
      }).then(() => this.scheduleReconcile()).catch(() => this.fail('exit_trigger_failed')).finally(() => { this.cryptoExitQueued.delete(triggerKey); });
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
    if (!isCrypto(q.symbol) && micro && base && now - (base.bar.ts + 60000) < 90000 && QUOTE_STRATEGIES.some(s => this.strategyControls.enabled(s)) &&
        now - (this.quoteScans.get(q.symbol) ?? 0) >= this.cfg.quoteScanMs && !this.quoteBusy.has(q.symbol) && this.pendingCandidates < 100 &&
        now - (this.lastEntry[q.symbol] ?? 0) >= this.cfg.cooldown) {
      this.quoteScans.set(q.symbol, now); this.quoteBusy.add(q.symbol);
      const f = { ...base, barVersion: base.version, version: `${base.version}:${Math.floor(now / this.cfg.quoteScanMs)}`, micro };
      scan = this.processCandidates(f, QUOTE_STRATEGIES).finally(() => this.quoteBusy.delete(q.symbol));
    }
    // Simulator transitions share the same account coordinator as real orders.
    if (this.broker.onQuote) this.mutex.run(() => this.broker.onQuote(q)).catch(() => this.fail('simulation_error'));
    return scan;
  }
  async onBar(b, warmup = false) {
    if(this.stopped)return;
    if(!warmup&&!isCrypto(b.symbol)&&this.schedule&&!this.schedule.state().equityTracking)return;
    if (!validBar(b) || !this.cfg.symbols.includes(b.symbol)) return;
    if (!warmup && this.stockHistory && !isCrypto(b.symbol)) await this.stockHistory.repair(b);
    if(this.stopped)return;
    const now = this.clock(), f = this.features.add(b, now);
    if (b.ts + 60000 > now + 1000) return;
    if (!this.store.bar(b)) return;
    const owned = this.managed[b.symbol], entry = owned && this.store.getOrder(owned.entryId);
    if (!warmup && entry && breakoutInvalidated(entry, b, now)) this.latchExit(b.symbol, entry.id, 'breakout_invalidated', { barTs: b.ts, close: b.close });
    // Crypto execution context comes from authoritative 5m provider bars.
    // Minute bars remain available to charts; gaps are never forward-filled.
    if (isCrypto(b.symbol) && this.cfg.mode !== 'demo') return;
    if (!warmup && b.symbol === this.noiseArea?.symbol) await this.noiseArea.onBar(b);
    if (!warmup && !isCrypto(b.symbol)) await this.vwapTrend?.onBar(b);
    if (!warmup && !isCrypto(b.symbol)) await this.monthlyTrend?.onBar(b);
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
    const addition=additionCandidate(this,f);
    if(addition)await this.submitCandidate(addition);
    if(!isCrypto(b.symbol))await this.desk?.onBar(b);
    await this.processCandidates(f, BAR_STRATEGIES);
  }
  // Completed provider bars restored in order, before the next streamed bar for the symbol.
  backfill(symbol, bars, snapshot) {
    let f = null, restored = 0;
    for (const b of [...bars].sort((x, y) => x.ts - y.ts)) {
      const last = this.features.history.get(symbol)?.at(-1)?.ts;
      if (b.symbol !== symbol || !validBar(b) || (Number.isFinite(last) && b.ts <= last) || b.ts + 60000 > this.clock() + 1000) continue;
      f = this.features.add(b, this.clock()); this.store.bar(b); this.noiseArea?.addBar(b); this.vwapTrend?.addBar(b); restored++;
    }
    if (snapshot && restored && f) this.snapshots.set(symbol, f);
    return restored;
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
  onTrade(t) { if(!isCrypto(t.symbol)&&this.schedule&&!this.schedule.state().equityTracking)return;this.realtime.trades.apply(t, this.clock()); }
  latchExit(symbol, entryId, reason, observation) {
    const m = this.managed[symbol];
    if (!m || m.entryId !== entryId || m.exitReason || this.externalSymbols.has(symbol)) return;
    this.store.assertLease(); m.exitReason = reason;
    this.store.transaction(() => {
      this.store.set('managed', this.managed);
      this.store.event('exit_trigger', { symbol, entryId, reason, ...observation }, this.clock());
    });
    this.scheduleReconcile();
  }
  onBrokerUpdate(update) {
    if (update.symbol) this.dirtyOrderSymbols.add(update.symbol);
    this.store.event('broker_update', update, this.clock()); this.realtime.eventVersion++;
    this.scheduleReconcile();
  }
  scheduleReconcile() {
    // Stream messages are observations, never order/account authority. Resolve
    // against REST through the existing mutex before changing reservations.
    if (!this.streamReconcile && !this.stopped) {
      this.streamReconcile = setTimeout(async () => {
        try { if (!this.stopped) await this.reconcile(); }
        catch (error) { this.fail('broker_reconciliation_failed', error); }
        finally { this.streamReconcile = null; }
      }, 250);
      this.streamReconcile.unref();
    }
  }
  async processCandidates(f, strategies) {
    if(this.stopped)return;
    if(this.schedule&&!isCrypto(f.symbol??'')&&!this.schedule.state().regular)return;
    if(this.cryptoUniverse&&isCrypto(f.symbol??'')&&!this.cryptoUniverse.allowed(f.symbol))return;
    const now = this.clock();
    this.pendingCandidates++;
    try {
      const started = performance.now();
      const selected = strategies.filter(s => this.strategyControls.enabled(s));
      if (!selected.length) return;
      const generations = new Map(selected.map(s => [s, this.strategyControls.generation(s)]));
      const candidates = await this.workers.evaluate(f, now, selected);
      if(this.stopped)return;
      const workerLatencyMs = performance.now() - started;
      const decisions = [];
      for (const c of candidates) {
        c.workerLatencyMs = workerLatencyMs;
        c.strategyGeneration = generations.get(c.strategy) ?? -1;
        c.config = this.cfg.fingerprint;
        c.research = this.researchContext.reference(c.symbol, c.ts);
        if (!this.store.candidate(c)) continue;
        this.observability.counts.candidates++;
        if (isCrypto(c.symbol)) this.observability.crypto.detected++;
        this.store.event('candidate_detected', { candidateId: c.id, symbol: c.symbol, strategy: c.strategy, price: c.reference }, now);
        // A waiting crypto setup must not hold up other strategies or symbols.
        if (this.cryptoQuoteWaits.eligible(c)) decisions.push(this.processWorkerCandidate(c));
        else await this.processWorkerCandidate(c);
      }
      const completed = await Promise.allSettled(decisions);
      const failed = completed.find(r => r.status === 'rejected');
      if (failed) throw failed.reason;
    } catch (error) { if(!this.stopped)this.fail('strategy_worker_failure', error); }
    finally { this.pendingCandidates--; }
  }
  async processWorkerCandidate(c) {
    const canWait = this.cryptoQuoteWaits.eligible(c);
    let outcomeStarted = false;
    while (!this.stopped) {
      let preflight = await this.mutex.run(() => this.checkEntry(c));
      if (canWait && preflight.reason === 'stale_or_invalid_quote') {
        const reason = await this.cryptoQuoteWaits.wait(c);
        if (!reason) continue; // A quote is an observation; recheck every gate.
        preflight = { ok: false, reason };
      }
      if (this.stopped) break;
      c.preflight = preflight;
      if (!c.model) {
        c.model = await this.jev.evaluate(c, this.clock(), preflight.ok ? null : preflight.reason);
        if (this.stopped) break;
        if (c.model.requested) this.realtime.timings.jev.add(c.model.latencyMs);
        this.store.event('model_result', { candidateId: c.id, symbol: c.symbol, strategy: c.strategy, mode: this.cfg.jevMode,
          requested: c.model.requested === true, pass: c.model.pass, error: c.model.error ?? null, coherence: c.model.coherence ?? null,
          quality: c.model.quality ?? null, regime: c.model.regime ?? null, latencyMs: c.model.latencyMs ?? null, cost: c.model.cost ?? null }, this.clock());
        this.realtime.eventVersion++;
      }
      if (!outcomeStarted) { this.outcomes.start(c); outcomeStarted = true; }
      if (!preflight.ok) return this.reject(c, preflight.reason);
      if (this.cfg.jevMode === 'filter' && !c.model.pass) return this.reject(c, c.model.error ?? 'model_filter');
      const waitAgain = await this.mutex.run(async () => {
        // A quote can age during model evaluation or while waiting for the
        // account mutex. Reuse this candidate's model result, never its approval.
        if (canWait && this.checkEntry(c).reason === 'stale_or_invalid_quote') return true;
        await this.enter(c); return false;
      });
      if (!waitAgain) return;
    }
    this.reject(c, 'engine_stopped');
  }
  // Engine-thread session strategies share every entry check with the bar strategies.
  // These setups have no Jev rubric; filter mode must fail closed.
  async submitCandidate(c) {
    c.strategyGeneration ??= this.strategyControls.generation(c.strategy);
    c.config = this.cfg.fingerprint;
    c.research = this.researchContext.reference(c.symbol, c.ts);
    if (!this.store.candidate(c)) return;
    this.observability.counts.candidates++;
    this.store.event('candidate_detected', { candidateId: c.id, symbol: c.symbol, strategy: c.strategy, price: c.reference }, this.clock());
    const preflight = await this.mutex.run(() => this.checkEntry(c));
    c.preflight = preflight; c.model = { mode: 'not_applicable', requested: false, pass: true };
    this.realtime.eventVersion++;
    if (!preflight.ok) return this.reject(c, preflight.reason);
    if(c.addition && this.cfg.jevMode==='filter')return this.reject(c,'addition_model_filter_not_validated');
    if(this.cfg.jevMode==='filter')return this.reject(c,'jev_setup_review_required');
    await this.mutex.run(() => this.enter(c));
  }
  reject(c, reason) { c.status = 'rejected'; c.reason = reason; this.store.updateCandidate(c); this.observability.rejected(c); }
  fail(reason, error) { this.ready = false; this.issues = [...new Set([...this.issues, reason])]; this.store.event('fault', { reason, ...(error ? { detail: faultDetail(error) } : {}) }, this.clock()); }
  pending() { return this.store.orders().filter(o => !terminal(o.status) || (o.kind === 'entry' && o.filledQty > 0 && !o.settledAt)); }
  cashFlow(orders) {
    return orders.reduce((total, o) => total + (o.kind === 'entry' ? -1 : 1) * (o.filledQty ?? 0) * (o.fillPrice ?? 0) +
      (o.legs ?? []).reduce((sum, leg) => sum + (leg.filledQty ?? 0) * (leg.fillPrice ?? 0), 0), 0);
  }
  checkEntry(c) {
    const deny = reason => ({ ok: false, reason });
    const now = this.clock();
    if (this.timebase && !this.timebase.status().synchronized) return deny('clock_not_synchronized');
    if (this.paperRoutes.reserved(c.symbol)) return deny('paper_route_symbol_reserved');
    if (!this.paperRoutes.stats.valid) return deny('paper_route_reconciliation_required');
    const paperTest = c.strategy === 'operator_paper_test';
    if (!this.cfg.symbols.includes(c.symbol)) return deny('symbol_left_universe');
    if (isCrypto(c.symbol) && this.cfg.cryptoUniverse==='off') return deny('crypto_entries_disabled');
    if (!isCrypto(c.symbol) && this.schedule && !this.schedule.state(now).regular) return deny('equity_tracking_window_closed');
    if (isCrypto(c.symbol) && this.cryptoUniverse && !this.cryptoUniverse.allowed(c.symbol,now)) return deny('crypto_rank_unavailable_or_outside_top25');
    if (!isCrypto(c.symbol) && this.universe && !this.universe.entryReady(now)) return deny('universe_scan_stale');
    if (!isCrypto(c.symbol) && adverseNews(this.desk?.currentView(c.symbol,now),now)) return deny('company_news_adverse');
    if(c.holdingPolicy&&!isCarryStrategy(c.strategy))return deny('carry_policy_invalid');
    const carry=isCarryStrategy(c.strategy);
    if(carry){const reason=carryGuard(this,c);if(reason)return deny(reason);}
    if (this.cfg.mode === 'live' && !qualification(this, c.strategy).liveEligible) return deny('strategy_not_live_qualified');
    if (!paperTest && !this.strategyControls.enabled(c.strategy)) return deny('strategy_disabled');
    if (!paperTest && (c.strategyGeneration ?? 0) !== this.strategyControls.generation(c.strategy)) return deny('strategy_selection_changed');
    if (paperTest && (this.cfg.mode !== 'paper' || this.cfg.brokerUrl !== 'https://paper-api.alpaca.markets')) return deny('paper_test_only');
    if (!this.ready || this.stopped || this.operatorPause) { c.blockers = [...this.issues, ...(this.operatorPause ? ['operator_pause'] : []), ...(this.stopped ? ['engine_stopped'] : [])]; return deny('entries_paused'); }
    if (this.pending().some(o => uncertain(o.status))) return deny('unresolved_order');
    if (this.broker.entryBudgetAvailable && !this.broker.entryBudgetAvailable()) return deny('broker_request_budget');
    const addition=c.addition ? checkAddition(this,c) : null;
    if(addition && !addition.ok)return addition;
    if (!addition && this.cfg.maxPositions > 0 && this.paperRoutes.active().length &&
        this.portfolio.positions.filter(p => !this.paperRoutes.owns(p.symbol)).length + this.pending().filter(o => o.kind === 'entry').length + this.paperRoutes.active().length >= this.cfg.maxPositions) return deny('position_limit');
    const ownedLegs=addition ? new Set(campaignEntries(this.store.orders(),addition.rootId).flatMap(o=>(o.legs??[]).map(l=>l.brokerId))) : new Set();
    const rootBrokerId=addition ? this.store.getOrder(addition.rootId)?.brokerId : null;
    if (this.openOrders.some(o => (o.symbol === c.symbol && !ownedLegs.has(o.brokerId) && !(rootBrokerId && o.brokerId===rootBrokerId && o.status==='filled')) || o.legs?.some(l => l.symbol === c.symbol && !terminal(l.status) && !ownedLegs.has(l.brokerId)))) return deny('broker_orders_present');
    if (this.cfg.accountPolicy === 'shared' && this.portfolio.state.reservedSymbols.includes(c.symbol)) return deny('external_symbol_reserved');
    if (now - (this.lastEntry[c.symbol] ?? 0) < this.cfg.cooldown) return deny('symbol_cooldown');
    if (!paperTest && !SESSION_STRATEGIES.includes(c.strategy) && this.snapshots.get(c.symbol)?.version !== (c.features.barVersion ?? c.features.version)) return deny('superseded_snapshot');
    if (c.strategy === 'order_flow_continuation' && now - c.features.micro.ts > 1000) return deny('microstructure_signal_expired');
    // Evidence-gated sizing (risk-levels.js): exactly the .env limits unless RISK_LEVELS=auto.
    const levels = this.riskLevels.limits(c.strategy, this.account);
    const riskConfig = { ...this.cfg, risk: levels.risk, maxPosition: levels.maxPosition, maxGross: levels.maxGross, maxGroup: levels.maxGroup, capital: levels.capital,
      strategies: this.strategyControls.enabledIds(), noiseReservationEligible: this.noiseReservation().eligible, ...(paperTest ? { maxPosition: Math.min(this.cfg.maxPosition, isCrypto(c.symbol) ? 25 : c.reference * 1.02) } : {}) };
    const carryAllocation=carry?overnightAllocation(this):null;
    if(carry)riskConfig.maxPosition=Math.min(riskConfig.maxPosition,carryAllocation.headroom,carryAllocation.base*this.cfg.overnight.positionFraction);
    const shared = this.cfg.accountPolicy === 'shared';
    const riskAccount = shared ? { ...this.account, cash: Math.min(this.account.cash, this.portfolio.state.cashAvailable) } : this.account;
    const routeReserve = this.paperRoutes.capitalReserved();
    for (const key of ['maxGross','maxGroup','capital']) riskConfig[key] -= routeReserve;
    const allocationAccount = { ...riskAccount, cash: riskAccount.cash - routeReserve, buyingPower: riskAccount.buyingPower - routeReserve };
    const allocationPositions = (shared ? this.portfolio.positions : this.positions).filter(p => !this.paperRoutes.owns(p.symbol));
    const decision = sizeEntry(addition ? {...c,stop:addition.stop,target:addition.target} : c, this.quotes.get(c.symbol), allocationAccount, allocationPositions, this.pending(), riskConfig, this.assets.get(c.symbol), now, this.session, addition);
    if(addition && decision.ok)decision.additionPlan=addition;
    // Journaled on the entry order, so every fill can be traced to the level that sized it.
    if(decision.ok && this.riskLevels.active)decision.riskLevel={level:levels.level,multiplier:levels.multiplier,brake:levels.brake};
    if(carry&&decision.ok&&decision.reserved>carryAllocation.headroom+1e-8)return deny('carry_allocation_limit');
    return decision;
  }
  async enter(c) {
    this.store.assertLease();
    const decision = this.checkEntry(c);
    if (!decision.ok) return this.reject(c, decision.reason);
    const review = jevEntryGate(this, c);
    if (!review.ok) return this.reject(c, review.reason);
    const now = this.clock();
    const o = { id: idFor('e', [this.cfg.mode, this.account.id, c.id]), symbol: c.symbol, kind: 'entry', candidateId: c.id, strategy: c.strategy,
      experiment: c.addition ? this.store.getOrder(c.campaignId).experiment : strategyManifest(this, c.strategy),
      ...(review.approval ? { jevApproval: review.approval } : {}),
      ...(c.addition ? {campaignId:c.campaignId,addition:true} : {addPolicy:isCrypto(c.symbol)?null:additionPolicy(this,c.strategy)}),
      exitPolicy: breakoutPolicy(c, this.cfg), discovery: isCrypto(c.symbol)?{source:'CoinPaprika',at:this.cryptoUniverse?.state.at??null,row:this.cryptoUniverse?.state.rows.find(r=>r.symbol===c.symbol)??null}:this.universe?.selection(c.symbol) ?? null,
      ...(c.holdingPolicy?{holdingPolicy:structuredClone(c.holdingPolicy)}:{}),
      ...(c.research?{research:structuredClone(c.research)}:{}),
      status: 'reserved', ts: now, ...decision, entryDeadline: Math.min(c.expires, now + this.cfg.entryTtl), timeInForce: isCrypto(c.symbol) ? 'ioc' : c.holdingPolicy?.type==='carry'?'gtc':'day', feeRateBps: isCrypto(c.symbol) ? this.cfg.cryptoFee : this.cfg.equityFee, maxHold: c.maxHold ?? this.cfg.maxHold, legs: [], filledQty: 0, fillPrice: 0 };
    this.store.order(o);
    this.observability.counts.riskApproved++;
    if (isCrypto(c.symbol) && c.strategy !== 'operator_paper_test') this.observability.crypto.approved++;
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
    if(o.kind==='entry'&&!isCrypto(o.symbol)&&this.schedule&&(!this.schedule.state().regular||o.holdingPolicy?.type==='carry'&&!this.schedule.state().carryWindow)) {
      o.status='aborted';o.reason='equity_submission_window_closed';this.store.order(o);this.store.event('order_aborted',{id:o.id,reason:o.reason},this.clock());return;
    }
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
    if (local.filledQty > priorFill) {
      local.lastFillObservedAt = this.clock();
      if (local.kind === 'entry' && priorFill === 0) local.firstFillObservedAt ??= this.clock();
    }
    for (const leg of local.legs ?? []) {
      const previous = previousLegs.find(x => x.brokerId === leg.brokerId);
      if(previous?.feeSource==='broker_activity_provisional'&&leg.fee==null){leg.fee=previous.fee;leg.feeSource=previous.feeSource;}
      this.observability.fill(leg, local, previous?.filledQty ?? 0);
      if (leg.filledQty > (previous?.filledQty ?? 0)) leg.lastFillObservedAt = this.clock();
      else if (previous?.lastFillObservedAt) leg.lastFillObservedAt = previous.lastFillObservedAt;
    }
    if (local.filledQty > priorFill && local.kind === 'entry') {
      delete local.settledAt;
      const rootId=campaignId(local), root=local.addition ? this.store.getOrder(rootId) : local;
      const previous = this.managed[local.symbol]?.entryId === rootId ? this.managed[local.symbol] : {};
      if(!root || (local.addition && (!root.addPolicy || root.symbol!==local.symbol || root.strategy!==local.strategy)))throw new Error('Invalid addition ownership');
      this.managed[local.symbol] = { ...previous, entryId: rootId, strategy: root.strategy, stop: root.stop, target: root.target, maxHold: root.maxHold ?? this.cfg.maxHold, openedAt: previous.openedAt ?? root.filledAt ?? root.lastFillObservedAt ?? root.ts, exitReason: previous.exitReason ?? (local.exitAfterFill ? 'operator_flatten' : null),
        ...(root.holdingPolicy?{holdingPolicy:root.holdingPolicy}:{}),
        ...(local.addition ? {addFloor:Math.max(previous.addFloor ?? root.stop,local.stop),additionEntryId:local.id} : {}) };
      this.store.set('managed', this.managed);
    }
    if(local.kind==='entry') {
      const managed=this.managed[local.symbol];
      if(managed?.entryId===campaignId(local)){if(!local.addition && managed.excursion)local.excursion={...managed.excursion};if(!local.addition && managed.campaignExcursion)local.campaignExcursion={...managed.campaignExcursion};if(managed.exitReason)local.exitReason=managed.exitReason;this.exitEntries.set(local.id,local);}
    }
    this.store.order(local);
    const entry=local.kind==='entry'?local:this.exitEntries.get(local.entryId) ?? this.store.getOrder(local.entryId);
    if(entry && (entry.addPolicy || entry.addition)) {
      const rootId=campaignId(entry), book=this.campaignBooks.get(rootId) ?? [];
      this.campaignBooks.set(rootId,[...book.filter(o=>o.id!==local.id),local]);
    }
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
        const priority = Object.keys(this.managed).length || this.pending().length || this.paperRoutes.active().length ? 'protection' : 'normal';
        const [session, open, positions] = await Promise.all([this.broker.clock(now, priority), this.broker.openOrders(priority), this.broker.positions(priority)]);
        now = this.clock();
        const locals = this.store.orders();
        const observed = new Map();
        for (const row of open) { observed.set(row.brokerId, row); for (const leg of row.legs ?? []) observed.set(leg.brokerId, leg); }
        for (const o of locals) {
          // Continue querying parent while position exists, to refresh bracket legs.
          if (terminal(o.status) && !(o.kind === 'entry' && (this.managed[o.symbol]?.entryId === campaignId(o) || (o.filledQty > 0 && !o.settledAt)))) continue;
          const snapshot = o.brokerId ? observed.get(o.brokerId) : null;
          const changedQuantity = o.kind === 'entry' && Math.abs((positions.find(p => p.symbol === o.symbol)?.qty ?? 0) - campaignQty(locals,campaignId(o))) > 1e-8;
          const activeLegsMissing = (o.legs ?? []).some(l => !terminal(l.status) && !observed.has(l.brokerId));
          const urgent = !terminal(o.status) || !o.settledAt || changedQuantity || activeLegsMissing || this.dirtyOrderSymbols.has(o.symbol) || this.managed[o.symbol]?.exitReason;
          // Stable parents are refreshed every 30s. Broker notifications, quantity
          // changes and missing protective legs always require a fresh lookup.
          if (!snapshot && this.broker.budgetStatus && !urgent && now - (this.orderRefreshAt.get(o.id) ?? 0) < (this.schedule?.parentRefreshInterval(o.symbol)??30000)) {
            for (const leg of o.legs ?? []) if (observed.has(leg.brokerId)) Object.assign(leg, observed.get(leg.brokerId));
            this.store.order(o); continue;
          }
          const remote = snapshot ?? await this.broker.find(o.id, o.brokerId, priority);
          if (remote) this.merge(o, remote);
          else if (!terminal(o.status)) { o.status = 'unknown'; this.store.order(o); }
          this.orderRefreshAt.set(o.id, now);
        }
        // Read cash after order/position reconciliation before releasing fill reservations.
        const account = await this.broker.account(this.clock(), priority);
        if (`${this.cfg.mode}:${account.id}` !== this.store.get('identity')) throw new Error('account_changed');
        this.account = account; this.session = session; this.positions = positions; this.openOrders = open;
        await this.paperRoutes.reconcile(open, positions, account, now);
        // Gross fill cash flow is an upper bound: actual fees can reduce cash further.
        // An unexpected cash increase needs investigation in this dedicated account.
        const cashUpperBound = this.store.get('cashAnchor') + this.cashFlow(locals) + this.paperRoutes.stats.cashFlow;
        const shared = this.cfg.accountPolicy === 'shared';
        const cashCoherent = shared ? Number.isFinite(account.cash) : Number.isFinite(cashUpperBound) && account.cash <= cashUpperBound + .02;
        for (const o of locals) if (o.kind === 'entry' && o.filledQty > 0 && !o.settledAt) {
          const expected = Math.max(0, campaignQty(locals,campaignId(o))), actual = positions.find(p => p.symbol === o.symbol)?.qty ?? 0;
          const tolerance = quantityTolerance(o, this.cfg, this.assets.get(o.symbol));
          if (cashCoherent && ((expected === 0 && actual === 0) || (actual > 0 && Math.abs(actual - expected) <= tolerance))) { o.settledAt = this.clock(); this.store.order(o); }
        }
        this.store.set('lastAccountSnapshot', { account, positions: this.positions, ts: now });
        const ownIds = new Set(this.store.orders().map(o => o.id));
        const unmatchedOrders = open.filter(o => !ownIds.has(o.id) && !this.paperRoutes.ownsOrder(o) && !locals.some(x => x.legs?.some(l => l.brokerId === o.brokerId)));
        const externalOrders = unmatchedOrders.length > 0;
        const book = this.portfolio.refresh(positions, this.store.orders(), account, now);
        const campaignOrders=this.store.orders();
        for(const managed of Object.values(this.managed)) {
          const lots=campaignEntries(campaignOrders,managed.entryId);
          if(lots[0]?.addPolicy) { const ids=new Set(lots.map(o=>o.id));this.campaignBooks.set(managed.entryId,[...lots,...campaignOrders.filter(o=>o.kind==='exit' && ids.has(o.entryId))]); }
        }
        const incidents = updateIncidents(this, book, this.store.orders(), positions, now);
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
        const invalidPosition = this.positions.some(p => !Number.isFinite(p.qty) || p.qty === 0 || !Number.isFinite(p.marketValue) ||
          (!this.paperRoutes.owns(p.symbol) && ((!shared && !positive(p.qty)) || (shared && ownedSymbols.has(p.symbol) && !positive(p.qty)))));
        this.issues = [];
        if (!this.paperRoutes.stats.valid) this.issues.push('paper_route_execution_incident');
        if (incidents.some(x => !x.resolvedAt)) this.issues.push('execution_incident');
        if (this.timebase && !this.timebase.status().synchronized) this.issues.push('clock_not_synchronized');
        if (!shared && (externalOrders || externalPositions)) this.issues.push('external_account_activity');
        if (shared && externalOrders) this.issues.push('external_orders_pending');
        if (shared && book.conflicts.length) this.issues.push('managed_position_conflict');
        if (shared && !book.valid) this.issues.push('agent_accounting_unavailable');
        if (!cashCoherent) this.issues.push('cash_not_reconciled');
        if (invalidAccount || invalidPosition || account.blocked) this.issues.push('account_restricted');
        if (this.pending().some(o => uncertain(o.status))) this.issues.push('unresolved_order');
        if (this.pending().some(o => o.kind === 'entry' && o.filledQty > 0 && !o.settledAt)) this.issues.push('fill_not_reconciled');
        if (this.workers.status().some(w => this.strategyControls.enabled(w.strategy) && !w.alive)) this.issues.push('strategy_worker_failure');
        const day = nyDate(now), baseline = this.store.get(`equity:${day}`);
        if (baseline === null && positive(account.equity)) this.store.set(`equity:${day}`, account.equity);
        this.dailyPnl = account.equity - (baseline ?? account.equity);
        if (!shared && this.dailyPnl <= -this.effectiveDailyLoss()) this.store.set(`lossHalt:${day}`, true);
        if (this.store.get(this.lossHaltKey(now), false)) this.issues.push('daily_loss_limit');
        this.riskLevels.tick(now, { unrealized: shared ? book.unrealized : positions.reduce((sum, p) => sum + (Number.isFinite(p.unrealized) ? p.unrealized : 0), 0),
          additionalRealized: this.paperRoutes.stats.valid ? this.paperRoutes.stats.totalPnl - this.paperRoutes.stats.unrealized : NaN });
        if (this.riskLevels.halted()) this.issues.push('drawdown_brake');
        this.ready = this.issues.length === 0;
        this.accounting.observeDay(now);
        this.desk?.enforceAllocation(now);
        for (const o of this.pending().filter(o => o.kind === 'entry')) {
          if(!isCrypto(o.symbol)&&this.schedule&&(!this.schedule.state(now).regular||o.holdingPolicy?.type==='carry'&&!this.schedule.state(now).carryWindow)) {o.entryDisableRequested=true;this.store.order(o);}
          if(isCrypto(o.symbol)&&this.cryptoUniverse&&!this.cryptoUniverse.allowed(o.symbol,now)){o.entryDisableRequested=true;this.store.order(o);}
          if(isCrypto(o.symbol)&&this.cfg.cryptoUniverse==='off'){o.entryDisableRequested=true;this.store.order(o);}
          if(o.addition && !this.strategyControls.additionsEnabled(o.strategy) && !terminal(o.status)) { o.entryDisableRequested=true; this.store.order(o); }
          if (o.strategy !== 'operator_paper_test' && !this.strategyControls.enabled(o.strategy) && !terminal(o.status) && o.filledQty < o.qty && !o.entryDisableRequested) {
            o.entryDisableRequested = true; this.store.order(o);
          }
          if (o.entryDisableRequested || now >= (o.entryDeadline ?? o.ts + this.cfg.entryTtl) || this.operatorPause || this.issues.includes('daily_loss_limit')) {
            if (!terminal(o.status) && !uncertain(o.status) && (!o.cancelRequestedAt || now - o.cancelRequestedAt > 5000)) await this.cancel(o);
          }
        }
        await this.manageExits(now);
        await this.paperRoutes.manage(now);
        this.dirtyOrderSymbols.clear();
        this.protection = { state: book.conflicts.length ? 'incident' : 'reconciled', observedAt: Date.now(), reason: book.conflicts.length ? 'managed_position_conflict' : null };
        this.lastReconcile = Date.now(); this.lastLoop = Date.now();
        if (now - (this.lastEquityRecord ?? 0) >= 5000) {
          this.store.event('equity', { equity: account.equity, cash: account.cash, dailyPnl: this.dailyPnl,
            unrealized: positions.reduce((sum, p) => sum + (Number.isFinite(p.unrealized) ? p.unrealized : 0), 0),
            observedAt: account.ts }, now);
          this.store.event('agent_equity', { dailyPnl: book.dailyPnl, unrealized: book.unrealized, observedAt: account.ts }, now);
          this.lastEquityRecord = now;
        }
        // Chart collection is observational; its failure must not disable exits.
        try { recordTradeMarks(this); this.tradeMarkError = null; }
        catch { this.tradeMarkError = 'Trade chart history could not be saved'; }
      } catch (error) {
        this.protection = { ...this.protection, state: 'blocked', reason: faultDetail(error) };
        this.fail('broker_reconciliation_failed', error); this.lastLoop = Date.now();
      }
    });
  }
  async manageExits(now) {
    const all = this.store.orders();
    for (const [symbol, m] of Object.entries(this.managed)) {
      if (this.externalSymbols.has(symbol)) continue;
      const p = this.positions.find(p => p.symbol === symbol), parent = all.find(o => o.id === m.entryId);
      const lots=campaignEntries(all,m.entryId), adding=lots.length>1;
      if (!p) {
        // A parent exit can beat a pending addition. Cancel it and keep ownership
        // until every submitted entry is terminal; a late buy remains managed.
        for(const lot of lots.filter(o=>!terminal(o.status) && !uncertain(o.status)))await this.cancel(lot);
        if (parent && lots.every(o=>terminal(o.status) && (!o.filledQty || o.settledAt))) { for(const lot of lots)this.exitEntries.delete(lot.id); this.campaignBooks.delete(m.entryId); delete this.managed[symbol]; this.store.set('managed', this.managed); }
        continue;
      }
      const q = this.quotes.get(symbol), fresh = validateQuote(q, now, this.cfg.maxQuoteAge);
      const native = lots.flatMap(o=>o.legs ?? []).filter(l => !terminal(l.status));
      const activeStop = native.some(l => ['stop', 'stop_limit'].includes(l.type) && !['held', 'pending_new'].includes(l.status));
      if (this.issues.includes('daily_loss_limit')) m.exitReason = 'daily_loss_limit';
      if (lots.some(o=>o.filledQty>0 && ['canceled', 'expired', 'rejected'].includes(o.status))) m.exitReason ||= 'partial_entry_canceled';
      if (adding && lots.some(o=>remainingQty(all,o)<o.filledQty))m.exitReason ||= 'campaign_lot_exit';
      const carry=parent?.holdingPolicy?.type==='carry';
      if (!carry && !isCrypto(symbol) && this.session.open && this.session.close - now < 5 * 60000) m.exitReason ||= 'session_end';
      if (carry ? now>=parent.holdingPolicy.exitBy : now - m.openedAt > m.maxHold) m.exitReason ||= carry?'carry_holding_deadline':'holding_time';
      if(carry) {
        const news=this.desk?.currentView(symbol,now);
        if(adverseNews(news,now))m.exitReason||='carry_news_invalidated';
        if(this.cfg.mode==='paper'&&now-m.openedAt>30000&&(!activeStop||parent.brokerTimeInForce!=='gtc'||!native.some(l=>l.type==='stop'&&l.brokerTimeInForce==='gtc')))m.exitReason||='carry_broker_protection_missing';
      }
      if (fresh && q.bid <= m.stop && !activeStop) m.exitReason ||= 'stop';
      if (fresh && m.addFloor && q.bid<=m.addFloor)m.exitReason ||= 'addition_profit_protection';
      if (fresh && q.bid >= m.target && !native.some(l => l.type === 'limit')) m.exitReason ||= 'target';
      if (!m.exitReason) continue;
      this.store.set('managed', this.managed);
      // Keep resting GTC protection intact overnight. A queued market sell can
      // otherwise race tomorrow's bracket exits or lose its protective stop.
      if(!isCrypto(symbol)&&this.cfg.mode!=='demo'&&(!this.session.open||this.schedule&&(!this.schedule.state().regular||this.schedule.state().today.close-this.clock()<=30000)))continue;
      if (this.pending().some(o => o.symbol === symbol && o.kind === 'exit')) continue;
      const unfinished=lots.filter(o=>!terminal(o.status));
      if (unfinished.length) { for(const lot of unfinished)if(!uncertain(lot.status))await this.cancel(lot); continue; }
      if (native.length) {
        for (const leg of native) { this.store.assertLease(); try { await this.broker.cancel(leg); } catch { /* Reconcile before another attempt. */ } }
        continue;
      }
      // If positions report reserved shares, wait for cancellation settlement.
      if (!positive(p.availableQty) || (!isCrypto(symbol) && !this.session.open)) continue;
      // Allocate each exit to its broker lot. Only one market exit is outstanding
      // for a symbol; refresh broker quantities before selling the next lot.
      const exitLot=lots.find(o=>remainingQty(all,o)>1e-8); if(!exitLot)continue;
      const qty = floorStep(Math.min(p.qty, p.availableQty, remainingQty(all,exitLot)), isCrypto(symbol) ? this.assets.get(symbol).min_trade_increment : 1);
      if (!positive(qty)) continue;
      if (isCrypto(symbol) && qty < this.assets.get(symbol).min_order_size) {
        if (!m.belowMinimum) {
          m.belowMinimum = true; this.store.set('managed', this.managed);
          this.store.event('exit_trigger', { symbol, reason: 'remaining_crypto_below_minimum', qty, note: 'Residual remains owned; no repeated invalid order submissions.' }, now);
        }
        continue;
      }
      const attempts = all.filter(o => o.kind === 'exit' && o.entryId === exitLot.id).length;
      const o = { id: idFor('x', [exitLot.id, attempts]), entryId: exitLot.id, symbol, kind: 'exit', qty, status: 'reserved', ts: now, reserved: 0, reason: m.exitReason, feeRateBps: isCrypto(symbol) ? this.cfg.cryptoFee : this.cfg.equityFee, filledQty: 0, legs: [] };
      this.store.order(o); await this.submit(o);
    }
  }
  async control(action) {
    return this.mutex.run(async () => {
      this.store.assertLease();
      if (action === 'pause') this.operatorPause = true;
      else if (action === 'resume') this.operatorPause = false;
      else if (action === 'reset_drawdown_brake') { this.riskLevels.reset(this.clock()); this.scheduleReconcile(); }
      else if (action === 'cancel_entries') {
        this.operatorPause = true;
        for (const o of this.pending().filter(o => o.kind === 'entry' && !terminal(o.status) && !uncertain(o.status))) await this.cancel(o);
      } else if (action === 'flatten') {
        this.operatorPause = true;
        this.paperRoutes.flatten();
        for (const m of Object.values(this.managed)) m.exitReason = 'operator_flatten';
        this.store.set('managed', this.managed);
        for (const o of this.pending().filter(o => o.kind === 'entry')) {
          o.exitAfterFill = true; this.store.order(o);
          if (!terminal(o.status) && !uncertain(o.status)) await this.cancel(o);
        }
      } else throw new Error('Unknown action');
      this.store.set('operatorPause', this.operatorPause); this.store.event('control', { action }, this.clock());
      if (this.operatorPause) this.cryptoQuoteWaits.cancel('entries_paused');
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
  // The saved ceiling is the Level 1 value; it scales with the highest risk level in use.
  effectiveDailyLoss() { return this.dailyLossLimit * this.riskLevels.portfolioMultiplier(); }
  noiseReservation() {
    let reason = null;
    if (!this.strategyControls.enabled('noise_area')) reason = 'strategy_disabled';
    else if (this.portfolio.state.reservedSymbols.includes(this.cfg.noiseSymbol)) reason = 'external_symbol_reserved';
    else if (!this.noiseArea) reason = 'handler_unavailable';
    else if (!this.session?.open || this.session.close - this.clock() < 10 * 60000) reason = 'session_ineligible';
    else if (this.noiseArea.reason !== 'ready' || this.noiseArea.state?.date !== nyDate(this.clock())) reason = 'context_unavailable';
    return { eligible: !reason, reason, notional: reason ? 0 : this.cfg.noiseNotional };
  }
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
  entryAvailability() {
    const now=this.clock(), schedule=this.schedule?.state(now), cutoff=this.strategyControls.enabledIds().some(isCarryStrategy)&&schedule?.carryWindow?300000:600000;
    const equityBlockers=[...(!this.session?.open||this.session.close-now<cutoff||schedule&&!schedule.regular?['equity_session_closed_or_closing']:[]),...(this.universe&&!this.universe.entryReady(now)?['universe_scan_stale']:[]),...(!this.cfg.equities.some(s=>validateQuote(this.quotes.get(s),now,this.cfg.maxQuoteAge))?['equity_quotes_missing_or_stale']:[])];
    const allowed=this.cfg.crypto.filter(s=>this.cfg.cryptoUniverse!=='off'&&(!this.cryptoUniverse||this.cryptoUniverse.allowed(s,now)));
    const cryptoBlockers=[...(!allowed.length?['crypto_rank_unavailable_or_disabled']:[]),...(!allowed.some(s=>validateQuote(this.quotes.get(s),now,this.cfg.maxQuoteAge))?['crypto_quotes_missing_or_stale']:[])];
    return {equity:{ready:!equityBlockers.length,blockers:equityBlockers},crypto:{ready:!cryptoBlockers.length,blockers:cryptoBlockers}};
  }
  status() {
    const now = this.clock();
    const clockBlocked = this.timebase && !this.timebase.status().synchronized;
    const assetReadiness=this.entryAvailability(), eligible=assetReadiness.equity.ready||assetReadiness.crypto.ready;
    return { version: RELEASE.version, release:RELEASE, backup:this.store.get('backupStatus'), cryptoContext: this.cryptoContextStatus, cryptoSignals: this.cryptoQuoteWaits.snapshot(), brokerBudget: this.broker.budgetStatus?.() ?? null, timings: this.realtime.summary(), mode: this.cfg.mode, accountPolicy: this.cfg.accountPolicy, portfolio: this.portfolio.state, now, startedAt: this.startedAt, ready: this.ready && !clockBlocked, paused: this.operatorPause,
      issues: [...new Set([...this.issues, ...(clockBlocked ? ['clock_not_synchronized'] : [])])],
      diagnostics: marketDiagnostics(this), protection: protectionHealth(this), noiseReservation: this.noiseReservation(),
      entryReady: this.ready && !clockBlocked && eligible && !this.operatorPause && (this.broker.entryBudgetAvailable?.() ?? true), assetReadiness,
      entryBlockers: [...new Set([...this.issues, ...(!eligible?[...assetReadiness.equity.blockers,...assetReadiness.crypto.blockers]:[]), ...(clockBlocked ? ['clock_not_synchronized'] : []), ...(this.operatorPause ? ['operator_pause'] : []), ...(this.broker.entryBudgetAvailable && !this.broker.entryBudgetAvailable() ? ['broker_request_budget'] : [])])],
      schedule:this.schedule?.state(now)??null,cryptoUniverse:this.cryptoUniverse?.status()??{mode:this.cfg.cryptoUniverse},
      reconciliation: { ...this.externalDetails, policy: this.cfg.accountPolicy, blocking: this.issues.some(x => ['external_account_activity', 'external_orders_pending', 'managed_position_conflict', 'agent_accounting_unavailable'].includes(x)), reservedSymbols: this.portfolio.state.reservedSymbols, observedAt: this.lastReconcile,
        guidance: this.cfg.accountPolicy === 'shared' ? 'External holdings remain in this account and are never adopted or closed by the agents. Their symbols and option underlyings are reserved. Agent limits use only the managed book; pending external orders and managed-quantity discrepancies still block new entries.' : 'Entries require an account reconciled with this engine journal. Existing holdings and orders from other tools remain external. Restore the matching journal if these were engine orders, or reconcile them separately in your broker account. Resume and changing the loss ceiling do not adopt external holdings.' },
      account: this.account && { equity: this.account.equity, cash: this.account.cash, buyingPower: this.account.buyingPower }, dailyPnl: this.dailyPnl ?? 0,
      positions: this.positions.map(p => ({ ...p, management: this.externalSymbols.has(p.symbol) ? null : this.managed[p.symbol] ?? this.paperRoutes.active().find(t => t.symbols.includes(p.symbol)) ?? null })), orders: this.store.orders().slice(-100).reverse(),
      candidates: this.store.candidates(60), events: this.store.events(40).filter(e => e.type !== 'market_sample'),
      universe: this.universe?.status() ?? {mode:'static',state:'static',streamed:this.cfg.equities.length},
      market: this.cfg.symbols.map(symbol => ({ symbol, quote: this.quotes.get(symbol) ?? null, bars: (isCrypto(symbol) && this.cfg.mode !== 'demo' ? this.cryptoFeatures : this.features).history.get(symbol)?.length ?? 0, features: this.snapshots.get(symbol) ?? null })),
      workers: this.workers.status().map(w => ({ ...w, enabled: this.strategyControls.enabled(w.strategy) })), enabledStrategies: this.strategyControls.enabledIds(), strategyRevision: this.strategyControls.state.revision, noiseArea: this.noiseArea?.status() ?? null, feeds: this.feeds, lastReconcile: this.lastReconcile, pairs: [...this.pairs.values()],
      microstructure: this.cfg.symbols.map(symbol => ({ symbol, ...this.microstructure.snapshot(symbol, now) })),
      jev: { mode: this.cfg.jevMode, model: this.cfg.jevModel, spent: this.store.spend(new Date(now).toISOString().slice(0, 7)), budget: this.cfg.jevBudget },
      limits: { scope: this.cfg.accountPolicy === 'shared' ? 'agent' : 'account', capital: this.cfg.capital, maxGross: this.cfg.maxGross, maxPosition: this.cfg.maxPosition, maxPositions: this.cfg.maxPositions === 0 ? null : this.cfg.maxPositions, dailyLoss: this.dailyLossLimit,
        dailyLossDefault: this.cfg.dailyLoss, dailyLossOverride: this.store.get('dailyLossOverride') !== null, dailyLossHalted: this.store.get(this.lossHaltKey(now), false),
        effectiveDailyLoss: this.effectiveDailyLoss() },
      riskLevels: this.riskLevels.snapshot(),
      warnings: [...(this.cfg.mode === 'demo' ? ['Synthetic accelerated data; results have no investment meaning.'] : []), ...(this.cfg.crypto.length ? ['Crypto exits depend on this service and network availability.'] : []), 'Strategies and model thresholds are unvalidated research hypotheses.'] };
  }
  healthyForHeartbeat() {
    if(this.store.get('backupStatus')?.verified===false)return false;
    if (!protectionHealth(this).healthy || this.workers.status().some(w => this.strategyControls.enabled(w.strategy) && !w.alive)) return false;
    if (this.timebase && !this.timebase.status().synchronized) return false;
    if (!this.ready || Date.now() - this.lastReconcile > 30000) return false;
    if (this.cfg.mode === 'demo') return true;
    const relevant = [...this.cfg.crypto, ...(this.session?.open ? this.cfg.equities : [])];
    return relevant.every(s => validateQuote(this.quotes.get(s), this.clock(), 60000));
  }
}
