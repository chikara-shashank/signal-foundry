import { nyDate, nyTimestamp } from './util.js';
import { optionContext, daysToExpiry, OPTIONS_POLICY } from './options-strategies.js';
import { sharedBrokerBudget } from './broker-budget.js';

const PAPER = 'https://paper-api.alpaca.markets', DATA = 'https://data.alpaca.markets';
const DAY = 86400000;
export const normalizeOption = c => ({ symbol: c.symbol, underlying: c.underlying_symbol, root: c.root_symbol, expiry: c.expiration_date,
  type: c.type, style: c.style, status: c.status, tradable: c.tradable, strike: Number(c.strike_price), multiplier: Number(c.multiplier),
  size: Number(c.size), openInterest: c.open_interest == null ? null : Number(c.open_interest), oiDate: c.open_interest_date,
  deliverables: c.deliverables });
export const normalizeOptionQuote = x => ({ bid: x.latestQuote?.bp, ask: x.latestQuote?.ap, bidSize: x.latestQuote?.bs, askSize: x.latestQuote?.as,
  condition: x.latestQuote?.c, ts: Date.parse(x.latestQuote?.t), delta: x.greeks?.delta ?? null, iv: x.impliedVolatility ?? null });
export const normalizeStockEligibility = (a, at, symbol) => ({ at, status: a.symbol === symbol ? a.status : null,
  tradable: a.tradable === true, shortable: a.shortable === true,
  easyToBorrow: a.borrow_status == null ? a.easy_to_borrow === true : a.borrow_status === 'easy_to_borrow' });

