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
// One closed round trip: bought 1 at $100, target leg sold at 100 + net, stop leg canceled.
export const closedTrade = (i, { strategy = 'range_breakout', symbol = 'SPY', net = 1, code = 'code-a', at = Date.parse('2026-09-22T14:00:00Z') + i * 60000, fee = 0 } = {}) => ({
  id: `e${i}`, brokerId: `e${i}`, symbol, kind: 'entry', strategy, qty: 1, filledQty: 1, fillPrice: 100, status: 'filled', ts: at, settledAt: at, feeRateBps: fee,
  experiment: { experimentId: `x-${code}`, codeHash: code },
  legs: [{ brokerId: `t${i}`, status: 'filled', filledQty: 1, fillPrice: 100 + net, type: 'limit', filledAt: at + 30000 },
    { brokerId: `s${i}`, status: 'canceled', filledQty: 0, type: 'stop' }] });
