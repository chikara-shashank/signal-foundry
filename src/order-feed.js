import { AlpacaFeed } from './feeds.js';
import { canonical } from './util.js';

const EVENTS = new Set(['new', 'accepted', 'fill', 'partial_fill', 'canceled', 'expired', 'rejected', 'done_for_day', 'replaced', 'pending_new', 'pending_cancel', 'pending_replace', 'stopped', 'calculated', 'suspended', 'order_replace_rejected', 'order_cancel_rejected']);
export function orderObservation(data) {
  if (!EVENTS.has(data?.event) || !data.order || typeof data.order.client_order_id !== 'string') return null;
  const o = data.order, id = o.client_order_id.slice(0, 128);
  return { orderId: id, symbol: typeof o.symbol === 'string' && o.symbol ? canonical(o.symbol).slice(0, 40) : undefined,
    kind: 'broker notification', status: data.event, side: ['buy', 'sell'].includes(o.side) ? o.side : undefined,
    qty: Number.isFinite(Number(o.filled_qty)) ? Number(o.filled_qty) : null,
    price: Number.isFinite(Number(o.filled_avg_price)) ? Number(o.filled_avg_price) : null,
    providerTs: Number.isFinite(Date.parse(data.timestamp)) ? Date.parse(data.timestamp) : null,
    note: 'Broker stream notification; may concern an external order. Account state and chart fills require coordinator reconciliation.' };
}

export class AlpacaOrderFeed extends AlpacaFeed {
  constructor(cfg, engine, Socket = WebSocket) {
    super('orders', cfg.brokerUrl.replace('https:', 'wss:') + '/stream', [], cfg, engine, Socket);
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = this.socket = new this.Socket(this.url); ws.binaryType = 'arraybuffer';
      let settled = false, authenticated = false;
      this.engine.feeds.orders = { status: 'connecting' };
      const fail = reason => { if (settled) return; settled = true; clearTimeout(this.timer); ws.close(); this.engine.feeds.orders = { status: reason, lastError: reason }; reject(new Error(reason)); };
      this.timer = setTimeout(() => fail('authentication_timeout'), 15000);
      ws.addEventListener('open', () => ws.send(JSON.stringify({ action: 'auth', key: this.cfg.key, secret: this.cfg.secret })));
      ws.addEventListener('message', event => {
        try {
          const text = typeof event.data === 'string' ? event.data : event.data instanceof ArrayBuffer ? Buffer.from(event.data).toString('utf8') : '';
          if (!text || text.length > 1000000) return fail('invalid_order_frame');
          const x = JSON.parse(text);
          if (x.stream === 'authorization') {
            if (x.data?.status !== 'authorized') return fail('order_stream_unauthorized');
            authenticated = true; ws.send(JSON.stringify({ action: 'listen', data: { streams: ['trade_updates'] } }));
          }
          if (authenticated && x.stream === 'listening') {
            if (!x.data?.streams?.includes('trade_updates')) return fail('incomplete_order_subscription');
            clearTimeout(this.timer); this.engine.feeds.orders = { status: 'streaming', lastMessage: Date.now() };
          }
          if (x.action === 'error') return fail('order_stream_error');
          if (authenticated && x.stream === 'trade_updates') {
            const update = orderObservation(x.data); if (!update) return;
            this.engine.feeds.orders = { status: 'streaming', lastMessage: Date.now() }; this.engine.onBrokerUpdate(update);
          }
        } catch { fail('order_stream_parse_error'); }
      });
      ws.addEventListener('error', () => fail('connection_error'));
      ws.addEventListener('close', () => { if (!settled) { settled = true; clearTimeout(this.timer); resolve(); } });
    });
  }
}
