import { isCrypto, nyDate, nyTimestamp } from './util.js';

export const NY_ZONE = 'America/New_York';
const DAY = 86400000;
export class MarketSchedule {
  constructor(engine, venue) {
    this.engine = engine; this.venue = venue; this.busy = false; this.retryAt = 0;
    this.cache = engine.store.get('marketCalendar', { rows: [], fetchedAt: 0, through: '' });
  }
  async poll() {
    const e = this.engine, now = e.clock(), date = nyDate(now);
    if (this.busy || e.stopped || now < this.retryAt || (now - this.cache.fetchedAt < 6 * 3600000 && this.cache.through > date)) return;
    this.busy = true; this.retryAt = now + 300000;
    try {
      const through = nyDate(now + 50 * DAY), rows = await this.venue.calendar(nyDate(now - 10 * DAY), through);
      if (!Array.isArray(rows) || !rows.length || rows.some(r => !/^\d{4}-\d\d-\d\d$/.test(r.date) || !Number.isFinite(r.open) || !Number.isFinite(r.close) || r.open >= r.close || nyDate(r.open) !== r.date || nyDate(r.close) !== r.date)) throw new Error('invalid_calendar');
      if (e.stopped) return;
      this.cache = { rows: [...rows].sort((a,b) => a.open - b.open), fetchedAt: now, through };
      e.store.set('marketCalendar', this.cache); this.error = null;
    } catch { this.error = 'Exchange calendar unavailable; equity entry and fast data stay off when the cache expires.'; }
    finally { this.busy = false; }
  }
  state(now = this.engine.clock()) {
    const date = nyDate(now), fresh = this.cache.fetchedAt > 0 && now >= this.cache.fetchedAt - 1000 && now - this.cache.fetchedAt < DAY && this.cache.through >= date;
    const today = fresh ? this.cache.rows.find(r => r.date === date) ?? null : null;
    const start = nyTimestamp(date, '09:00'), cutoff = nyTimestamp(date, '16:00');
    const equityTracking = !!today && now >= start && now < Math.min(cutoff, today.close);
    const regular = equityTracking && now >= today.open && now < today.close;
    const carryWindow = regular && today.close >= cutoff && now >= nyTimestamp(date, '15:30') && now < cutoff - 5 * 60000;
    const next = fresh ? this.cache.rows.find(r => r.open > now) ?? null : null;
    const last = fresh ? this.cache.rows.filter(r => r.close <= now).at(-1) ?? null : null;
    return { date, zone: NY_ZONE, calendarFresh: fresh, today, next, last, trackingClose:today?Math.min(cutoff,today.close):null, equityTracking, regular, carryWindow,
      phase: !fresh ? 'calendar_unavailable' : !today ? 'non_trading_day' : equityTracking ? regular ? carryWindow ? 'carry_entry_window' : 'regular_session' : 'premarket_warmup' : now < start ? 'before_tracking' : 'after_close_research',
      fetchedAt: this.cache.fetchedAt, error: this.error ?? null,
      note: 'Equity fast data: 09:00–16:00 New York time, shortened on exchange early closes. Regular-session entries only. Crypto and broker order updates remain 24/7; off-hours research uses slower reads.' };
  }
  holdingDeadline(now, sessions = 3) {
    if (!this.state(now).calendarFresh) return null;
    return this.cache.rows.filter(r => r.open > now)[sessions - 1]?.close - 5 * 60000 || null;
  }
  reconciliationInterval() {
    const e = this.engine;
    // Account and position endpoints are shared with crypto. Never suspend those
    // reads while crypto needs them, or while an order outcome is uncertain.
    return this.state().equityTracking || e.cfg.crypto.length || e.pending().some(o => !['filled','canceled','expired','rejected','aborted'].includes(o.status)) ? 5000 : 20000;
  }
  parentRefreshInterval(symbol) { return !isCrypto(symbol) && !this.state().equityTracking ? 300000 : 30000; }
}
