import { idFor, positive } from './util.js';

export const STRATEGIES = ['range_breakout', 'trend_pullback', 'failed_breakout', 'vwap_reversion', 'volatility_expansion', 'order_flow_continuation'];
export const BAR_STRATEGIES = STRATEGIES.filter(s => s !== 'order_flow_continuation');
export const STRATEGY_VERSION = '1.0.0';

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
  if (strategy === 'range_breakout') { upward(); check('Close clears prior range high', b.close, '>', f.rangeHigh, 'USD'); check('Relative volume', f.relativeVolume, '>=', 1.25, 'x'); check('Close above VWAP', b.close, '>', f.rollingVwap, 'USD'); }
  if (strategy === 'trend_pullback') { upward(); check('Previous low touched fast EMA', f.previous.low, '<=', f.previousEma9, 'USD'); check('Close recovered fast EMA', b.close, '>', f.ema9, 'USD'); check('Close improved', b.close, '>', f.previous.close, 'USD'); check('Relative volume', f.relativeVolume, '>=', .8, 'x'); }
  if (strategy === 'failed_breakout') { check('Low swept prior range', b.low, '<', f.rangeLow, 'USD'); check('Close reclaimed range', b.close, '>', f.rangeLow, 'USD'); check('Green candle', b.close, '>', b.open, 'USD'); check('Relative volume', f.relativeVolume, '>=', 1.1, 'x'); check('15m trend floor', f.trend15, '>', -.005); }
  if (strategy === 'vwap_reversion') { check('Range regime', f.regime, '=', 'range'); check('VWAP deviation', f.vwapZ, '<', -1.5); check('Close improved', b.close, '>', f.previous.close, 'USD'); check('Green candle', b.close, '>', b.open, 'USD'); check('15m trend floor', f.trend15, '>', -.005); }
  if (strategy === 'volatility_expansion') { check('Prior compression', f.priorCompression, '<', .8); check('Volatility expansion', f.volatilityRatio, '>', 1.2); check('Volatility below shock', f.volatilityRatio, '<', 2.5); check('Close clears prior range high', b.close, '>', f.rangeHigh, 'USD'); check('Relative volume', f.relativeVolume, '>=', 1.5, 'x'); check('15m trend nonnegative', f.trend15, '>=', 0); }
  if (strategy === 'order_flow_continuation') {
    const m = f.micro;
    check('Microstructure available', !!m, '=', true); check('Quote context age', m ? now - m.ts : null, '<=', 1000, 'ms');
    check('Quote observations', m?.observations, '>=', 20); check('Observation span', m?.spanMs, '>=', 1000, 'ms');
    check('Bid-depth imbalance', m?.imbalance, '>', .3); check('Normalized order flow', m?.normalizedOfi, '>', 1);
    check('Microprice skew', m?.micropriceSkewBps, '>', .1, 'bps'); check('Short-term return', m?.returnBps, '>', 0, 'bps'); upward(); check('No shock regime', f.regime !== 'shock', '=', true);
  }
  const qualifies = STRATEGIES.includes(strategy) && checks.every(c => c.pass);
  const assessment = { symbol: f.symbol, strategy, ts: now, matched: qualifies, passed: checks.filter(c => c.pass).length,
    checks, reason: qualifies ? 'Setup conditions met' : checks.find(c => !c.pass)?.name ?? 'Unknown strategy' };
  if (!qualifies) return { candidate: null, assessment };
  const reference = strategy === 'order_flow_continuation' ? f.micro.mid : b.close;
  const distance = Math.max(f.atr * 1.5, reference * .003);
  const candidate = {
    id: idFor('c', [strategy, STRATEGY_VERSION, f.symbol, f.version]), strategy, version: STRATEGY_VERSION,
    symbol: f.symbol, ts: now, expires: now + (strategy === 'order_flow_continuation' ? 2000 : 10000), reference,
    stop: reference - distance, target: strategy === 'vwap_reversion' ? f.rollingVwap : reference + 2 * distance,
    maxHold: strategy === 'order_flow_continuation' ? 180000 : null,
    priority: Math.min(f.relativeVolume, 5), features: f, status: 'discovered',
  };
  return { candidate, assessment: { ...assessment, candidateId: candidate.id } };
}

export function evaluate(strategy, features, now) { return assess(strategy, features, now).candidate; }
