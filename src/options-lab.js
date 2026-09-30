import { optionLegs } from './options-structure.js';
import { join } from 'node:path';
import { hash } from './util.js';
import { OPTIONS_POLICY as P, optionsDefinition } from './options-policy.js';
import { freshOptionsState, validateOptionsState, advanceOptions, optionsSummary, optionsRecord } from './options-state.js';
import { OptionsTape } from './options-tape.js';
export { OPTIONS_CODE_HASH } from './options-manifest.js';
export { freshOptionsState, validateOptionsState, advanceOptions, optionsSummary, optionsRecord } from './options-state.js';
export { replayOptions, replayOptionsStress } from './options-replay.js';

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
    if (this.blocked) {
      for (const s of summary.strategies) { s.netPnl = null; s.stressNetPnl = null; s.openNet = null; }
      summary.netPnl = null; summary.sampledDrawdown = null;
    }
    const previous = this.blocked ? this.engine.store.get('optionsLab') : null;
    const restartable = !!previous && ['positions', 'pending', 'trades'].every(k => Array.isArray(previous[k])) && !previous.positions.length && !previous.pending.length;
    return { ...summary, migration: previous ? { restartable, expectedStateHash: hash(previous), previousCodeHash: previous.codeHash,
      closedTrades: previous.trades?.length ?? null, openPositions: previous.positions?.length ?? null, pending: previous.pending?.length ?? null } : null,
      archive:this.engine.store.optionArchiveStatus(), unavailableReason: this.unavailable(), error: this.error ?? this.tape.error, polling: this.running };
  }
  async restartExperiment(request) {
    const error = (message, status = 409) => Object.assign(new Error(message), { status });
    if (!request || Object.keys(request).some(k => !['action','expectedStateHash'].includes(k)) || request.action !== 'archive_flat_and_restart' || typeof request.expectedStateHash !== 'string') throw error('Invalid options experiment request', 400);
    const e = this.engine;
    return e.mutex.run(() => {
      e.store.assertLease();
      const old = e.store.get('optionsLab');
      if (!this.blocked || this.running || !old || hash(old) !== request.expectedStateHash) throw error('Options experiment changed; refresh first.');
      if (!['positions','pending','trades'].every(k => Array.isArray(old[k])) || old.positions.length || old.pending.length) throw error('Cannot migrate an experiment with open or pending shadow positions. Preserve and reconcile the previous version first.');
      const next = freshOptionsState(), key = 'optionsLabArchive:' + hash(old);
      e.store.transaction(() => {
        e.store.set(key, { archivedAt: e.clock(), state: old });
        e.store.set('optionsLab', next);
        e.store.event('options_experiment_archived', { key, oldCodeHash: old.codeHash, closedTrades: old.trades.length, newCodeHash: next.codeHash }, e.clock());
      });
      this.state = next; this.blocked = false; this.error = null;
      return this.snapshot();
    });
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
    if (this.engine.schedule && !this.engine.schedule.state().equityTracking) return;
    const comparison = this.engine.tradeAlternatives, labActive = !this.unavailable() &&
      (Object.values(this.state.enabled).some(Boolean) || this.state.positions.length || this.state.pending.length);
    if (this.running || !this.adapter || (!labActive && !comparison?.active) || Date.now() - this.lastPoll < P.pollMs) return;
    this.running = true; this.lastPoll = Date.now(); const revision = this.state.revision;
    try {
      const watched = [...(labActive ? [...this.state.positions, ...this.state.pending].flatMap(p => optionLegs(p).map(l=>l.contract)) : []), ...(comparison?.active ? comparison.watched() : [])];
      const frame = await this.adapter.capture(['SPY', 'QQQ'], watched), e = this.engine;
      if (e.stopped) return;
      if (e.schedule && !e.schedule.state().equityTracking) return;
      await e.mutex.run(async () => {
        if (e.stopped) return;
        e.store.assertLease();
        if (labActive) {
          const allowNew = revision === this.state.revision && !e.operatorPause && !this.tape.error, next = structuredClone(this.state);
          advanceOptions(next, frame, allowNew);
          const checkpoint = !this.state.lastAt || e.store.get('optionsTapeHead')?.date !== frame.session?.date || !e.store.get('optionsTapeHead');
          e.store.saveOptionsFrame(optionsRecord(this.state, frame, allowNew, checkpoint),next);this.state=next;
        }
        if (comparison?.active) {
          try { comparison.observe(frame, !e.operatorPause); }
          catch { comparison.error = 'comparison_record_failed'; }
        }
        this.error=null;
      });
      await this.tape.flush();
    } catch (error) {
      this.error = /^options_[a-z0-9_]+$/.test(error.message) ? error.message : 'options_capture_failed';
      if (comparison?.active) comparison.error = this.error;
    }
    finally { this.running = false; }
  }
}
