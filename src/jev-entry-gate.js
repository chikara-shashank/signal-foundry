import { candidateReviewKey } from './research-evidence.js';
import { JEV_RUBRIC, supportsJevEntry } from './jev-context.js';
import { parseJev } from './jev.js';

// Applied immediately before reserving an entry. Preflight must remain usable
// before inference, and exits must never depend on a new model response.
export function jevEntryGate(engine, candidate) {
  if (engine.cfg.jevMode !== 'filter') return { ok: true };
  if (!supportsJevEntry(candidate)) return { ok: false, reason: 'jev_setup_review_required' };
  const result = candidate.model, trace = result?.traceId && engine.store.modelTraceById(result.traceId);
  if (!result?.requested || result.mode !== 'filter' || result.pass !== true || result.error ||
      !trace || trace.mode !== 'filter' || !trace.requested || trace.status !== 'completed' || trace.error ||
      trace.candidateId !== candidate.id || trace.candidateKey !== candidateReviewKey(candidate) ||
      trace.rubricVersion !== JEV_RUBRIC || trace.sessionId !== engine.jev.sessionId) return { ok: false, reason: 'jev_approval_required' };
  if (!Number.isFinite(trace.deadline) || !Number.isFinite(trace.completedAt) || trace.completedAt >= trace.deadline ||
      engine.clock() >= trace.deadline || engine.clock() < trace.ts) return { ok: false, reason: 'jev_approval_expired' };
  try { if (!parseJev(trace.output, engine.cfg).pass) return { ok: false, reason: 'model_filter' }; }
  catch { return { ok: false, reason: 'jev_approval_invalid' }; }
  return { ok: true, approval: { traceId: trace.id, candidateKey: trace.candidateKey, rubric: trace.rubricVersion,
    model: trace.model, approvedAt: trace.completedAt, deadline: trace.deadline } };
}
