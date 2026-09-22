import { isCrypto } from '../src/util.js';

const latencySummary = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const percentile = p => sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null;
  return { observations: sorted.length, p50: percentile(.5), p95: percentile(.95), p99: percentile(.99) };
};

export function buildReport(store, cfg) {
  const candidates = store.db.prepare('SELECT data FROM candidates ORDER BY ts').all().map(x => JSON.parse(x.data));
  const orders = store.orders(), trades = [];
  for (const entry of orders.filter(o => o.kind === 'entry' && o.filledQty > 0)) {
    const exits = orders.filter(o => o.entryId === entry.id && o.kind === 'exit' && o.filledQty > 0);
    const native = (entry.legs ?? []).filter(o => o.filledQty > 0);
    const closed = [...exits, ...native];
    const qty = closed.reduce((s, x) => s + x.filledQty, 0);
    if (!qty || qty > entry.filledQty + 1e-8) continue;
    const gross = closed.reduce((s, x) => s + x.filledQty * (x.fillPrice - entry.fillPrice), 0);
    const feeBps = isCrypto(entry.symbol) ? cfg.cryptoFee : cfg.equityFee;
    const estimatedFees = qty * entry.fillPrice * feeBps / 10000 + closed.reduce((s, x) => s + x.filledQty * x.fillPrice * feeBps / 10000, 0);
    trades.push({ symbol: entry.symbol, strategy: entry.strategy, quantity: qty, fullyClosed: Math.abs(qty - entry.filledQty) < 1e-8, grossPnl: gross, estimatedFees, estimatedNetPnl: gross - estimatedFees, entryId: entry.id });
  }
  const closedTrades = trades.filter(t => t.fullyClosed), costs = trades.reduce((s, t) => s + t.estimatedFees, 0);
  const modelRows = candidates.filter(c => c.model?.quality != null);
  const rejectionCounts = {};
  for (const c of candidates.filter(x => x.status === 'rejected')) rejectionCounts[c.reason] = (rejectionCounts[c.reason] ?? 0) + 1;
  const equity = store.db.prepare("SELECT ts,data FROM events WHERE type='equity' ORDER BY ts").all().map(x => ({ ts: x.ts, ...JSON.parse(x.data) }));
  let peak = 0, maxDrawdown = 0;
  for (const e of equity) { peak = Math.max(peak, e.equity); maxDrawdown = Math.max(maxDrawdown, peak - e.equity); }
  return { generatedAt: new Date().toISOString(), mode: cfg.mode, configFingerprint: cfg.fingerprint, candidateCount: candidates.length, orderCount: orders.length,
    closedTradeCount: closedTrades.length, grossPnl: trades.reduce((s, t) => s + t.grossPnl, 0), estimatedFees: costs,
    estimatedNetPnl: trades.reduce((s, t) => s + t.estimatedNetPnl, 0), winRate: closedTrades.length ? closedTrades.filter(t => t.estimatedNetPnl > 0).length / closedTrades.length : null,
    recordedEquityDrawdownUsd: maxDrawdown, equity, openPositions: store.get('lastAccountSnapshot', { positions: [] }).positions,
    model: { evaluated: modelRows.length, passed: modelRows.filter(c => c.model.pass).length, estimatedOrReportedCost: candidates.reduce((s, c) => s + (c.model?.cost ?? 0), 0) },
    latencyMs: { workerBatch: latencySummary(candidates.map(c => c.workerLatencyMs)), model: latencySummary(candidates.map(c => c.model?.latencyMs)), orderSubmission: latencySummary(orders.map(o => o.submissionLatencyMs)), note: 'Submission duration includes the adapter request, not exchange fill latency. Replay uses inline strategy evaluation, not worker threads.' },
    rejectionCounts, trades, limitations: ['Net trade results use configured fee estimates, not a reconciled broker tax ledger.', 'Infrastructure costs are excluded. Short/incomplete samples do not establish an edge.', 'Counterfactual Jev comparison requires replaying the same events with recorded answers and identical settings.'] };
}
