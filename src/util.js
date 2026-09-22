import { createHash } from 'node:crypto';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const finite = x => typeof x === 'number' && Number.isFinite(x);
export const positive = x => finite(x) && x > 0;
export const round = (x, n = 8) => Number(x.toFixed(n));
export const utc = t => new Date(t).toISOString();
export const nyDate = t => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
export const isCrypto = symbol => symbol.includes('/');
export const canonical = symbol => symbol === 'BTCUSD' ? 'BTC/USD' : symbol === 'ETHUSD' ? 'ETH/USD' : symbol;
export const terminal = status => ['filled', 'canceled', 'expired', 'rejected', 'aborted'].includes(status);
export const uncertain = status => ['submitting', 'unknown'].includes(status);
export const idFor = (kind, key) => `sf-${kind}-${hash(key).slice(0, 32)}`;

// Portfolio mutations share this queue. An error does not poison future work.
export class Mutex {
  tail = Promise.resolve();
  run(fn) {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
}

export function floorStep(value, increment) {
  if (!positive(value) || !positive(increment)) return 0;
  return round(Math.floor((value + increment * 1e-9) / increment) * increment);
}

export function validateQuote(q, now, maxAge) {
  return positive(q?.bid) && positive(q?.ask) && q.ask >= q.bid && finite(q.ts) &&
    now - q.ts <= maxAge && q.ts <= now + 1000;
}

export function validBar(b) {
  return b && typeof b.symbol === 'string' && finite(b.ts) && b.ts % 60000 === 0 &&
    [b.open, b.high, b.low, b.close].every(positive) && finite(b.volume) && b.volume >= 0 &&
    b.low <= Math.min(b.open, b.close) && b.high >= Math.max(b.open, b.close);
}
