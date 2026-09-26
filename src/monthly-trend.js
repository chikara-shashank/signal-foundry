import { hash, idFor, nyDate, positive, validateQuote } from './util.js';

export const MONTHLY_TREND = Object.freeze({ id: 'monthly_trend', version: '1.0.0', symbols: ['SPY', 'QQQ', 'IWM'], months: 10, sessions: 20, stopFraction: .02, targetFraction: .06 });
const monthNumber = month => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;

// Calendar completeness matters: a missing month-end bar cannot become a signal.
// asOf is the execution date; its entire current month is excluded.
export function monthlyTrendContext(daily, calendar, asOf, model = 'sma10') {
  if (!['sma10', 'momentum12'].includes(model)) throw new Error('monthly_trend_model');
  const month = asOf.slice(0, 7), count = model === 'sma10' ? 10 : 13, current = monthNumber(month);
  const dates = calendar.filter(d => d < asOf && monthNumber(d.slice(0, 7)) >= current - count && d.slice(0, 7) < month).sort();
  const bars = new Map();
  for (const b of daily.filter(b => b.date < asOf && b.date.slice(0, 7) < month)) {
    if (bars.has(b.date) || !positive(b.close)) return { reason: 'duplicate_or_invalid_daily_bar' };
    bars.set(b.date, b);
  }
  if (!dates.length || new Set(dates).size !== dates.length || dates.some(d => !bars.has(d))) return { reason: 'daily_session_gap' };
  const ends = new Map(); for (const date of dates) ends.set(date.slice(0, 7), bars.get(date));
  const rows = [...ends.values()];
  if (rows.length !== count || rows.some((r, i) => monthNumber(r.date.slice(0, 7)) !== current - count + i)) return { reason: 'monthly_history_incomplete' };
  const close = rows.at(-1).close, average = rows.slice(-10).reduce((n, b) => n + b.close, 0) / 10;
  const momentum = model === 'momentum12' ? close / rows[0].close - 1 : null;
  return { model, month, through: rows.at(-1).date, close, average, momentum, long: model === 'sma10' ? close > average : momentum > 0,
    fingerprint: hash(rows.map(b => [b.date, b.close])) };
}

export class MonthlyTrend {
  contexts = new Map(); busy = false; retryAt = 0; date = null;
  constructor(engine, data) { this.engine = engine; this.data = data; }
  verifiedCandidate(c, now) {
    const e = this.engine, context = this.contexts.get(c.symbol);
    return c.strategy === MONTHLY_TREND.id && MONTHLY_TREND.symbols.includes(c.symbol) && this.date === nyDate(now) && context?.long &&
      context.month === nyDate(now).slice(0, 7) && c.features?.trendFingerprint === context.fingerprint && c.holdingPolicy?.version === MONTHLY_TREND.version &&
      c.holdingPolicy.exitBy === e.schedule.holdingDeadline(c.ts, MONTHLY_TREND.sessions);
  }
  async onBar(b) {
    const e = this.engine, now = e.clock(), schedule = e.schedule?.state(now), id = MONTHLY_TREND.id;
    if (!MONTHLY_TREND.symbols.includes(b.symbol) || e.stopped || !['paper','shadow'].includes(e.cfg.mode) || !schedule?.carryWindow ||
        (!e.strategyControls.enabled(id) && !Object.values(e.managed).some(p => p.strategy === id)) || this.busy || now < this.retryAt) return;
    this.busy = true;
    try {
      const date = nyDate(now);
      if (this.date !== date) {
        const end = date.slice(0, 7) + '-01', start = new Date(Date.UTC(Number(date.slice(0,4)), Number(date.slice(5,7)) - 15, 1)).toISOString().slice(0,10);
        const history = await this.data.load(MONTHLY_TREND.symbols, start, end, 'all');
        this.contexts = new Map(MONTHLY_TREND.symbols.map(s => [s, monthlyTrendContext(history.bars[s], history.calendar, date)]));
        this.date = date;
      }
      const context = this.contexts.get(b.symbol), current = e.managed[b.symbol], held = current?.strategy === id;
      if (context?.reason || !context || e.stopped) return;
      if (held && !context.long) {
        await e.mutex.run(() => { const m = e.managed[b.symbol]; if (m?.strategy === id && !m.exitReason) { m.exitReason = 'monthly_trend_reversed'; e.store.set('managed', e.managed); } });
        e.scheduleReconcile(); return;
      }
      if (!context.long || current || !e.strategyControls.enabled(id) || e.pending().some(o => o.symbol === b.symbol)) return;
      // Includes canceled/closed entries, so a stop cannot trigger repeated same-month entries.
      if (e.store.orders().some(o => o.kind === 'entry' && o.strategy === id && o.symbol === b.symbol && nyDate(o.ts).slice(0,7) === context.month)) return;
      const q = e.quotes.get(b.symbol), at = e.clock(), exitBy = e.schedule.holdingDeadline(at, MONTHLY_TREND.sessions);
      if (!exitBy || !validateQuote(q, at, e.cfg.maxQuoteAge) || !e.schedule.state(at).carryWindow) return;
      const key = `monthlyTrendAttempt:${date}:${b.symbol}`;
      if (e.store.get(key)) return;
      e.store.set(key, true);
      e.observability.evaluation({ symbol: b.symbol, strategy: id, ts: at, matched: true, passed: 1, reason: 'prior_month_above_sma10',
        checks: [{ name: 'Completed monthly close above 10-month average', actual: context.close, operator: '>', target: context.average, unit: 'USD', pass: true }] });
      await e.submitCandidate({ id: idFor('c', [id, MONTHLY_TREND.version, b.symbol, date]), strategy: id, version: MONTHLY_TREND.version,
        symbol: b.symbol, ts: at, expires: at + 5000, reference: q.ask, stop: q.ask * (1 - MONTHLY_TREND.stopFraction), target: q.ask * (1 + MONTHLY_TREND.targetFraction), maxHold: exitBy - at,
        features: { version: b.ts, trendFingerprint: context.fingerprint }, holdingPolicy: { type: 'carry', version: MONTHLY_TREND.version, exitBy, sessions: MONTHLY_TREND.sessions, sourceMonth: context.through.slice(0,7) }, status: 'discovered' });
    } catch {
      this.retryAt = e.clock() + 300000;
      e.store.event('monthly_trend_context_unavailable', { reason: 'daily_history_or_calendar_unavailable' }, e.clock());
    } finally { this.busy = false; }
  }
}
