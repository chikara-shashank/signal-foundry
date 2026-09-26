import { idFor, nyDate, validBar } from './util.js';
import { sessionContext, vwapSignal } from './session-signals.js';

export const VWAP_STRATEGY = 'vwap_trend';

// Long-only adaptation of Zarattini/Aziz's minute VWAP trend rule. One ETF,
// existing engine sizing/protection, no leverage and no automatic activation.
export class VwapTrend {
  state = null; busy = false; retryAt = 0;
  constructor(engine, history) { this.engine = engine; this.history = history; this.symbol = engine.cfg.noiseSymbol; }
  addBar(b) {
    const s = this.state;
    if (s && b.symbol === this.symbol && validBar(b) && b.ts >= s.open && b.ts < s.close) s.bars.set(b.ts, b);
  }
  async onBar(b) {
    const e = this.engine, owned = e.managed[this.symbol], now = e.clock();
    if (b.symbol !== this.symbol || e.stopped || !['paper', 'shadow'].includes(e.cfg.mode) ||
        (!e.strategyControls.enabled(VWAP_STRATEGY) && owned?.strategy !== VWAP_STRATEGY)) return;
    const session = e.schedule?.state(now).today;
    if (!session || now < session.open || now >= session.close || b.ts < session.open || b.ts + 60000 > now) return;
    if (this.state?.date !== session.date) this.state = { ...session, bars: new Map(), lastDecision: 0, restored: false };
    this.addBar(b);
    if (this.busy || now < this.retryAt) return;
    this.busy = true;
    try {
      const s = this.state, mark = b.ts + 60000;
      if (!s.restored) {
        for (const bar of (await this.history.bars([this.symbol], s.open, mark)).get(this.symbol) ?? []) this.addBar(bar);
        s.restored = true;
      }
      if (e.stopped || e.clock() - mark > 10000 || mark <= s.lastDecision) return;
      s.lastDecision = mark;
      const context = sessionContext([...s.bars.values()], s.open, mark);
      if (!context) return;
      const current = e.managed[this.symbol], held = current?.strategy === VWAP_STRATEGY && !current.exitReason;
      let action = vwapSignal(context, held);
      if (!held && (current || e.pending().some(o => o.symbol === this.symbol))) action = 'symbol_busy';
      else if (!held && (!e.strategyControls.enabled(VWAP_STRATEGY) || mark < e.strategyControls.state.strategies[VWAP_STRATEGY].changedAt)) action = 'strategy_disabled';
      else if (!held && mark >= s.close - 10 * 60000) action = 'entry_window_closed';
      e.observability.evaluation({ symbol: this.symbol, strategy: VWAP_STRATEGY, ts: now, matched: action === 'enter_long', passed: context.price > context.vwap ? 1 : 0,
        reason: action, checks: [{ name: 'Completed minute above session VWAP', actual: context.price, operator: '>', target: context.vwap, unit: 'USD', pass: context.price > context.vwap }] });
      if (action === 'exit_long') {
        await e.mutex.run(() => {
          const position = e.managed[this.symbol];
          if (position?.strategy === VWAP_STRATEGY && !position.exitReason) { position.exitReason = 'vwap_trailing_stop'; e.store.set('managed', e.managed); }
        });
        e.scheduleReconcile();
      } else if (action === 'enter_long') {
        const price = context.price;
        await e.submitCandidate({ id: idFor('c', [VWAP_STRATEGY, '1.0.0', this.symbol, nyDate(now), mark]), strategy: VWAP_STRATEGY, version: '1.0.0', symbol: this.symbol,
          ts: now, expires: now + 10000, reference: price, stop: price * .985, target: price * 1.05, maxHold: s.close - now,
          priority: 1, features: { version: b.ts, sessionVwap: context.vwap }, status: 'discovered' });
      }
    } catch (error) {
      this.retryAt = e.clock() + 60000; if (this.state) this.state.restored = false;
      e.store.event('vwap_context_unavailable', { symbol: this.symbol, reason: /^stock_history_\w+$/.test(error.message) ? error.message : 'context_unavailable' }, e.clock());
    } finally { this.busy = false; }
  }
}
