import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Jev } from '../src/jev.js';
import { Store } from '../src/store.js';
import { jevTracePage, jevTraceDetail } from '../src/jev-traces.js';
import { createDashboard } from '../src/server.js';
import { Engine } from '../src/engine.js';
import { fixture, candidate, testConfig, inlineWorkers } from './helpers.js';

const response = (pass = true) => ({ model: 'jev-1.13.0', answers: { coherence: { type: 'noul', noul: pass ? .9 : .5 }, regime: { type: 'choice', choice: 'trend', probabilities: { trend: .9, range: .05, disorderly: .05 }, confidence: .85 }, quality: { type: 'score', score: 3.8, probabilities: { 0: 0, 1: 0, 2: 0, 3: .2, 4: .8 }, confidence: .8 } }, usage: { input_tokens: 1200 } });
const clientConfig = mode => ({ ...testConfig(), jevMode: mode, jevKey: 'private-canary', jevBudget: 1 });

test('trace records the sent JSON and typed answer, excluding credentials and unexpected fields', async () => {
  const s = new Store(), c = candidate('SPY', Date.now()); let sent;
  c.features = { ...c.features, bar: { close: 100, ts: c.ts, secret: 'private-canary' }, secret: 'private-canary', symbol: 'SPY', micro: { normalizedOfi: 2 }, regime: 'trend' };
  try {
    const raw = response(); raw.secret = 'private-canary'; raw.answers.coherence.secret = 'private-canary';
    const j = new Jev(clientConfig('shadow'), s, async (_, opts) => { sent = JSON.parse(opts.body); assert.equal(opts.headers.Authorization, 'Bearer private-canary'); return { ok: true, status: 200, json: async () => raw }; });
    const result = await j.evaluate(c, c.ts), trace = s.modelTraceById(result.traceId);
    assert.deepEqual(trace.input, sent); assert.equal(trace.input.state.features.micro.normalizedOfi, 2);
    assert.equal(trace.httpStatus, 200); assert.equal(trace.output.answers.quality.score, 3.8); assert.equal(trace.status, 'completed');
    assert.ok(!JSON.stringify(trace).includes('private-canary')); assert.ok(!JSON.stringify(result).includes('private-canary'));
  } finally { s.close(); }
});

test('inflight I/O is visible and restart marks its unknown outcome without releasing cost reservation', async () => {
  const f = await fixture(); let release;
  try {
    const c = candidate('SPY', f.now()); f.store.candidate(c);
    const j = new Jev(clientConfig('shadow'), f.store, () => new Promise(resolve => { release = resolve; }));
    const waiting = j.evaluate(c, f.now()), trace = f.store.modelTraces()[0];
    assert.equal(jevTraceDetail(f.engine, trace.id).status, 'inflight'); assert.ok(trace.input.questions);
    const month = new Date(f.now()).toISOString().slice(0, 7), reserved = f.store.spend(month);
    await new Engine(f.cfg, f.store, f.broker, inlineWorkers, f.now).init();
    assert.equal(f.store.modelTraceById(trace.id).status, 'interrupted'); assert.equal(f.store.spend(month), reserved);
    release({ ok: true, status: 200, json: async () => response() }); await waiting;
  } finally { f.store.close(); }
});

test('preflight rejects before a paid Jev request and retains actual blockers', async () => {
  const f = await fixture();
  try {
    const c = f.prepare(); f.store.db.prepare('DELETE FROM candidates').run(); f.engine.operatorPause = true;
    f.engine.workers.evaluate = async () => [c]; let calls = 0;
    f.engine.jev = new Jev(clientConfig('shadow'), f.store, async () => { calls++; throw new Error('should not call'); });
    await f.engine.processCandidates(c.features, ['range_breakout']);
    const saved = f.store.getCandidate(c.id), trace = jevTraceDetail(f.engine, saved.model.traceId);
    assert.equal(calls, 0); assert.equal(saved.reason, 'entries_paused'); assert.equal(trace.error, 'preflight_entries_paused');
    assert.equal(trace.requested, false); assert.equal(trace.input, null); assert.ok(trace.decision.blockers.includes('operator_pause'));
    assert.equal(f.store.spend(new Date(f.now()).toISOString().slice(0, 7)), 0);
  } finally { f.store.close(); }
});

