import { readFileSync, writeFileSync } from 'node:fs';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { SimBroker } from '../src/broker.js';
import { STRATEGIES, evaluate } from '../src/strategies.js';
import { buildReport } from './research.js';

const args = process.argv.slice(2), input = args[0], output = args[1] ?? 'replay-report.json', modelFile = args[2];
if (!input) { console.error('Usage: node scripts/replay.js events.jsonl report.json [recorded-candidates.json]'); process.exit(1); }
const events = readFileSync(input, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(x => JSON.parse(x));
if (!events.length || events.some((x, i) => !Number.isFinite(x.now) || (i && x.now < events[i - 1].now))) throw new Error('Replay events must have monotonic numeric now timestamps');
const symbols = [...new Set(events.map(e => e.symbol))];
const cfg = config({ ...process.env, MODE: 'demo', JEV_MODE: 'off', DASHBOARD_TOKEN: 'replay-local-only-0000000000000000000000', EQUITY_SYMBOLS: symbols.filter(s => !s.includes('/')).join(','), CRYPTO_SYMBOLS: symbols.filter(s => s.includes('/')).join(',') });
let now = events[0].now; const store = new Store(), broker = new SimBroker(cfg, store);
const workers = { status: () => cfg.strategies.map(strategy => ({ strategy, alive: true })), evaluate: async (f, t, selected = cfg.strategies) => selected.map(s => evaluate(s, f, t)).filter(Boolean) };
const engine = new Engine(cfg, store, broker, workers, () => now);
if (modelFile) {
  const rows = JSON.parse(readFileSync(modelFile, 'utf8')), answers = new Map(rows.map(c => [c.id, c.model]));
  cfg.jevMode = 'filter';
  engine.jev.evaluate = async c => answers.get(c.id) ?? { pass: false, error: 'missing_recorded_model_result' };
}
await engine.init();
for (const event of events) {
  now = event.now;
  if (event.kind === 'quote') { await engine.onQuote(event); await engine.reconcile(); }
  else if (event.kind === 'bar') { await engine.reconcile(); await engine.onBar(event); }
  else throw new Error(`Unsupported replay event kind ${event.kind}`);
}
await engine.reconcile();
const report = buildReport(store, cfg);
report.replay = { events: events.length, start: events[0].now, end: now, modelFilter: !!modelFile, limitations: ['Only supplied events are observable. Sparse quotes can expire orders and miss intrabar paths.', 'Simulation has no queue or market impact model. Historical stock sessions must already be filtered in the input.', 'Open positions remain marked and are not silently closed at the end.'] };
writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output, candidates: report.candidateCount, orders: report.orderCount, closedTrades: report.closedTradeCount, openPositions: report.openPositions.length })); store.close();