// This adapter has no order/exercise/account mutation endpoint or method.
export class OptionsData {
  constructor({ key, secret, fetchFn = fetch, now = Date.now, canRead = () => true }) {
    if (!key || !secret) throw new Error('options_credentials_required');
    this.headers = { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret };
    this.fetch = fetchFn; this.localNow = now; this.canRead=canRead; this.offset = 0; this.cache = new Map(); this.assetCache = new Map();
    this.budget = sharedBrokerBudget({ key, brokerUrl: PAPER }, fetchFn);
  }
  async get(host, path, params = {}) {
    if(!this.canRead())throw new Error('options_data_scheduled_off');
    const approved = host === PAPER ? /^\/v2\/(clock|calendar|options\/contracts|assets\/(SPY|QQQ))$/.test(path)
      : host === DATA && /^\/(v2\/stocks\/(SPY|QQQ)\/bars|v2\/stocks\/quotes\/latest|v1beta1\/options\/snapshots)$/.test(path);
    if (!approved) throw new Error('options_read_only_endpoint');
    if (host === PAPER) this.budget.reserve('GET', 'background');
    const response = await this.fetch(host + path + '?' + new URLSearchParams(params), {
      method: 'GET', headers: this.headers, redirect: 'error', signal: AbortSignal.timeout(7000),
    });
    if (response.status === 429 && host === PAPER) this.budget.backoff(response.headers?.get('retry-after'));
    if (!response.ok) throw new Error(`options_data_http_${response.status}`);
    return response.json();
  }
  async capture(universe = ['SPY'], watched = []) {
    if (!universe.length || universe.length > 2 || new Set(universe).size !== universe.length || universe.some(s => !['SPY', 'QQQ'].includes(s))) throw new Error('options_universe');
    const started = this.localNow(), clock = await this.get(PAPER, '/v2/clock'), received = this.localNow(), provider = Date.parse(clock.timestamp);
    if (!Number.isFinite(provider) || received < started || received - started > 2000 || Math.abs(provider - received) > 300000) throw new Error('options_clock_uncertain');
    this.offset = provider - (started + received) / 2;
    const now = () => this.localNow() + this.offset, date = nyDate(now());
    const frame = { schema: 1, source: 'alpaca_opra', stockFeed: 'sip', sampled: true, clockUncertaintyMs: (received - started) / 2,
      now: now(), universe, marketOpen: clock.is_open === true, session: null, contexts: {}, spots: {}, assets: {}, contracts: {}, quotes: {} };
    if (!frame.marketOpen) return frame;
    const calendar = await this.get(PAPER, '/v2/calendar', { start: new Date(provider - 130 * DAY).toISOString().slice(0, 10), end: date });
    const day = calendar.find?.(x => x.date === date);
    if (!day) throw new Error('options_session_missing');
    frame.session = { date, open: nyTimestamp(date, day.open), close: nyTimestamp(date, day.close) };
    const spots = await this.get(DATA, '/v2/stocks/quotes/latest', { symbols: universe.join(','), feed: 'sip' });
    for (const symbol of universe) {
      let asset = this.assetCache.get(symbol);
      if (!asset || now() - asset.at > (asset.error ? 60000 : 900000)) {
        try {
          const a = await this.get(PAPER, `/v2/assets/${symbol}`);
          asset = normalizeStockEligibility(a, now(), symbol);
        } catch { asset = { at: now(), error: 'asset_eligibility_unavailable' }; }
        this.assetCache.set(symbol, asset);
      }
      frame.assets[symbol] = asset;
      const stock = spots.quotes?.[symbol];
      if (!(stock?.bp > 0 && stock.ap >= stock.bp)) throw new Error('options_underlying_quote');
      const price = (stock.bp + stock.ap) / 2;
      let cached = this.cache.get(symbol);
      if (!cached || cached.date !== date || now() - cached.ts > 900000 || price < cached.low + 5 || price > cached.high - 5) {
        const daily = await this.get(DATA, `/v2/stocks/${symbol}/bars`, { timeframe: '1Day', feed: 'sip', adjustment: 'all', sort: 'asc', limit: '10000',
          start: new Date(provider - 130 * DAY).toISOString(), end: new Date(nyTimestamp(date, '00:00') - 1).toISOString() });
        if (daily.next_page_token || !Array.isArray(daily.bars)) throw new Error('options_daily_incomplete');
        const expected = calendar.filter(x => x.date < date).slice(-50).map(x => x.date);
        const actual = new Set(daily.bars.map(b => nyDate(Date.parse(b.t))));
        if (expected.length !== 50 || expected.some(date => !actual.has(date))) throw new Error('options_daily_session_gap');
        const low = Math.floor(price * .94), high = Math.ceil(price * 1.06), contracts = []; let token;
        for (let page = 0; page < 3; page++) {
          const batch = await this.get(PAPER, '/v2/options/contracts', { underlying_symbols: symbol, status: 'active', show_deliverables: 'true',
            expiration_date_gte: new Date(provider + 7 * DAY).toISOString().slice(0, 10), expiration_date_lte: new Date(provider + 45 * DAY).toISOString().slice(0, 10),
            strike_price_gte: String(low), strike_price_lte: String(high), limit: '10000', ...(token ? { page_token: token } : {}) });
          if (!Array.isArray(batch.option_contracts)) throw new Error('options_catalog_invalid');
          contracts.push(...batch.option_contracts.map(normalizeOption)); token = batch.next_page_token;
          if (!token) break;
        }
        if (token) throw new Error('options_catalog_incomplete');
        const expirations = [...new Set(contracts.map(c => c.expiry))];
        const choose = (target, min, max) => expirations.filter(d => daysToExpiry(d, provider) >= min && daysToExpiry(d, provider) <= max)
          .sort((a, b) => Math.abs(daysToExpiry(a, provider) - target) - Math.abs(daysToExpiry(b, provider) - target) || a.localeCompare(b))[0];
        const selected = new Set([choose(14, 7, 21), choose(30, 21, 45)]);
        cached = { date, ts: now(), low, high, daily: daily.bars, contracts: contracts.filter(c => selected.has(c.expiry)) };
        this.cache.set(symbol, cached);
      }
      const end = Math.floor(now() / 300000) * 300000;
      const intraday = end > frame.session.open ? await this.get(DATA, `/v2/stocks/${symbol}/bars`, {
        timeframe: '5Min', feed: 'sip', adjustment: 'raw', sort: 'asc', limit: '10000', start: new Date(frame.session.open).toISOString(), end: new Date(end - 1).toISOString(),
      }) : { bars: [] };
      if (intraday.next_page_token || !Array.isArray(intraday.bars)) throw new Error('options_intraday_incomplete');
      frame.contexts[symbol] = optionContext(cached.daily, intraday.bars, frame.session, now());
      for (const c of cached.contracts) frame.contracts[c.symbol] = c;
    }
    // Retain and re-quote owned shadow legs even if they leave the scanner's strike/date window.
    for (const c of watched) {
      if (!universe.includes(c.underlying) || !/^(SPY|QQQ)\d{6}[CP]\d{8}$/.test(c.symbol)) throw new Error('options_watched_contract');
      frame.contracts[c.symbol] = c;
    }
    const symbols = Object.keys(frame.contracts);
    if (symbols.length > 1200) throw new Error('options_chain_too_large');
    // Bounded batches. Receipt time is taken after every response, never before it.
    for (let i = 0; i < symbols.length; i += 100) {
      const batch = await this.get(DATA, '/v1beta1/options/snapshots', { symbols: symbols.slice(i, i + 100).join(','), feed: 'opra', limit: '1000' });
      if (batch.next_page_token || !batch.snapshots || typeof batch.snapshots !== 'object') throw new Error('options_snapshots_incomplete');
      for (const [symbol, snapshot] of Object.entries(batch.snapshots)) {
        if (!frame.contracts[symbol]) throw new Error('options_unrequested_contract');
        frame.quotes[symbol] = normalizeOptionQuote(snapshot);
      }
    }
    const freshSpots = await this.get(DATA, '/v2/stocks/quotes/latest', { symbols: universe.join(','), feed: 'sip' });
    for (const symbol of universe) {
      const q = freshSpots.quotes?.[symbol];
      frame.spots[symbol] = { price: q?.bp > 0 && q.ap >= q.bp ? (q.bp + q.ap) / 2 : null,
        bid: q?.bp, ask: q?.ap, bidSize: q?.bs, askSize: q?.as, ts: Date.parse(q?.t) };
    }
    frame.now = now();
    if (frame.now - provider > OPTIONS_POLICY.pollMs) throw new Error('options_capture_too_slow');
    return frame;
  }
}
