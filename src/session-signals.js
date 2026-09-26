import { validBar } from './util.js';

// Pure, causal rules shared by production session handlers and research replay.
export function sessionContext(bars, open, mark) {
  const before = bars.filter(b => b.ts >= open && b.ts < mark).sort((a, b) => a.ts - b.ts);
  const count = (mark - open) / 60000;
  if (!Number.isInteger(count) || count < 1 || before.length !== count ||
      before.some((b, i) => !validBar(b) || b.ts !== open + i * 60000)) return null;
  const volume = before.reduce((sum, b) => sum + b.volume, 0);
  if (!(volume > 0)) return null;
  return { price: before.at(-1).close, dayOpen: before[0].open, latest: before.at(-1),
    vwap: before.reduce((sum, b) => sum + (b.high + b.low + b.close) / 3 * b.volume, 0) / volume };
}

export function noiseSignal({ price, vwap, dayOpen, prevClose, sigma }, held = false) {
  if (![price, vwap, dayOpen, prevClose].every(x => Number.isFinite(x) && x > 0) || !Number.isFinite(sigma) || sigma < 0) return null;
  const ub = Math.max(dayOpen, prevClose) * (1 + sigma), lb = Math.min(dayOpen, prevClose) * (1 - sigma);
  const exitLine = Math.max(ub, vwap);
  const action = held ? price < exitLine ? 'exit_long' : 'hold_long'
    : price > ub && price >= vwap ? 'enter_long' : price < lb ? 'short_signal_not_traded' : 'hold_flat';
  return { action, ub, lb, exitLine };
}

export function vwapSignal({ price, vwap }, held = false) {
  if (![price, vwap].every(x => Number.isFinite(x) && x > 0)) return null;
  return held ? price < vwap ? 'exit_long' : 'hold_long' : price > vwap ? 'enter_long' : 'hold_flat';
}
