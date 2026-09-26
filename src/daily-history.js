import { nyDate, nyTimestamp, positive } from './util.js';
import { sharedBrokerBudget } from './broker-budget.js';

// Shared read-only source for monthly research and the paper handler. No broker writes.
export class DailyHistory {
  constructor({ key, secret, feed = 'sip', canRead = () => true }, fetchFn = fetch) { this.headers = { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret }; this.feed = feed; this.fetch = fetchFn; this.canRead = canRead; this.budget = sharedBrokerBudget({key,brokerUrl:'https://paper-api.alpaca.markets'}, fetchFn); }
  async get(host, path, params) {
    if (!this.canRead()) throw new Error('daily_history_scheduled_off');
    if (!((host === 'https://paper-api.alpaca.markets' && path === '/v2/calendar') || (host === 'https://data.alpaca.markets' && path === '/v2/stocks/bars'))) throw new Error('daily_history_read_only_endpoint');
    if (host === 'https://paper-api.alpaca.markets') this.budget.reserve('GET', 'background');
    const r = await this.fetch(host + path + '?' + new URLSearchParams(params), { headers: this.headers, method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (r.status === 429 && host === 'https://paper-api.alpaca.markets') this.budget.backoff(r.headers?.get('retry-after'));
    if (!r.ok) throw new Error('daily_history_http_' + r.status);
    return r.json();
  }
  async load(symbols, start, end, adjustment = 'all') {
    if (!symbols.length || symbols.some(s => !['SPY','QQQ','IWM'].includes(s)) || !['all','raw'].includes(adjustment) || !(start < end)) throw new Error('daily_history_request');
    const rawCalendar = await this.get('https://paper-api.alpaca.markets', '/v2/calendar', { start, end });
    if (!Array.isArray(rawCalendar)) throw new Error('daily_history_calendar');
    const calendar = rawCalendar.map(d => d.date).filter(d => d >= start && d < end).sort();
    if (!calendar.length || new Set(calendar).size !== calendar.length) throw new Error('daily_history_calendar');
    const bars = Object.fromEntries(symbols.map(s => [s, []])); let token;
    for (let page = 0; page < 30; page++) {
      const body = await this.get('https://data.alpaca.markets', '/v2/stocks/bars', { symbols: symbols.join(','), timeframe: '1Day', feed: this.feed, adjustment, sort: 'asc', limit: '10000',
        start: new Date(nyTimestamp(start, '00:00')).toISOString(), end: new Date(nyTimestamp(end, '00:00') - 1).toISOString(), ...(token ? { page_token: token } : {}) });
      for (const [symbol, rows] of Object.entries(body.bars ?? {})) {
        if (!bars[symbol] || !Array.isArray(rows)) throw new Error('daily_history_schema');
        for (const x of rows) {
          const b = { date: nyDate(Date.parse(x.t)), open: x.o, high: x.h, low: x.l, close: x.c, volume: x.v };
          if (![b.open,b.high,b.low,b.close].every(positive) || b.high < Math.max(b.open,b.close,b.low) || b.low > Math.min(b.open,b.close) || b.date < start || b.date >= end) throw new Error('daily_history_bar');
          bars[symbol].push(b);
        }
      }
      token = body.next_page_token; if (!token) break;
    }
    if (token) throw new Error('daily_history_truncated');
    for (const [symbol, rows] of Object.entries(bars)) if (rows.length !== calendar.length || rows.some((b,i) => b.date !== calendar[i])) {
      const seen = new Set(rows.map(b => b.date));
      throw new Error('daily_history_session_gap ' + JSON.stringify({symbol,expected:calendar.length,actual:rows.length,first:rows[0]?.date,last:rows.at(-1)?.date,missing:calendar.filter(d=>!seen.has(d)).slice(0,8),extra:rows.filter(b=>!calendar.includes(b.date)).map(b=>b.date).slice(0,8)}));
    }
    return { source: 'alpaca_' + this.feed, adjustment, start, end, calendar, bars };
  }
}
