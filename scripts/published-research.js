import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { hash, nyTimestamp } from '../src/util.js';
import { completeSession, replaySession, sessionStatistics, SESSION_REPLAY_POLICY } from '../src/session-replay.js';

const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i < 0 ? fallback : process.argv[i + 1]; };
const cache = arg('cache', 'data/history'), out = arg('out', 'data/research/published-2026-09-25.json');
const calendar = JSON.parse(readFileSync(join(cache, 'calendar_2015-12-01_2026-09-23.json'), 'utf8'))
  .map(d => ({ date: d.date, open: nyTimestamp(d.date, d.open), close: nyTimestamp(d.date, d.close) }));
const scenarios = { commission_free: { slipBps: 1, feeBps: 0 }, engine_cost: { slipBps: 3, feeBps: 1 }, adverse: { slipBps: 6, feeBps: 1, delayMinutes: 1 } };
const report = { schema: 1, protocol: 'docs/RESEARCH-PROTOCOL-2026-09-25.md', generatedAt: new Date().toISOString(), source: 'cached_alpaca_sip_adjustment_all',
  policy: SESSION_REPLAY_POLICY, scenarios, files: [], quality: {}, results: [], liveEligible: false,
  limitations: ['Bar-based price approximation, not executable-quote validation; assumed spreads.', 'Retrospective windows were available to earlier studies; not pristine unseen data.',
    'Strict complete-session exclusion can bias the sample; exclusions are reported.', 'Standalone hypotheses exclude competing strategies, Jev vetoes, external holdings and broker failures.',
    'Standardized $500 allocation; production noise-area uses its separately configured fixed notional.', 'Historical adjusted prices can change integer-lot eligibility; final prospective test must use raw quotes.',
    'Drawdown uses daily closes and understates intraday risk. Confidence intervals are not corrected for multiple comparisons.'] };
const allTrades = [];
for (const symbol of ['SPY', 'QQQ']) {
  const raw = new Map();
  for (const name of readdirSync(join(cache, 'session')).sort().filter(n => n.startsWith(symbol + '_') && n.endsWith('.json.gz'))) {
    const contents = readFileSync(join(cache, 'session', name)); report.files.push({ file: name, sha256: createHash('sha256').update(contents).digest('hex') });
    for (const [date, rows] of Object.entries(JSON.parse(gunzipSync(contents)))) raw.set(date, rows);
  }
  const byDate = new Map(), excluded = [];
  for (const d of calendar) {
    const bars = raw.get(d.date)?.map(([minute, open, high, low, close, volume]) => ({ symbol, ts: d.open + minute * 60000, open, high, low, close, volume }));
    if (completeSession(d, bars)) byDate.set(d.date, bars); else excluded.push({ date: d.date, reason: bars ? 'incomplete_or_invalid_session' : 'missing_from_cache' });
  }
  report.quality[symbol] = { completeSessions: byDate.size, excluded };
  for (const strategy of ['noise_legacy', 'noise_area', 'vwap_trend']) for (const [scenario, cost] of Object.entries(scenarios)) {
    const trades = [], eligible = [];
    let cash = SESSION_REPLAY_POLICY.capital;
    for (let i = 14; i < calendar.length; i++) {
      const d = calendar[i]; if (d.date < '2016-01-01' || !byDate.has(d.date)) continue;
      const prior = calendar.slice(i - 14, i).map(p => byDate.get(p.date));
      const result = replaySession(d, byDate.get(d.date), prior, strategy, { ...cost, capital: cash, halfSpreadBps: symbol === 'SPY' ? .13 : .14 });
      if (result.reason) continue;
      eligible.push(d.date); trades.push(...result.trades);
      cash += result.trades.reduce((sum, t) => sum + t.netPnl, 0);
    }
    for (const [window, from, to] of [['full','2016-01-01','2027'],['development','2016-01-01','2024'],['retrospective_validation','2024','2026'],['final_2026','2026','2027']]) {
      report.results.push({ symbol, strategy, scenario, window, ...sessionStatistics(trades.filter(t => t.date >= from && t.date < to), eligible.filter(d => d >= from && d < to)) });
    }
    allTrades.push(...trades.map(t => ({ ...t, scenario })));
  }
}
report.files.push({file:'calendar_2015-12-01_2026-09-23.json',sha256:createHash('sha256').update(readFileSync(join(cache,'calendar_2015-12-01_2026-09-23.json'))).digest('hex')});
report.dataFingerprint = hash(report.files);
report.codeFingerprint = hash(['src/session-replay.js','src/session-signals.js','scripts/published-research.js'].map(p => [p, readFileSync(p,'utf8').replaceAll('\r\n','\n')]));
report.protocolFingerprint = hash(readFileSync(report.protocol,'utf8').replaceAll('\r\n','\n'));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2));
writeFileSync(out.replace(/\.json$/, '.trades.jsonl'), allTrades.map(t => JSON.stringify(t)).join('\n') + '\n');
console.log(JSON.stringify({ out, dataFingerprint: report.dataFingerprint, quality: Object.fromEntries(Object.entries(report.quality).map(([k,v])=>[k,{complete:v.completeSessions,excluded:v.excluded.length}])), results: report.results.filter(r => r.window === 'final_2026') }, null, 2));
