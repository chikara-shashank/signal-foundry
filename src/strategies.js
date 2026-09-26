import { idFor, isCrypto } from './util.js';

import { WORKER_STRATEGIES } from './strategy-registry.js';
import { SETUPS } from './strategy-setups.js';
export { BAR_STRATEGIES, SESSION_STRATEGIES } from './strategy-registry.js';
export const STRATEGIES = WORKER_STRATEGIES;
export const STRATEGY_VERSION = '1.2.0';

export function assess(strategy, f, now) {
  const b = f.bar, checks = [];
  const check = (name, actual, operator, target, unit = '') => {
    const present = actual !== null && actual !== undefined && (typeof actual !== 'number' || Number.isFinite(actual));
    const pass = present && ({ '>': () => actual > target, '>=': () => actual >= target, '<': () => actual < target,
      '<=': () => actual <= target, '=': () => actual === target, '!=': () => actual !== target })[operator]();
    checks.push({ name, actual: present ? actual : null, operator, target: target ?? null, unit, pass });
  };
  check('ATR available', f.atr, '>', 0);
  check('5m context available', f.trend5 != null, '=', true);
  check('15m context available', f.trend15 != null, '=', true);
  check('Bar has volume', b.volume, '>', 0);
  const upward = () => { check('Fast EMA above slow EMA', f.ema9 - f.ema21, '>', 0); check('5m trend rising', f.trend5, '>', 0); check('15m trend nonnegative', f.trend15, '>=', 0); };
  SETUPS[strategy]?.({ f, b, check, upward, now });
  const qualifies = STRATEGIES.includes(strategy) && typeof SETUPS[strategy] === 'function' && checks.every(c => c.pass);
  const assessment = { symbol: f.symbol, strategy, ts: now, matched: qualifies, passed: checks.filter(c => c.pass).length,
    checks, reason: qualifies ? 'Setup conditions met' : checks.find(c => !c.pass)?.name ?? 'Unknown strategy' };
  if (!qualifies) return { candidate: null, assessment };
  const reference = strategy === 'order_flow_continuation' ? f.micro.mid : b.close;
  // Crypto uses observed five-minute volatility, not a target inflated to pass fees.
  const distance = isCrypto(f.symbol) ? f.atr * 1.5 : Math.max(f.atr * 1.5, reference * .003);
  const candidate = {
    id: idFor('c', [strategy, STRATEGY_VERSION, f.symbol, f.version]), strategy, version: STRATEGY_VERSION,
    symbol: f.symbol, ts: now, expires: now + (strategy === 'order_flow_continuation' ? 2000 : 10000), reference,
    stop: reference - distance, target: strategy === 'vwap_reversion' ? f.rollingVwap : reference + 2 * distance,
    maxHold: strategy === 'order_flow_continuation' ? 180000 : f.maxHold ?? null,
    priority: Math.min(f.relativeVolume, 5), features: f, status: 'discovered',
  };
  return { candidate, assessment: { ...assessment, candidateId: candidate.id } };
}

export function evaluate(strategy, features, now) { return assess(strategy, features, now).candidate; }
