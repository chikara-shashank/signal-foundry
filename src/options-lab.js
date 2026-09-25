import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hash, nyDate } from './util.js';
import { OPTIONS_POLICY as P, OPTIONS_STRATEGIES, OPTIONS_FINGERPRINT, optionsDefinition, scanOptions, spreadEconomics, daysToExpiry } from './options-strategies.js';
import { OptionsTape } from './options-tape.js';

export const OPTIONS_CODE_HASH = hash(['options-strategies.js', 'options-data.js', 'options-lab.js', 'options-tape.js', 'store.js'].map(file => readFileSync(new URL(file, import.meta.url), 'utf8').replaceAll('\r\n', '\n')));
export function freshOptionsState() {
  return { policyHash: OPTIONS_FINGERPRINT, codeHash: OPTIONS_CODE_HASH, revision: 0, enabled: Object.fromEntries(OPTIONS_STRATEGIES.map(s => [s.id, false])),
    lastAt: 0, positions: [], pending: [], trades: [], used: {}, equity: [], qualityIssues: [], haltedDate: null, peakNet: 0, maxDrawdown: 0, lastScan: null };
}
const sum = a => a.reduce((s, x) => s + x, 0);
const issue = (s, name) => { if (!s.qualityIssues.includes(name)) s.qualityIssues.push(name); };
const stressIncrement = 4 * (P.stressFee - P.feePerContractSide) + 400 * (P.stressSlippage - P.slippagePerLeg);
const closedNet = s => sum(s.trades.map(t => t.netPnl));
const pendingKey = p => `${p.strategy}:${p.underlying}:${p.decisionAt}`;

export function optionsRecord(state, frame, allowNew = true, checkpoint = false) {
  return { policyHash: OPTIONS_FINGERPRINT, codeHash: OPTIONS_CODE_HASH, ...(checkpoint ? { initialState: structuredClone(state) } : {}),
    beforeStateHash: hash(state), frameHash: hash(frame), pendingKeys: state.pending.map(pendingKey), enabled: { ...state.enabled }, revision: state.revision, allowNew, frame };
}

export function validateOptionsState(s) {
  if (s?.policyHash !== OPTIONS_FINGERPRINT || s?.codeHash !== OPTIONS_CODE_HASH || !Number.isSafeInteger(s.revision) || s.revision < 0 || !OPTIONS_STRATEGIES.every(x => typeof s.enabled?.[x.id] === 'boolean') ||
    !['positions', 'pending', 'trades', 'equity', 'qualityIssues'].every(k => Array.isArray(s[k])) || !s.used || !Number.isFinite(s.lastAt)) throw new Error('options_experiment_state_mismatch');
}

