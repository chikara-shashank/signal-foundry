import { nyDate } from '../src/util.js';
import { tradeScorecard } from '../src/research.js';

const latencySummary = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const percentile = p => sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null;
  return { observations: sorted.length, p50: percentile(.5), p95: percentile(.95), p99: percentile(.99) };
};

export function buildReport(store, cfg) {
  const candidates = store.db.prepare('SELECT data FROM candidates ORDER BY ts').all().map(x => JSON.parse(x.data));
  const orders = store.orders(), { trades, strategies, note } = tradeScorecard(orders, cfg);
  const closedTrades = trades.filter(t => t.fullyClosed), costs = trades.reduce((s, t) => s + t.estimatedFees, 0);
  const modelRows = candidates.filter(c => c.model?.quality != null);
  const rejectionCounts = {};
  for (const c of candidates.filter(x => x.status === 'rejected')) rejectionCounts[c.reason] = (rejectionCounts[c.reason] ?? 0) + 1;
  const scope = cfg.accountPolicy === 'shared' ? 'agent' : 'account';
  const equity = store.db.prepare('SELECT ts,data FROM events WHERE type=? ORDER BY ts').all(scope === 'agent' ? 'agent_equity' : 'equity').map(x => ({ ts: x.ts, ...JSON.parse(x.data) }));
  let peak = -Infinity, maxDrawdown = 0, day = null;
  for (const e of equity) {
    const value = e.dailyPnl; if (!Number.isFinite(value)) continue;
    if (nyDate(e.ts) !== day) { day = nyDate(e.ts); peak = value; }
    peak = Math.max(peak, value); maxDrawdown = Math.max(maxDrawdown, peak-value);
  }
  return { generatedAt: new Date().toISOString(), mode: cfg.mode, configFingerprint: cfg.fingerprint, candidateCount: candidates.length, orderCount: orders.length,
    closedTradeCount: closedTrades.length, grossPnl: trades.reduce((s, t) => s + t.grossPnl, 0), estimatedFees: costs,
    estimatedNetPnl: trades.reduce((s, t) => s + t.estimatedNetPnl, 0), winRate: closedTrades.length ? closedTrades.filter(t => t.estimatedNetPnl > 0).length / closedTrades.length : null,
    recordedDailyDrawdownUsd: maxDrawdown, scope, strategies, equity, openPositions: store.get('lastAccountSnapshot', { positions: [] }).positions,
    model: { evaluated: modelRows.length, passed: modelRows.filter(c => c.model.pass).length, estimatedOrReportedCost: candidates.reduce((s, c) => s + (c.model?.cost ?? 0), 0) },
    latencyMs: { workerBatch: latencySummary(candidates.map(c => c.workerLatencyMs)), model: latencySummary(candidates.map(c => c.model?.latencyMs)), orderSubmission: latencySummary(orders.map(o => o.submissionLatencyMs)), note: 'Submission duration includes the adapter request, not exchange fill latency. Replay uses inline strategy evaluation, not worker threads.' },
    rejectionCounts, trades, limitations: [note, 'Infrastructure costs are excluded. Short/incomplete samples do not establish an edge.', 'Counterfactual Jev comparison requires replaying the same events with recorded answers and identical settings.'] };
}
