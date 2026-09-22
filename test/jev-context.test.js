import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Jev, requestFor } from '../src/jev.js';
import { requestWindow } from '../src/jev-context.js';
import { jevTracePage } from '../src/jev-traces.js';
import { Store } from '../src/store.js';
import { fixture, candidate, testConfig } from './helpers.js';

const response = () => ({ model: 'jev-1.13.0', answers: { coherence: { type: 'noul', noul: .9 }, regime: { type: 'choice', choice: 'trend', probabilities: { trend: .9, range: .05, disorderly: .05 }, confidence: .85 }, quality: { type: 'score', score: 3.8, probabilities: { 0: 0, 1: 0, 2: 0, 3: .2, 4: .8 }, confidence: .8 } }, usage: { input_tokens: 1200 } });
const cfg = () => ({ ...testConfig(), jevMode: 'filter', jevBudget: 1, jevTimeout: 1500 });

test('setup-specific context distinguishes reversal from continuation and computes named facts', () => {
  const c = candidate('SPY', 1000); c.strategy = 'vwap_reversion';
  c.features = { regime: 'range', trend5: -.01, trend15: 0, ema9: 100, ema21: 101, bar: { close: 100 }, previous: { close: 99 }, rollingVwap: 102, relativeVolume: .9 };
  const state = requestFor(c, 'jev-1.13.0', cfg()).state;
  assert.match(state.setup, /mean reversion/); assert.match(state.setup, /upward trend is not required/);
  assert.equal(state.computedContext.trend5m, 'falling'); assert.equal(state.computedContext.trend15m, 'flat');
  assert.equal(state.computedContext.closeVersusVwap, 'below'); assert.equal(state.computedContext.closeVersusPrevious, 'above');
  assert.equal(state.horizon.maximumHoldingMs, 3600000); assert.equal(state.horizon.candidateLifetimeMs, 10000);
  assert.equal(state.computedContext.volatility, 'unknown'); assert.equal(state.rubricVersion, 'setup-context-2');
  assert.match(requestFor({ ...c, strategy: 'order_flow_continuation', maxHold: 180000 }, 'jev-1.13.0', cfg()).state.setup, /not a full order book/);
});

test('remaining model window respects candidate expiry, micro freshness and configured timeout', () => {
  const c = candidate('SPY', 1000);
  assert.equal(requestWindow(c, cfg(), 2000).timeoutMs, 1500);
  assert.equal(requestWindow(c, cfg(), 10900).timeoutMs, 100);
  c.strategy = 'order_flow_continuation'; c.features.micro = { ts: 1500 };
  assert.equal(requestWindow(c, cfg(), 2000).timeoutMs, 500);
  assert.equal(requestWindow(c, cfg(), 2500).timeoutMs, 0);
  delete c.features.micro; assert.equal(requestWindow(c, cfg(), 2000).timeoutMs, 0);
});

test('expired setup never sends HTTP or reserves model spending', async () => {
  const s = new Store(); let calls = 0;
  try {
    const c = candidate('SPY', Date.now()), j = new Jev(cfg(), s, async () => { calls++; });
    const result = await j.evaluate(c, c.expires);
    assert.equal(result.error, 'model_deadline_expired'); assert.equal(calls, 0); assert.equal(result.requested, false);
    assert.equal(s.spend(new Date(c.ts).toISOString().slice(0, 7)), 0);
  } finally { s.close(); }
});

test('request aborts at the remaining setup deadline and retains unknown billing reservation', async () => {
  const s = new Store();
  try {
    const c = candidate('SPY', Date.now()); c.expires = c.ts + 80;
    const j = new Jev(cfg(), s, async (_, { signal }) => {
      await delay(300, null, { signal }).catch(() => { throw signal.reason; });
      throw new Error('deadline failed to abort');
    });
    const r = await j.evaluate(c, c.ts), t = s.modelTraceById(r.traceId);
    assert.equal(r.requested, true); assert.equal(r.pass, false); assert.equal(r.error, 'model_timeout');
    assert.ok(t.timeoutBudgetMs > 0 && t.timeoutBudgetMs <= 80);
    assert.ok(s.spend(new Date(c.ts).toISOString().slice(0, 7)) > 0);
  } finally { s.close(); }
});

test('late valid response cannot approve but still records the answer and settles known cost', async () => {
  const s = new Store();
  try {
    const c = candidate('SPY', Date.now()); c.expires = c.ts + 60;
    const j = new Jev(cfg(), s, async () => { await delay(90); return { ok: true, json: async () => response() }; });
    const r = await j.evaluate(c, c.ts), t = s.modelTraceById(r.traceId);
    assert.equal(r.pass, false); assert.equal(r.error, 'model_deadline_expired'); assert.equal(t.output.answers.coherence.noul, .9);
    assert.equal(s.spend(new Date(c.ts).toISOString().slice(0, 7)), 1200 * .042 / 1e6);
  } finally { s.close(); }
});

test('session counters exclude historical records even if provider timestamps lie after process start', async () => {
  const f = await fixture();
  try {
    f.store.modelTrace({ id: 'old', candidateId: 'old-c', ts: f.now() + 18000, symbol: 'SPY', sessionId: 'previous', requested: true });
    f.store.modelTrace({ id: 'legacy', candidateId: 'legacy-c', ts: f.now() + 19000, symbol: 'SPY', requested: true });
    await f.engine.jev.evaluate(candidate('SPY', f.now()), f.now(), 'entries_paused');
    const page = jevTracePage(f.engine);
    assert.equal(page.rows.length, 3); assert.deepEqual(page.currentRunInView, { requested: 0, skipped: 1 });
    assert.equal(page.sessionId, f.engine.jev.sessionId);
    assert.notEqual(new Jev(cfg(), f.store).sessionId, page.sessionId);
  } finally { f.store.close(); }
});

test('filter approval places an automatic entry after fresh preflight timing and allocation recheck', async () => {
  const f = await fixture();
  try {
    f.cfg.jevMode = 'filter'; const c = f.prepare(); f.store.db.prepare('DELETE FROM candidates').run();
    f.engine.workers.evaluate = async () => { f.advance(200); return [c]; };
    f.engine.jev = new Jev(cfg(), f.store, async () => ({ ok: true, json: async () => response() }));
    await f.engine.processCandidates(c.features, ['range_breakout']);
    const saved = f.store.getCandidate(c.id), trace = f.store.modelTraceById(saved.model.traceId);
    assert.equal(trace.ts, f.now()); assert.equal(trace.ts - c.ts, 200);
    assert.equal(saved.status, 'approved'); assert.equal(f.store.orders().length, 1); assert.equal(trace.pass, true);
  } finally { f.store.close(); }
});