// Pure deterministic state transition. No broker object and no network access.
export function advanceOptions(s, frame, allowNew = true, policy = P) {
  validateOptionsState(s);
  const fees = 4 * policy.feePerContractSide;
  if (frame.schema !== 1 || frame.source !== 'alpaca_opra' || frame.stockFeed !== 'sip' || !Number.isFinite(frame.now) || frame.now <= s.lastAt || !Number.isFinite(frame.clockUncertaintyMs) || frame.clockUncertaintyMs > 1000) throw new Error('options_frame_invalid_or_out_of_order');
  const now = frame.now, date = nyDate(now), last = s.lastAt;
  if (s.positions.length && frame.marketOpen && frame.session && last && now - Math.max(last, frame.session.open) > policy.maxGapMs) issue(s, 'open_position_capture_gap');
  s.lastAt = now;
  const previousDay = s.equity.findLast(x => x.date < date);
  let unknownMark = false;
  for (const p of [...s.positions]) {
    const def = optionsDefinition(p.strategy);
    if (date >= p.expiry || (!def.credit && date > nyDate(p.openedAt))) issue(s, 'unmodeled_expiration_or_overnight_intraday_position');
    if (!frame.marketOpen || !frame.session || now < frame.session.open || now >= frame.session.close || date >= p.expiry) { p.markNet = null; unknownMark = true; continue; }
    const x = spreadEconomics(p, frame.quotes, now, policy, false);
    if (x.reason) { p.markNet = null; unknownMark = true; continue; }
    p.markNet = (x.exitValue - p.entryCost) * 100 - fees;
    const short = frame.quotes[p.short.symbol], spot = frame.spots[p.underlying]?.price;
    const intrinsic = p.short.type === 'put' ? Math.max(0, p.short.strike - spot) : Math.max(0, spot - p.short.strike);
    // Flag exposure that a quote-only simulator cannot resolve as an actual assignment.
    if (intrinsic > 0 && short && (short.ask + short.bid) / 2 - intrinsic < .10) issue(s, 'early_assignment_exposure');
    if (p.exitRequestedAt && now >= p.exitRequestedAt + policy.latencyMs && x.oldestQuote >= p.exitRequestedAt + policy.latencyMs) {
      s.trades.push({ ...p, closedAt: now, exitValue: x.exitValue, grossPnl: (x.exitValue - p.entryCost) * 100,
        fees, netPnl: p.markNet, stressNetPnl: p.markNet - stressIncrement, holdout: nyDate(p.decisionAt) >= policy.holdoutStart });
      s.positions = s.positions.filter(x => x !== p); continue;
    }
    if (!p.exitRequestedAt) {
      const profitTarget = def.credit ? -p.entryCost * 100 * .50 : p.maxLoss * .50;
      const stopLoss = def.credit ? Math.min(p.maxLoss, -p.entryCost * 100) : p.maxLoss * .40;
      const timeExit = def.credit ? daysToExpiry(p.expiry, now) <= 7 || now - p.openedAt >= 14 * 86400000
        : now - p.openedAt >= 90 * 60000 || now >= frame.session.close - 20 * 60000;
      if (p.markNet >= profitTarget || p.markNet <= -stopLoss || timeExit) {
        p.exitRequestedAt = now; p.exitReason = timeExit ? 'time' : p.markNet >= profitTarget ? 'profit_target' : 'loss_limit';
      }
    }
  }
  const markedNet = unknownMark ? null : closedNet(s) + sum(s.positions.map(p => p.markNet));
  const todayNet = markedNet === null ? null : markedNet - (previousDay?.net ?? 0);
  if (todayNet !== null && todayNet <= -policy.dailyLoss) {
    s.haltedDate = date;
    for (const p of s.positions) if (!p.exitRequestedAt) { p.exitRequestedAt = now; p.exitReason = 'daily_loss'; }
  }
  const entriesAllowed = allowNew && !unknownMark && todayNet !== null && s.haltedDate !== date && !s.qualityIssues.length && s.trades.length < 5000;
  const selected = entriesAllowed ? OPTIONS_STRATEGIES.filter(d => s.enabled[d.id]).map(d => d.id) : [];
  const scan = scanOptions(frame, selected, policy);
  s.lastScan = { at: now, candidates: scan.candidates.map(c => ({ strategy: c.strategy, underlying: c.underlying, expiry: c.expiry, long: c.long.symbol, short: c.short.symbol, maxLoss: c.maxLoss, maxProfit: c.maxProfit, roundTripCost: c.immediateRoundTripLoss })),
    rejected: scan.rejected, entryGate: !allowNew ? 'paused_or_settings_changed' : unknownMark ? 'unavailable_position_mark' : s.qualityIssues.length ? 'capture_or_lifecycle_issue' : s.haltedDate === date ? 'daily_loss' : selected.length ? 'scanning' : 'strategies_off' };
  for (const p of [...s.pending]) {
    if (!entriesAllowed || !s.enabled[p.strategy] || now - p.decisionAt > policy.pendingTtlMs) { s.pending = s.pending.filter(x => x !== p); continue; }
    if (now < p.decisionAt + policy.latencyMs) continue;
    const stillQualified = scan.candidates.some(c => c.strategy === p.strategy && c.long.symbol === p.long.symbol && c.short.symbol === p.short.symbol);
    const x = spreadEconomics(p, frame.quotes, now, policy);
    if (!stillQualified || x.reason || x.oldestQuote < p.decisionAt + policy.latencyMs || x.entryCost > p.entryCost + 1e-9 || x.maxLoss > policy.maxRisk) continue;
    if (s.positions.length >= policy.maxPositions || s.positions.some(x => x.underlying === p.underlying) || sum(s.positions.map(x => x.maxLoss)) + x.maxLoss > policy.maxPortfolioRisk) continue;
    s.positions.push({ ...p, ...x, openedAt: now, markNet: (x.exitValue - x.entryCost) * 100 - fees });
    s.pending = s.pending.filter(x => x !== p);
  }
  // Reserve full spread risk for pending intents too. One attempt per strategy/underlying/session.
  for (const c of scan.candidates) {
    const key = `${date}:${c.strategy}:${c.underlying}`, reserved = [...s.positions, ...s.pending];
    const blocked=s.used[key]?'daily_attempt_used':reserved.length>=policy.maxPositions?'portfolio_position_limit':reserved.some(p=>p.underlying===c.underlying)?'underlying_already_reserved':sum(reserved.map(p=>p.maxLoss))+c.maxLoss>policy.maxPortfolioRisk?'portfolio_risk_limit':null;
    if(blocked){s.lastScan.rejected[blocked]=(s.lastScan.rejected[blocked]??0)+1;continue;}
    s.pending.push(c); s.used[key] = true;
  }
  const net = s.positions.some(p => p.markNet === null) ? null : closedNet(s) + sum(s.positions.map(p => p.markNet));
  if (net !== null) { s.peakNet = Math.max(s.peakNet, net); s.maxDrawdown = Math.max(s.maxDrawdown, s.peakNet - net); }
  if (frame.marketOpen) {
    const point = { date, at: now, net };
    if (s.equity.at(-1)?.date === date) s.equity[s.equity.length - 1] = point; else s.equity.push(point);
  }
  return s;
}

