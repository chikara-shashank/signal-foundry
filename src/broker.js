import { canonical, isCrypto, round, terminal } from './util.js';

export class BrokerError extends Error {
  constructor(status) { super(`broker_http_${status}`); this.status = status; }
}

export function normalizeOrder(o) {
  return { brokerId: o.id, id: o.client_order_id, symbol: canonical(o.symbol), status: String(o.status).toLowerCase(),
    ...(Number.isFinite(Date.parse(o.filled_at)) ? { filledAt: Date.parse(o.filled_at) } : {}),
    ...(Number.isFinite(Date.parse(o.submitted_at)) ? { submittedAt: Date.parse(o.submitted_at) } : {}),
    side: o.side, qty: Number(o.qty), filledQty: Number(o.filled_qty ?? 0), fillPrice: Number(o.filled_avg_price ?? 0),
    legs: (o.legs ?? []).map(normalizeOrder), type: o.type, orderClass: o.order_class ?? 'simple' };
}

export class AlpacaBroker {
  constructor(cfg, fetchFn = fetch, timebase = null) { this.cfg = cfg; this.fetch = fetchFn; this.timebase = timebase; }
  async request(path, method = 'GET', body) {
    const r = await this.fetch(`${this.cfg.brokerUrl}${path}`, { method, redirect: 'error',
      headers: { 'APCA-API-KEY-ID': this.cfg.key, 'APCA-API-SECRET-KEY': this.cfg.secret, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(7000) });
    if (!r.ok) throw new BrokerError(r.status);
    return r.status === 204 ? null : r.json();
  }
  async account(now) {
    const a = await this.request('/v2/account');
    return { id: a.id, equity: Number(a.equity), cash: Number(a.cash), buyingPower: Math.min(Number(a.cash), Number(a.non_marginable_buying_power ?? a.buying_power)),
      blocked: a.trading_blocked || a.account_blocked || a.trade_suspended_by_user || a.status !== 'ACTIVE', ts: now };
  }
  async clock(now) {
    const started = this.timebase?.mono();
    const x = await this.request('/v2/clock');
    this.timebase?.observe(x.timestamp, started);
    return { open: x.is_open, close: Date.parse(x.next_close), ts: this.timebase?.now() ?? now, providerTime: Date.parse(x.timestamp) };
  }
  async assets() {
    const classes = [...(this.cfg.equities.length ? ['us_equity'] : []), ...(this.cfg.crypto.length ? ['crypto'] : [])];
    const all = (await Promise.all(classes.map(c => this.request(`/v2/assets?status=active&asset_class=${c}`)))).flat();
    return new Map(all.map(a => [canonical(a.symbol), { tradable: a.tradable, min_order_size: Number(a.min_order_size ?? 1), min_trade_increment: Number(a.min_trade_increment ?? 1), price_increment: Number(a.price_increment ?? .01) }]));
  }
  async positions() {
    return (await this.request('/v2/positions')).map(p => ({ symbol: canonical(p.symbol), qty: Number(p.qty), availableQty: Number(p.qty_available ?? p.qty), entryPrice: Number(p.avg_entry_price), marketValue: Number(p.market_value), unrealized: Number(p.unrealized_pl) }));
  }
  async openOrders() { return (await this.request('/v2/orders?status=open&nested=true&limit=500')).map(normalizeOrder); }
  async find(id) {
    try {
      const o = await this.request(`/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(id)}`);
      return normalizeOrder(o.order_class === 'bracket' ? await this.request(`/v2/orders/${encodeURIComponent(o.id)}?nested=true`) : o);
    }
    catch (e) { if (e.status === 404) return null; throw e; }
  }
  async submit(intent) {
    const crypto = isCrypto(intent.symbol);
    const body = { symbol: intent.symbol, qty: String(intent.qty), side: intent.kind === 'entry' ? 'buy' : 'sell',
      type: intent.kind === 'entry' ? 'limit' : 'market', time_in_force: crypto ? 'gtc' : 'day', client_order_id: intent.id };
    if (intent.kind === 'entry') {
      body.limit_price = String(intent.limit);
      if (!crypto) Object.assign(body, { order_class: 'bracket', take_profit: { limit_price: String(intent.target) }, stop_loss: { stop_price: String(intent.stop) } });
    }
    return normalizeOrder(await this.request('/v2/orders', 'POST', body));
  }
  async cancel(order) { if (!order.brokerId) return; await this.request(`/v2/orders/${encodeURIComponent(order.brokerId)}`, 'DELETE'); }
}

// Conservative local simulator: orders only fill on a later quote, spread is paid,
// slippage/fees are charged, and no resting queue position is asserted.
export class SimBroker {
  constructor(cfg, store) {
    this.cfg = cfg; this.store = store; this.quotes = new Map();
    this.state = store.get('sim', { cash: cfg.capital, orders: {}, positions: {} });
  }
  save() { this.store.set('sim', this.state); }
  async account(now) {
    return { id: `local-${this.cfg.mode}`, equity: this.state.cash + Object.values(this.state.positions).reduce((s, p) => s + p.qty * (this.quotes.get(p.symbol)?.bid ?? p.entryPrice), 0), cash: this.state.cash, buyingPower: this.state.cash, blocked: false, ts: now };
  }
  async clock(now) { return { open: true, close: now + 86400000, ts: now }; }
  async assets() { return new Map(this.cfg.symbols.map(s => [s, { tradable: true, min_order_size: isCrypto(s) ? .0001 : 1, min_trade_increment: isCrypto(s) ? .00000001 : 1, price_increment: isCrypto(s) ? .01 : .01 }])); }
  async positions() { return Object.values(this.state.positions).map(p => ({ ...p, availableQty: p.qty, marketValue: p.qty * (this.quotes.get(p.symbol)?.bid ?? p.entryPrice), unrealized: p.qty * ((this.quotes.get(p.symbol)?.bid ?? p.entryPrice) - p.entryPrice) })); }
  async openOrders() { return Object.values(this.state.orders).filter(o => !terminal(o.status)); }
  async find(id) { return this.state.orders[id] ?? null; }
  async submit(o) {
    if (this.state.orders[o.id]) return this.state.orders[o.id];
    const result = { ...o, brokerId: o.id, side: o.kind === 'entry' ? 'buy' : 'sell', status: 'new', filledQty: 0, fillPrice: 0, legs: [] };
    this.state.orders[o.id] = result; this.save(); return result;
  }
  async cancel(o) { const x = this.state.orders[o.id]; if (x && !terminal(x.status)) { x.status = 'canceled'; this.save(); } }
  onQuote(q) {
    this.quotes.set(q.symbol, q);
    for (const o of Object.values(this.state.orders)) {
      if (o.symbol !== q.symbol || terminal(o.status) || q.ts <= o.ts) continue;
      if (o.kind === 'entry' && q.ts - o.ts >= this.cfg.entryTtl) { o.status = 'expired'; continue; }
      const entry = o.kind === 'entry', price = (entry ? q.ask : q.bid) * (1 + (entry ? 1 : -1) * this.cfg.slippage / 10000);
      if (entry && price > o.limit) continue;
      const feeRate = (isCrypto(o.symbol) ? this.cfg.cryptoFee : this.cfg.equityFee) / 10000;
      let qty = o.qty;
      if (entry && qty * price * (1 + feeRate) > this.state.cash) { o.status = 'rejected'; continue; }
      if (!entry) qty = Math.min(qty, this.state.positions[o.symbol]?.qty ?? 0);
      if (qty <= 0) { o.status = 'rejected'; continue; }
      const fee = qty * price * feeRate;
      this.state.cash = round(this.state.cash + (entry ? -1 : 1) * qty * price - fee);
      if (entry) this.state.positions[o.symbol] = { symbol: o.symbol, qty, entryPrice: price };
      else {
        this.state.positions[o.symbol].qty = round(this.state.positions[o.symbol].qty - qty);
        if (this.state.positions[o.symbol].qty < 1e-9) delete this.state.positions[o.symbol];
      }
      Object.assign(o, { status: 'filled', filledQty: qty, fillPrice: price, fee, filledAt: q.ts });
    }
    this.save();
  }
}
