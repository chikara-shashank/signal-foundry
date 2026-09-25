import { SETUPS } from './strategy-setups.js';

// Stable IDs own settings and fill history. New entries must opt in explicitly;
// defaultEnabled only seeds a database with no saved strategy settings.
export const STRATEGY_REGISTRY = Object.freeze([
  { id: 'range_breakout', name: 'Range breakout', trigger: 'bar', defaultEnabled: true,
    description: 'Volume-backed break above the prior range in an uptrend.' },
  { id: 'trend_pullback', name: 'Trend pullback', trigger: 'bar', defaultEnabled: true,
    description: 'Recovery from a pullback to the fast moving average.' },
  { id: 'failed_breakout', name: 'Failed breakout', trigger: 'bar', defaultEnabled: true,
    description: 'Reclaim of the prior range after a downside sweep.' },
  { id: 'vwap_reversion', name: 'VWAP reversion', trigger: 'bar', defaultEnabled: true,
    description: 'Recovery toward VWAP after a stretch lower in a range.' },
  { id: 'volatility_expansion', name: 'Volatility expansion', trigger: 'bar', defaultEnabled: true,
    description: 'A volume breakout after volatility compression.' },
  { id: 'order_flow_continuation', name: 'Order-flow continuation', trigger: 'quote', defaultEnabled: true,
    description: 'Equity momentum supported by fresh best-quote depth and flow.' },
  { id: 'noise_area', name: 'Noise-area breakout', trigger: 'session', defaultEnabled: false,
    description: 'Long-only session breakout with half-hour checks and a trailing exit.' },
  { id: 'close_strength_carry', name: 'Closing strength + news', trigger: 'session', defaultEnabled: false,
    description: 'Paper/shadow multi-session long entries at 15:30–15:55 ET; material favorable news, closing strength, GTC protection and a shared overnight allocation cap.' },
].map(entry => Object.freeze(entry)));

const byId = new Map(STRATEGY_REGISTRY.map(s => [s.id, s]));
if (byId.size !== STRATEGY_REGISTRY.length || STRATEGY_REGISTRY.some(s =>
  !/^[a-z][a-z0-9_]*$/.test(s.id) || !['bar', 'quote', 'session'].includes(s.trigger) ||
  (s.trigger !== 'session' && typeof SETUPS[s.id] !== 'function'))) throw new Error('Invalid strategy registry or missing setup evaluator');

export const strategyDefinition = id => byId.get(id);
export const DEFAULT_STRATEGIES = STRATEGY_REGISTRY.filter(s => s.defaultEnabled === true).map(s => s.id);
export const WORKER_STRATEGIES = STRATEGY_REGISTRY.filter(s => s.trigger !== 'session').map(s => s.id);
export const BAR_STRATEGIES = STRATEGY_REGISTRY.filter(s => s.trigger === 'bar').map(s => s.id);
export const QUOTE_STRATEGIES = STRATEGY_REGISTRY.filter(s => s.trigger === 'quote').map(s => s.id);
export const SESSION_STRATEGIES = STRATEGY_REGISTRY.filter(s => s.trigger === 'session').map(s => s.id);

export function noiseUnavailable(cfg) {
  if (cfg.mode === 'demo') return 'Requires provider sessions and history (shadow, paper or live mode).';
  if (cfg.universe?.mode!=='all' && !cfg.equities.includes(cfg.noiseSymbol)) return 'Add NOISE_AREA_SYMBOL to EQUITY_SYMBOLS before enabling.';
  if (cfg.noiseNotional > cfg.maxGroup || cfg.noiseNotional > cfg.maxGross) return 'Noise-area notional exceeds the group or gross exposure limit.';
  return null;
}
