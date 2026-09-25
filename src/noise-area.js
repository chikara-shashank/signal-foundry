import { idFor, nyDate } from './util.js';

// Noise-area breakout after Zarattini, Aziz & Barbon (2024), long side only: the engine
// cannot hold agent short positions yet. The band is max/min(open, prior close) scaled by
// the average absolute move from the open at the same time over the prior 14 sessions.
// Decisions at each :00/:30 from 10:00 to 30 minutes before the close: open a long above
// the upper band; exit at the first decision below max(upper band, session VWAP). The
// engine's session-end exit flattens anything left. docs/INTRADAY-RESEARCH-2026-09.md
// has the historical test.
export const NOISE_STRATEGY = 'noise_area';
const VERSION = '1.0.0', LOOKBACK = 14, STEP = 30, MIN_SAMPLES = 10;
const TARGET = 0.05; // Bracket take-profit placeholder, beyond the strategy's intraday reach.

export class NoiseArea {
  state = null; busy = false; deciding = false; retryAt = 0; lastDecision = null; reason = 'waiting_for_session';
  constructor(engine, venue, history) { Object.assign(this, { engine, venue, history, symbol: engine.cfg.noiseSymbol }); }
  async tick(now) {
    if(this.engine.schedule&&!this.engine.schedule.state(now).equityTracking){this.reason='equity_tracking_scheduled_off';return;}
    if (!this.engine.strategyControls.enabled(NOISE_STRATEGY) && this.engine.managed[this.symbol]?.strategy !== NOISE_STRATEGY) { this.reason = 'strategy_disabled'; return; }
    if (!this.engine.session?.open) { this.reason = 'equity_session_closed'; return; }
    await this.prepare(now);
    await this.evaluate(now);
  }
  // Once per session: calendar, prior close and the per-mark band width from 30-minute provider bars.
  async prepare(now) {
    const e = this.engine, today = nyDate(now);
    if (this.state?.date === today || this.busy || now < this.retryAt) return;
    this.busy = true;
    try {
      const sessions = (await this.venue.calendar(nyDate(now - 45 * 86400000), today)).filter(s => s.date <= today);
      const current = sessions.at(-1);
      if (current?.date !== today || now < current.open || now >= current.close) { this.reason = 'no_session_today'; this.retryAt = now + 600000; return; }
      const prior = sessions.slice(-1 - LOOKBACK, -1);
      if (prior.length < LOOKBACK) throw new Error('noise_history_incomplete');
      const bars = (await this.history.bars([this.symbol], prior[0].open, current.open, '30Min')).get(this.symbol);
      const days = prior.map(s => {
        const own = bars.filter(b => b.ts >= s.open && b.ts < s.close);
        if (!own.length || own[0].ts !== s.open) return null;
        return { moves: new Map(own.map(b => [(b.ts - s.open) / 60000 + STEP, Math.abs(b.close / own[0].open - 1)])), close: own.at(-1).close, complete: own.at(-1).ts === s.close - STEP * 60000 };
      });
      if (!days.at(-1)?.complete) throw new Error('noise_prior_close_missing');
      const len = (current.close - current.open) / 60000, marks = [];
      for (let t = STEP; t <= len - STEP; t += STEP) {
        const seen = days.filter(Boolean).map(d => d.moves.get(t)).filter(Number.isFinite);
        if (seen.length >= MIN_SAMPLES) marks.push({ t, ts: current.open + t * 60000, sigma: seen.reduce((a, x) => a + x, 0) / seen.length, done: null });
      }
      this.state = { date: today, open: current.open, close: current.close, prevClose: days.at(-1).close, dayOpen: null, bars: new Map(), marks };
      // A restart during the session restores today's minute bars, so the open and VWAP stay exact.
      if (now - current.open >= 60000) for (const b of (await this.history.bars([this.symbol], current.open, Math.floor(now / 60000) * 60000)).get(this.symbol)) this.addBar(b);
      // Marks that passed before the context existed are never traded late.
      for (const m of marks) if (now - m.ts > 90000) m.done = 'missed_before_start';
      this.reason = 'ready';
      e.store.event('noise_area_context', { symbol: this.symbol, date: today, prevClose: this.state.prevClose, dayOpen: this.state.dayOpen, marks: marks.length, lookback: days.filter(Boolean).length, earlyClose: len < 390 }, e.clock());
    } catch (error) {
      this.retryAt = now + 60000; this.reason = /^(noise|stock_history)_\w+$/.test(error?.message) ? error.message : 'noise_context_unavailable';
      e.store.event('noise_area_context', { symbol: this.symbol, reason: this.reason, note: 'Retrying in 60s; no decisions without a complete band.' }, e.clock());
    } finally { this.busy = false; }
  }
  addBar(b) {
    const s = this.state;
    if (!s || b.symbol !== this.symbol || b.ts < s.open || b.ts >= s.close || s.bars.has(b.ts)) return;
    s.bars.set(b.ts, b);
    if (b.ts === s.open) s.dayOpen = b.open;
  }
  onBar(b) {
    this.addBar(b);
    return this.evaluate(this.engine.clock()).catch(() => this.engine.fail('noise_area_failure'));
  }
  // The decision at mark T uses the minute bar ending at T (last trade before T) and VWAP of bars before T.
  async evaluate(now) {
    const e = this.engine, s = this.state;
    if (!e.strategyControls.enabled(NOISE_STRATEGY) && e.managed[this.symbol]?.strategy !== NOISE_STRATEGY) return;
    if (!s || this.deciding || s.date !== nyDate(now)) return;
    this.deciding = true;
    try {
      for (const mark of s.marks) {
        if (mark.done) continue;
        if (now < mark.ts) break;
        // Re-enabling waits for a new decision mark; held positions still receive exits.
        if (e.managed[this.symbol]?.strategy !== NOISE_STRATEGY && mark.ts < e.strategyControls.state.strategies[NOISE_STRATEGY].changedAt) { mark.done = 'before_enable'; continue; }
        const before = [...s.bars.values()].filter(b => b.ts < mark.ts), latest = before.reduce((x, b) => !x || b.ts > x.ts ? b : x, null);
        if (latest?.ts !== mark.ts - 60000 && now - mark.ts < 20000) break; // Wait briefly for the closing minute bar.
        if (now - mark.ts > 90000) { mark.done = 'missed'; this.record(mark, { action: 'missed' }); continue; }
        if (!latest || mark.ts - latest.ts > 5 * 60000 || s.dayOpen === null) { mark.done = 'no_data'; this.record(mark, { action: 'no_data' }); continue; }
        const volume = before.reduce((a, b) => a + b.volume, 0);
        const vwap = volume > 0 ? before.reduce((a, b) => a + (b.vwap ?? (b.high + b.low + b.close) / 3) * b.volume, 0) / volume : latest.close;
        const price = latest.close, ub = Math.max(s.dayOpen, s.prevClose) * (1 + mark.sigma), lb = Math.min(s.dayOpen, s.prevClose) * (1 - mark.sigma);
        const owned = e.managed[this.symbol], held = owned?.strategy === NOISE_STRATEGY && !owned.exitReason;
        const pendingEntry = e.pending().some(o => o.symbol === this.symbol && o.kind === 'entry');
        let action = 'hold_flat';
        if (held) {
          action = 'hold_long';
          if (price < Math.max(ub, vwap)) {
            await e.mutex.run(() => { const m = e.managed[this.symbol]; if (m?.strategy === NOISE_STRATEGY && !m.exitReason) { m.exitReason = 'noise_trailing_stop'; e.store.set('managed', e.managed); } });
            e.scheduleReconcile(); action = 'exit_long';
          }
        } else if (owned || pendingEntry) action = 'symbol_busy';
        else if (!e.strategyControls.enabled(NOISE_STRATEGY)) action = 'strategy_disabled';
        else if (price > ub) action = 'enter_long';
        else if (price < lb) action = 'short_signal_not_traded';
        mark.done = action;
        const context = { price, ub, lb, vwap, sigma: mark.sigma, dayOpen: s.dayOpen, prevClose: s.prevClose, mark: mark.t };
        this.record(mark, { action, ...context });
        e.observability.evaluation({ symbol: this.symbol, strategy: NOISE_STRATEGY, ts: now, matched: action === 'enter_long', passed: [price > ub, price >= Math.max(ub, vwap), price >= lb].filter(Boolean).length, reason: action, checks: [
          { name: 'Price above upper noise band', actual: price, operator: '>', target: ub, unit: 'USD', pass: price > ub },
          { name: 'Price at or above exit line max(upper band, VWAP)', actual: price, operator: '>=', target: Math.max(ub, vwap), unit: 'USD', pass: price >= Math.max(ub, vwap) },
          { name: 'Price at or above lower band (short side not traded)', actual: price, operator: '>=', target: lb, unit: 'USD', pass: price >= lb },
        ] });
        if (action === 'enter_long') await e.submitCandidate({ id: idFor('c', [NOISE_STRATEGY, VERSION, this.symbol, s.date, mark.t]), strategy: NOISE_STRATEGY, version: VERSION,
          symbol: this.symbol, ts: now, expires: now + 10000, reference: price, stop: price * (1 - e.cfg.noiseStopBps / 10000), target: price * (1 + TARGET),
          maxHold: s.close - now + 600000, priority: 1, sizing: { notional: e.cfg.noiseNotional }, features: { version: latest.ts, noise: context }, status: 'discovered' });
      }
    } finally { this.deciding = false; }
  }
  record(mark, data) {
    this.lastDecision = { date: this.state.date, ts: mark.ts, ...data };
    this.engine.store.event('noise_area_decision', { symbol: this.symbol, date: this.state.date, markTs: mark.ts, ...data }, this.engine.clock());
  }
  status() {
    const s = this.state;
    return { strategy: NOISE_STRATEGY, enabled: this.engine.strategyControls.enabled(NOISE_STRATEGY), symbol: this.symbol, side: 'long_only', reason: this.reason, date: s?.date ?? null, prevClose: s?.prevClose ?? null, dayOpen: s?.dayOpen ?? null,
      nextMarkTs: s?.marks.find(m => !m.done)?.ts ?? null, decided: s?.marks.filter(m => m.done).length ?? 0, marks: s?.marks.length ?? 0, lastDecision: this.lastDecision };
  }
}