test('same declining classification allows shadow entry but vetoes filter entry, with accurate trace impact', async () => {
  for (const mode of ['shadow', 'filter']) {
    const f = await fixture();
    try {
      f.cfg.jevMode = mode; const c = f.prepare(); f.store.db.prepare('DELETE FROM candidates').run();
      f.engine.workers.evaluate = async () => [c];
      f.engine.jev = new Jev(clientConfig(mode), f.store, async () => ({ ok: true, status: 200, json: async () => response(false) }));
      await f.engine.processCandidates(c.features, ['range_breakout']);
      const saved = f.store.getCandidate(c.id), trace = jevTraceDetail(f.engine, saved.model.traceId);
      assert.equal(saved.status, mode === 'shadow' ? 'approved' : 'rejected');
      assert.equal(f.store.orders().length, mode === 'shadow' ? 1 : 0);
      assert.match(trace.decision.impact, mode === 'shadow' ? /no veto/ : /blocked/);
    } finally { f.store.close(); }
  }
});

test('allocation is rechecked after model latency before any order can be sent', async () => {
  const f = await fixture();
  try {
    f.cfg.jevMode = 'filter'; const c = f.prepare(); f.store.db.prepare('DELETE FROM candidates').run();
    f.engine.workers.evaluate = async () => [c];
    f.engine.jev = new Jev(clientConfig('filter'), f.store, async () => { f.engine.operatorPause = true; return { ok: true, json: async () => response() }; });
    await f.engine.processCandidates(c.features, ['range_breakout']);
    const saved = f.store.getCandidate(c.id); assert.equal(saved.model.pass, true); assert.equal(saved.reason, 'entries_paused'); assert.equal(f.store.orders().length, 0);
    assert.match(jevTraceDetail(f.engine, saved.model.traceId).decision.impact, /allocation checks/);
  } finally { f.store.close(); }
});

test('historical responses are visible without claiming a captured original HTTP request', async () => {
  const f = await fixture();
  try {
    const c = candidate('SPY', f.now(), 'old'); c.model = { requested: true, mode: 'shadow', answers: response().answers, quality: .95 }; c.status = 'rejected'; c.reason = 'entries_paused'; f.store.candidate(c);
    const page = jevTracePage(f.engine), detail = jevTraceDetail(f.engine, page.rows[0].id);
    assert.equal(page.rows[0].id, 'history-old'); assert.equal(page.rows[0].capturedInput, false); assert.equal(detail.input, null);
    assert.deepEqual(detail.historicalContext, c.features); assert.match(detail.captureNote, /not captured/); assert.match(detail.decision.impact, /no veto/);
  } finally { f.store.close(); }
});

test('trace endpoints require authentication, bound selections and expose no auth token', async () => {
  const f = await fixture(), server = createDashboard(f.engine, f.cfg); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`, headers = { Authorization: `Bearer ${f.cfg.token}` };
  try {
    for (const path of ['/api/jev-traces', '/api/jev-trace?id=old']) assert.equal((await fetch(base + path)).status, 401);
    for (const query of ['limit=9999', 'symbol=BAD', 'limit=1.5']) assert.equal((await fetch(base + '/api/jev-traces?' + query, { headers })).status, 400);
    assert.equal((await fetch(base + '/api/jev-trace?id=missing', { headers })).status, 404);
    const c = candidate('SPY', f.now()); f.store.candidate(c); const r = await new Jev(clientConfig('shadow'), f.store, async () => ({ ok: true, json: async () => response() })).evaluate(c, f.now());
    const body = await (await fetch(base + `/api/jev-trace?id=${r.traceId}`, { headers })).text(); assert.ok(!body.includes(f.cfg.token)); assert.ok(!body.includes('private-canary'));
    assert.equal((await fetch(base + '/jev-log.js')).status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); f.store.close(); }
});

test('error traces redact transport messages and HTTP response bodies', async () => {
  const s = new Store();
  try {
    for (const factory of [async () => { throw new Error('model_private-canary'); }, async () => ({ ok: false, status: 401, json: async () => ({ token: 'private-canary' }) })]) {
      const j = new Jev(clientConfig('shadow'), s, factory), r = await j.evaluate(candidate('SPY', Date.now()));
      assert.ok(!JSON.stringify(s.modelTraceById(r.traceId)).includes('private-canary')); assert.equal(r.pass, false);
    }
  } finally { s.close(); }
});

test('trace retention is bounded independently of the financial journal', () => {
  const s = new Store();
  try {
    for (let i = 0; i < 3002; i++) s.modelTrace({ id: String(i), candidateId: 'c' + i, ts: i, symbol: 'SPY', status: 'skipped' });
    assert.equal(s.modelTraceById('0'), null); assert.equal(s.modelTraces('', 4000).length, 3000);
    s.prune(3000); assert.equal(s.modelTraces().length, 2);
  } finally { s.close(); }
});
