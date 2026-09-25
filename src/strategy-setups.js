import { isCrypto } from './util.js';

// Numerical setup rules. Portfolio, cost and execution checks remain in the engine.
export const SETUPS = Object.freeze({
  range_breakout({ f, b, check, upward, now }) { upward(); check('Close clears prior range high', b.close, '>', f.rangeHigh, 'USD'); check('Relative volume', f.relativeVolume, '>=', 1.25, 'x'); check('Close above VWAP', b.close, '>', f.rollingVwap, 'USD'); check('Breakout not overextended', b.close - f.rangeHigh, '<=', f.atr, 'USD'); check('Strong closing location', (b.close - b.low) / Math.max(b.high - b.low, 1e-8), '>=', .65); },
  trend_pullback({ f, b, check, upward, now }) { upward(); check('Previous low touched fast EMA', f.previous.low, '<=', f.previousEma9, 'USD'); check('Close recovered fast EMA', b.close, '>', f.ema9, 'USD'); check('Close improved', b.close, '>', f.previous.close, 'USD'); check('Relative volume', f.relativeVolume, '>=', .8, 'x'); },
  failed_breakout({ f, b, check, upward, now }) { check('Low swept prior range', b.low, '<', f.rangeLow, 'USD'); check('Close reclaimed range', b.close, '>', f.rangeLow, 'USD'); check('Green candle', b.close, '>', b.open, 'USD'); check('Relative volume', f.relativeVolume, '>=', 1.1, 'x'); check('15m trend floor', f.trend15, '>', -.005); check('Strong reclaim closing location', (b.close - b.low) / Math.max(b.high - b.low, 1e-8), '>=', .65); },
  vwap_reversion({ f, b, check, upward, now }) { check('Range regime', f.regime, '=', 'range'); check('VWAP deviation', f.vwapZ, '<', -1.5); check('Close improved', b.close, '>', f.previous.close, 'USD'); check('Green candle', b.close, '>', b.open, 'USD'); check('15m trend floor', f.trend15, '>', -.005); },
  volatility_expansion({ f, b, check, upward, now }) { check('Prior compression', f.priorCompression, '<', .8); check('Volatility expansion', f.volatilityRatio, '>', 1.2); check('Volatility below shock', f.volatilityRatio, '<', 2.5); check('Close clears prior range high', b.close, '>', f.rangeHigh, 'USD'); check('Relative volume', f.relativeVolume, '>=', 1.5, 'x'); check('15m trend nonnegative', f.trend15, '>=', 0); },
  order_flow_continuation({ f, b, check, upward, now }) {
    check('Equity microstructure profile', !isCrypto(f.symbol), '=', true);
    const m = f.micro;
    check('Microstructure available', !!m, '=', true); check('Quote context age', m ? now - m.ts : null, '<=', 1000, 'ms');
    check('Quote observations', m?.observations, '>=', 20); check('Observation span', m?.spanMs, '>=', 1000, 'ms');
    check('Bid-depth imbalance', m?.imbalance, '>', .3); check('Normalized order flow', m?.normalizedOfi, '>', 1);
    check('Microprice skew', m?.micropriceSkewBps, '>', .1, 'bps'); check('Short-term return', m?.returnBps, '>', 0, 'bps'); upward(); check('No shock regime', f.regime !== 'shock', '=', true);
  },
});