export function optionsSummary(s, now = s.lastAt) {
  const trades = s.trades, profitFactor = rows => { const loss = -sum(rows.filter(t => t.netPnl < 0).map(t => t.netPnl)); return loss ? sum(rows.filter(t => t.netPnl > 0).map(t => t.netPnl)) / loss : null; };
  const strategies = OPTIONS_STRATEGIES.map(d => {
    const rows = trades.filter(t => t.strategy === d.id), open = s.positions.filter(p => p.strategy === d.id);
    return { ...d, enabled: s.enabled[d.id], closed: rows.length, netPnl: sum(rows.map(t => t.netPnl)), stressNetPnl: sum(rows.map(t => t.stressNetPnl)),
      winRate: rows.length ? rows.filter(t => t.netPnl > 0).length / rows.length : null, profitFactor: profitFactor(rows),
      openPositions: open.length, pending: s.pending.filter(p => p.strategy === d.id).length,
      openNet: open.some(p => p.markNet === null) || (open.length && now - s.lastAt > P.maxGapMs) ? null : sum(open.map(p => p.markNet)) };
  });
  const holdout = trades.filter(t => t.holdout), sessions = s.equity.filter(x => x.date >= P.holdoutStart);
  return { mode: 'quote_shadow_only', policy: P, policyHash: OPTIONS_FINGERPRINT, codeHash: OPTIONS_CODE_HASH, revision: s.revision, lastAt: s.lastAt,
    strategies, positions: s.positions, pending: s.pending.length, lastScan: s.lastScan, qualityIssues: s.qualityIssues, netPnl: closedNet(s), sampledDrawdown: s.maxDrawdown,
    validation: { liveEligible: false, verdict: 'UNVALIDATED', holdoutStart: P.holdoutStart, observedHoldoutSessions: sessions.length, holdoutTrades: holdout.length,
      holdoutNet: sum(holdout.map(t => t.netPnl)), holdoutStressNet: sum(holdout.map(t => t.stressNetPnl)), minimumSessions: P.minimumSessions, minimumTrades: P.minimumTrades,
      blockers: ['Prospective sample and independent statistical review required', 'Snapshot sampling cannot prove fills or intrabar drawdown', 'Assignment, exercise and broker multi-leg reconciliation are not implemented', ...s.qualityIssues] },
    note: 'Hypothetical one-contract spreads, OPRA bid/ask plus slippage and assumed fees. No broker orders. Open marks and sampled drawdown can miss moves between observations. Disabling stops new entries; shadow exits continue. Results are separate from actual account performance.' };
}

