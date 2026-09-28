// npm run scorecard [-- --db data/paper.sqlite] [--version latest|all|<codeHash>] [--json]
//
// The per-strategy scorecard behind the risk levels (docs/RISK-LEVELS.md). It
// opens the journal read-only, so it is safe beside a running engine:
//   docker compose exec engine node scripts/scorecard.js
// --version latest (default) scores the code version that traded most recently,
// the one the engine's own levels are computed for.
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { scorecardReport } from '../src/scorecard.js';
import { earnedLevel } from '../src/risk-levels.js';

const args = process.argv.slice(2), flag = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const env = (key, fallback) => Number(process.env[key] ?? fallback);
const path = resolve(flag('--db', join(process.env.DATA_DIR ?? './data', `${process.env.MODE ?? 'paper'}.sqlite`)));
const db = new DatabaseSync(path, { readOnly: true });
const orders = db.prepare('SELECT data FROM orders ORDER BY ts').all().map(row => JSON.parse(row.data));
db.close();

const cfg = { equityFee: env('EQUITY_FEE_BPS', 1), cryptoFee: env('CRYPTO_FEE_BPS', 25) };
const policy = { level2Trades: env('RISK_LEVEL2_MIN_TRADES', 100), level3Trades: env('RISK_LEVEL3_MIN_TRADES', 300) };
const everything = scorecardReport(orders, cfg), wanted = flag('--version', 'latest');
const codeHash = wanted === 'all' ? null : wanted === 'latest' ? everything.versions[0]?.codeHash ?? null : wanted;
const report = codeHash ? scorecardReport(orders, cfg, { codeHash }) : everything;
const levels = Object.fromEntries(report.strategies.map(s => [s.strategy, earnedLevel(s, policy)]));

if (args.includes('--json')) { console.log(JSON.stringify({ path, ...report, earnedLevels: levels }, null, 2)); process.exit(0); }

const money = x => x == null ? '—' : `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`;
const pct = x => x == null ? '—' : `${Math.round(x * 100)}%`;
const range = r => r ? `${money(r[0])} to ${money(r[1])}` : '—';
const et = t => t ? new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }) : '—';
const table = (head, rows) => {
  const width = head.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i]).length)));
  for (const row of [head, width.map(w => '-'.repeat(w)), ...rows]) console.log(row.map((cell, i) => i ? String(cell).padStart(width[i]) : String(cell).padEnd(width[i])).join('  '));
};

console.log(`Signal Foundry scorecard · ${path}`);
console.log(`Code version ${codeHash ? `${codeHash.slice(0, 12)}${wanted === 'latest' ? ' (traded most recently)' : ''}` : 'all versions'} · ${report.all.closed} closed trades · ${et(report.all.firstClosedAt)} to ${et(report.all.lastClosedAt)}`
  + (report.exceptions ? ` · ${report.exceptions} execution exception(s) unresolved` : ''));
console.log(report.note, '\n');
table(['Strategy', 'Trades', 'Win', 'Net', 'Avg/trade', '95% range per trade', 'Avg win', 'Avg loss', 'Fees/gross', 'Worst dip', 'Halves', 'Level'],
  report.strategies.map(s => { const l = levels[s.strategy]; return [s.strategy, s.closed, pct(s.winRate), money(s.net), money(s.mean), range(s.ci95),
    money(s.averageWin), money(s.averageLoss), pct(s.costShare), money(s.maxDrawdown), s.halves ? s.halves.map(money).join(' / ') : '—',
    l.next ? `${l.level} (Level ${l.next}: ${l.missing[0]})` : String(l.level)]; }));
if (report.byHour.length) { console.log('\nBy entry hour (New York)'); table(['Hour', 'Trades', 'Win', 'Net'], [...report.byHour].sort((a, b) => a.key.localeCompare(b.key)).map(h => [`${h.key}:00`, h.closed, pct(h.wins / h.closed), money(h.net)])); }
if (report.bySymbol.length) {
  const shown = report.bySymbol.length > 10 ? [...report.bySymbol.slice(0, 5), ...report.bySymbol.slice(-5)] : report.bySymbol;
  console.log(`\nBy symbol${report.bySymbol.length > 10 ? ' (best and worst five)' : ''}`); table(['Symbol', 'Trades', 'Win', 'Net'], shown.map(s => [s.key, s.closed, pct(s.wins / s.closed), money(s.net)]));
}
if (everything.versions.length > 1) { console.log('\nCode versions in this journal'); table(['Code version', 'Trades', 'Closed', 'Last entry'], everything.versions.map(v => [v.codeHash.slice(0, 12), v.trades, v.closed, et(v.lastEntryAt)])); }
