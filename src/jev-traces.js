import { traceFeatures, traceAnswers } from './jev.js';

function historical(c) {
  const m = c.model;
  return { id: `history-${c.id}`, candidateId: c.id, ts: c.ts, symbol: c.symbol, strategy: c.strategy, mode: m.mode,
    model: m.model ?? null, requested: true, status: m.error ? 'error' : 'completed', pass: m.pass, latencyMs: m.latencyMs ?? null, cost: m.cost ?? null,
    error: m.error ?? null, input: null, historicalContext: traceFeatures(c.features),
    output: m.answers ? { model: m.model, answers: traceAnswers(m.answers), usage: { input_tokens: m.inputTokens ?? null } } : null,
    captureNote: 'Historical record: original HTTP request was not captured. This is the recorded numerical context and parsed answer, not a reconstructed wire request.' };
}
function outcome(engine, trace) {
  const c = engine.store.getCandidate(trace.candidateId), mode = trace.mode;
  const impact = !trace.requested ? 'No model request' : mode === 'shadow' ? 'Observed only; no veto in shadow mode'
    : mode === 'filter' && c?.status === 'rejected' && (c.reason === 'model_filter' || c.reason?.startsWith('model_') || c.reason?.startsWith('invalid_model')) ? 'Jev filter blocked this entry'
    : mode === 'filter' && trace.pass ? 'Jev passed; allocation checks still apply' : 'Waiting for a final decision';
  return { ...trace, decision: { status: c?.status ?? 'unavailable', reason: c?.reason ?? null, blockers: c?.blockers ?? [], orderId: c?.orderId ?? null, impact } };
}
export function jevTracePage(engine, { symbol = '', limit = 40 } = {}) {
  if ((symbol && !engine.cfg.symbols.includes(symbol)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid trace selection');
  const recent = engine.store.modelTraces(symbol, limit), ids = new Set(recent.map(t => t.candidateId));
  const older = engine.store.historicalModels(symbol, limit).filter(c => !ids.has(c.id) && !c.model.traceId).map(historical);
  const rows = [...recent, ...older].sort((a, b) => b.ts - a.ts).slice(0, limit).map(t => outcome(engine, t));
  const current = rows.filter(t => t.sessionId === engine.jev.sessionId), requested = current.filter(t => t.requested).length;
  return { now: engine.clock(), mode: engine.cfg.jevMode, sessionId: engine.jev.sessionId,
    currentRunInView: { requested, skipped: current.length - requested },
    rows: rows.map(({ input, output, historicalContext, thresholds, ...row }) => ({ ...row, capturedInput: !!input })),
    note: 'Actual request/response traces are retained up to 3,000 records and the configured retention period. Older records show only the context previously retained. Classification latency and scores do not establish profitable trading value.' };
}
export function jevTraceDetail(engine, id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,150}$/.test(id)) throw new Error('Invalid trace ID');
  const stored = engine.store.modelTraceById(id);
  if (stored) return outcome(engine, stored);
  if (id.startsWith('history-')) {
    const c = engine.store.getCandidate(id.slice(8));
    if (c?.model?.requested || c?.model?.answers) return outcome(engine, historical(c));
  }
  return null;
}
