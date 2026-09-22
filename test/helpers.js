import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { SimBroker } from '../src/broker.js';
import { Engine } from '../src/engine.js';
import { STRATEGIES, evaluate } from '../src/strategies.js';

export const testConfig = overrides => config({ DASHBOARD_TOKEN: 'test-token-0000000000000000000000000000', EQUITY_SYMBOLS: 'SPY,QQQ', CRYPTO_SYMBOLS: '', ...overrides });
export const inlineWorkers = { status: () => STRATEGIES.map(strategy => ({ strategy, alive: true })), evaluate: async (f, now, selected = STRATEGIES) => selected.map(s => evaluate(s, f, now)).filter(Boolean) };
export const quote = (symbol, now, price = 100) => ({ symbol, ts: now, bid: price - .01, ask: price + .01 });
export function candidate(symbol, now, id = 'candidate-1') { return { id, symbol, ts: now, expires: now + 10000, reference: 100, stop: 98, target: 104, strategy: 'range_breakout', features: { version: now }, status: 'discovered' }; }
export async function fixture(overrides = {}) {
  let now = Date.parse('2026-09-22T15:00:00Z');
  const cfg = testConfig(overrides), store = new Store(), broker = new SimBroker(cfg, store), engine = new Engine(cfg, store, broker, inlineWorkers, () => now);
  await engine.init();
  return { cfg, store, broker, engine, now: () => now, advance: ms => { now += ms; }, prepare(symbol = 'SPY', id) {
    const c = candidate(symbol, now, id); engine.snapshots.set(symbol, c.features); engine.onQuote(quote(symbol, now)); store.candidate(c); return c;
  } };
}