export class OptionsLab {
  constructor(engine, adapter) {
    this.engine = engine; this.adapter = adapter; this.state = engine.store.get('optionsLab', freshOptionsState());
    try { validateOptionsState(this.state); } catch { this.blocked = true; this.state = freshOptionsState(); }
    this.running = false; this.lastPoll = 0; this.error = null;
    this.tape = new OptionsTape(engine.store, join(engine.cfg.dataDir,'options-research'));
  }
  unavailable() {
    if (this.blocked) return 'Options experiment changed. Previous ledger is preserved; options disabled until an explicit experiment migration.';
    return this.adapter && ['paper', 'shadow'].includes(this.engine.cfg.mode) ? null : 'Requires paper/shadow mode and Alpaca OPRA + SIP data. No synthetic options prices.';
  }
  snapshot() {
    const summary = optionsSummary(this.state, this.engine.clock());
    if (this.blocked) for (const s of summary.strategies) { s.netPnl = null; s.stressNetPnl = null; s.openNet = null; }
    return { ...summary, archive:this.engine.store.optionArchiveStatus(), unavailableReason: this.unavailable(), error: this.error ?? this.tape.error, polling: this.running };
  }
  async update(request) {
    if (!request || Object.keys(request).some(k => !['strategy', 'enabled', 'expectedRevision'].includes(k)) || !optionsDefinition(request.strategy) || typeof request.enabled !== 'boolean' || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) throw Object.assign(new Error('Invalid options strategy selection'), { status: 400 });
    const e = this.engine;
    return e.mutex.run(async () => {
      e.store.assertLease();
      if (this.blocked) throw Object.assign(new Error(this.unavailable()), { status: 409 });
      if (request.expectedRevision !== this.state.revision) throw Object.assign(new Error('Options settings changed; refresh and retry.'), { status: 409 });
      if (request.enabled && this.unavailable()) throw Object.assign(new Error(this.unavailable()), { status: 409 });
      const next = structuredClone(this.state);
      if (next.enabled[request.strategy] !== request.enabled) {
        next.enabled[request.strategy] = request.enabled; next.revision++;
        if (!request.enabled) next.pending = next.pending.filter(p => p.strategy !== request.strategy);
        e.store.transaction(() => { e.store.set('optionsLab', next); e.store.event('options_settings_changed', request, e.clock()); });
        this.state = next;
      }
      return this.snapshot();
    });
  }
  async poll() {
    if (this.running || this.unavailable() || Date.now() - this.lastPoll < P.pollMs || (!Object.values(this.state.enabled).some(Boolean) && !this.state.positions.length && !this.state.pending.length)) return;
    this.running = true; this.lastPoll = Date.now(); const revision = this.state.revision;
    try {
      const watched = [...this.state.positions, ...this.state.pending].flatMap(p => [p.long, p.short]);
      const frame = await this.adapter.capture(['SPY', 'QQQ'], watched), e = this.engine;
      if (e.stopped) return;
      await e.mutex.run(async () => {
        if (e.stopped) return;
        e.store.assertLease();
        const allowNew = revision === this.state.revision && !e.operatorPause && !this.tape.error, next = structuredClone(this.state);
        advanceOptions(next, frame, allowNew);
        const checkpoint = !this.state.lastAt || e.store.get('optionsTapeHead')?.date !== frame.session?.date || !e.store.get('optionsTapeHead');
        e.store.saveOptionsFrame(optionsRecord(this.state, frame, allowNew, checkpoint),next);this.state=next;this.error=null;
      });
      await this.tape.flush();
    } catch (error) { this.error = /^options_[a-z0-9_]+$/.test(error.message) ? error.message : 'options_capture_failed'; }
    finally { this.running = false; }
  }
}

export function replayOptions(records) {
  if (!records.length || !records[0].initialState) throw new Error('options_tape_checkpoint_required');
  let state = freshOptionsState();
  if (records[0]?.initialState) { state = structuredClone(records[0].initialState); validateOptionsState(state); }
  let prior;
  for (const record of records) {
    if (record.sequence != null) {
      const { recordHash, ...body } = record;
      if (!Number.isSafeInteger(record.sequence) || record.sequence < 1 || recordHash !== hash(body)) throw new Error('options_tape_record_integrity');
      if (prior && (record.sequence !== prior.sequence + 1 || record.previousRecordHash !== prior.recordHash)) throw new Error('options_tape_chain_discontinuity');
    } else if (prior?.sequence != null) throw new Error('options_tape_chain_discontinuity');
    if (record.policyHash !== OPTIONS_FINGERPRINT || record.codeHash !== OPTIONS_CODE_HASH) throw new Error('options_tape_experiment_mismatch');
    if (!record.frameHash || !record.beforeStateHash || !record.pendingKeys) throw new Error('options_tape_integrity_fields_required');
    if (record.frameHash !== hash(record.frame)) throw new Error('options_tape_data_mismatch');
    state.enabled = record.enabled; state.revision = record.revision;
    state.pending = state.pending.filter(p => state.enabled[p.strategy] && (!record.pendingKeys || record.pendingKeys.includes(pendingKey(p))));
    if (record.beforeStateHash !== hash(state)) throw new Error('options_tape_state_discontinuity');
    advanceOptions(state, record.frame, record.allowNew);
    prior = record;
  }
  return { ...optionsSummary(state), trades: state.trades };
}

export function replayOptionsStress(records) {
  // Verify the original observation chain first. Stress decisions then evolve
  // independently; copying primary pending orders or exit times would bias fills.
  replayOptions(records);
  const state=structuredClone(records[0].initialState);
  if(state.positions.length||state.pending.length||state.trades.length)throw new Error('options_stress_requires_flat_experiment_start');
  const policy={...P,latencyMs:3500,slippagePerLeg:P.stressSlippage,feePerContractSide:P.stressFee};
  for(const r of records){state.enabled={...r.enabled};state.revision=r.revision;state.pending=state.pending.filter(p=>state.enabled[p.strategy]);advanceOptions(state,r.frame,r.allowNew,policy);}
  // These paths already paid adverse fees/slippage; do not subtract the
  // dashboard's primary-path cost sensitivity a second time.
  for(const trade of state.trades)trade.stressNetPnl=trade.netPnl;
  return {...optionsSummary(state),policy,trades:state.trades,scenario:'independent_3500ms_adverse_costs',liveEligible:false,
    limitations:['Independent decisions and later quote requirements; snapshots still cannot prove execution.', 'Stress can miss entries, change allocation and trigger different exits. It does not model queue priority, actual assignment or broker fills.']};
}
