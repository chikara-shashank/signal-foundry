import { hash } from './util.js';

// One in-process budget per credential/host/transport. A separate process still
// requires the deployment's single-account-writer policy and its own headroom.
const transports = new WeakMap();
export class BrokerBudget {
  requests = []; blockedUntil = 0;
  constructor(now = Date.now) { this.now = now; }
  status() {
    const now = this.now(); this.requests = this.requests.filter(t => now - t < 60000);
    return { used: this.requests.length, limit: 180, entryThreshold: 120, backgroundThreshold: 90,
      protectionReadThreshold: 170, blockedUntil: this.blockedUntil, entryAvailable: this.requests.length < 120 && now >= this.blockedUntil };
  }
  reserve(method, priority = 'normal') {
    const s = this.status(), ceiling = priority === 'background' ? 90 : priority === 'protection' ? (method === 'GET' ? 170 : 180) : 120;
    if (this.now() < this.blockedUntil || s.used >= ceiling) throw Object.assign(new Error('broker_request_budget'), { notSent: true });
    this.requests.push(this.now());
  }
  backoff(raw) {
    const seconds = Number(raw), date = Date.parse(raw);
    const delay = raw && Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? date - this.now() : 60000;
    this.blockedUntil = this.now() + Math.min(120000, Math.max(1000, delay));
  }
}
export function sharedBrokerBudget(cfg, transport = fetch) {
  if (!cfg.key) return new BrokerBudget();
  if (!transports.has(transport)) transports.set(transport, new Map());
  const budgets = transports.get(transport), key = hash([cfg.brokerUrl ?? 'https://paper-api.alpaca.markets', cfg.key]);
  if (!budgets.has(key)) budgets.set(key, new BrokerBudget());
  return budgets.get(key);
}
