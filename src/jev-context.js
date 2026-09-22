// Version the judgment rubric independently of numerical strategy thresholds.
export const JEV_RUBRIC = 'setup-context-2';
const setups = {
  range_breakout: 'Long continuation after closing above the previous range with volume support and aligned intraday trends.',
  trend_pullback: 'Long continuation after a pullback touches the fast EMA and price recovers within an upward intraday trend.',
  failed_breakout: 'Long reversal after price sweeps below a prior range low and closes back inside the range. A recent downward excursion is part of this setup.',
  vwap_reversion: 'Long mean reversion toward rolling VWAP after a negative deviation starts recovering in a range. A persistent upward trend is not required.',
  volatility_expansion: 'Long breakout as prior compression gives way to increased volatility and volume. Excessive shock volatility is excluded by code.',
  order_flow_continuation: 'Long continuation when recent best-quote size and price changes indicate buying pressure, supported by upward intraday context. This is a top-of-book proxy, not a full order book or queue-position model.',
};
const number = x => typeof x === 'number' && Number.isFinite(x);
const direction = x => !number(x) ? 'unknown' : x > 0 ? 'rising' : x < 0 ? 'falling' : 'flat';
const relative = (a, b) => !number(a) || !number(b) ? 'unknown' : a > b ? 'above' : a < b ? 'below' : 'equal';

export function setupContext(c, cfg = {}) {
  const f = c.features ?? {}, micro = c.strategy === 'order_flow_continuation';
  return {
    rubricVersion: JEV_RUBRIC,
    setup: setups[c.strategy] ?? 'Unrecognized setup; insufficient defined context for approval.',
    horizon: { sourceBarsMs: f.intervalMs ?? 60000, candidateLifetimeMs: number(c.expires) && number(c.ts) ? Math.max(0, c.expires - c.ts) : null,
      maximumHoldingMs: c.maxHold ?? cfg.maxHold ?? null, microContextMaximumAgeMs: micro ? 1000 : null },
    levels: { referenceUsd: number(c.reference) ? c.reference : null, stopUsd: number(c.stop) ? c.stop : null, targetUsd: number(c.target) ? c.target : null },
    // These are computed observations, not model-produced explanations or predictions.
    computedContext: { regimeHeuristic: ['trend', 'range', 'shock'].includes(f.regime) ? f.regime : 'unknown',
      trend5m: direction(f.trend5), trend15m: direction(f.trend15), fastEmaVersusSlow: relative(f.ema9, f.ema21),
      closeVersusVwap: relative(f.bar?.close, f.rollingVwap), closeVersusPrevious: relative(f.bar?.close, f.previous?.close),
      relativeVolume: !number(f.relativeVolume) ? 'unknown' : f.relativeVolume >= 1.5 ? 'at_least_1.5_times_baseline' : f.relativeVolume >= 1 ? 'at_or_above_baseline' : 'below_baseline',
      volatility: !number(f.volatilityRatio) ? 'unknown' : f.volatilityRatio >= 2.5 ? 'shock' : f.volatilityRatio > 1.2 ? 'expanded' : f.volatilityRatio < .8 ? 'compressed' : 'ordinary',
      microEvidence: micro ? 'best_quote_proxy_only' : 'not_required_for_this_setup' },
    interpretation: 'Use the setup definition and computed context for judgment. Numbers and timing are checked by code. Missing fields are unknown. Do not infer unseen liquidity, news, future prices or a probability of profit. Passing the numerical trigger does not establish predictive value.',
  };
}

export function requestWindow(c, cfg, now) {
  const micro = c.strategy === 'order_flow_continuation';
  if (!number(c.expires) || !number(now) || micro && !number(c.features?.micro?.ts)) return { timeoutMs: 0, deadline: null };
  const deadline = Math.min(c.expires, micro ? c.features.micro.ts + 1000 : Infinity);
  return { timeoutMs: Math.max(0, Math.floor(Math.min(cfg.jevTimeout, deadline - now))), deadline };
}
