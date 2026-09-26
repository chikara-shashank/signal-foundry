import test from 'node:test';
import assert from 'node:assert/strict';
import { OPTIONS_POLICY as P, OPTIONS_STRATEGIES, optionContext, scanOptions, spreadEconomics, contractProblem, quoteProblem } from '../src/options-strategies.js';
import { OptionsData, normalizeOption, normalizeOptionQuote } from '../src/options-data.js';
import { freshOptionsState, advanceOptions, optionsSummary, OptionsLab, replayOptions, replayOptionsStress, optionsRecord } from '../src/options-lab.js';
import { nyTimestamp } from '../src/util.js';
import { fixture } from './helpers.js';
import { createDashboard } from '../src/server.js';

const start = Date.parse('2026-09-28T15:00:00Z');
function frameFor(strategy = 'put_credit', now = start) {
  const credit = strategy === 'put_credit', call = strategy === 'call_debit', expiry = credit ? '2026-10-26' : '2026-10-12';
  const make = strike => ({ symbol: `SPY${expiry.replaceAll('-', '').slice(2)}${call ? 'C' : 'P'}${String(strike * 1000).padStart(8, '0')}`,
    underlying: 'SPY', root: 'SPY', expiry, type: call ? 'call' : 'put', style: 'american', status: 'active', tradable: true, strike, multiplier: 100, size: 100, openInterest: 1000,
    oiDate: '2026-09-25', deliverables: [{ type: 'equity', symbol: 'SPY', amount: '100', allocation_percentage: '100', delayed_settlement: false }] });
  const anchor = make(credit ? 95 : call ? 100 : 101), hedge = make(credit ? 94 : call ? 101 : 100);
  const q = (bid, delta) => ({ bid, ask: bid + .02, bidSize: 100, askSize: 100, condition: ' ', ts: now, delta, iv: .25 });
  return { schema: 1, source: 'alpaca_opra', stockFeed: 'sip', sampled: true, now, clockUncertaintyMs: 50, universe: ['SPY'], marketOpen: true,
    session: { date: '2026-09-28', open: nyTimestamp('2026-09-28', '09:30'), close: nyTimestamp('2026-09-28', '16:00') },
    spots: { SPY: { price: 100.2, ts: now } }, contexts: { SPY: { rv20: .15, sma20: 99, sma50: 98, previousClose: 100, through: Date.parse('2026-09-25T04:00Z'),
      intradayReady: true, barEnd: now - 1000, close: call ? 102 : 99, rangeHigh: 101, rangeLow: 100, vwap: 100.5 } },
    contracts: { [anchor.symbol]: anchor, [hedge.symbol]: hedge },
    quotes: { [anchor.symbol]: q(credit ? 1 : 1.5, credit ? -.25 : call ? .55 : -.55), [hedge.symbol]: q(credit ? .68 : 1, call ? .4 : -.18) } };
}
function later(frame, seconds = 30) {
  const f = structuredClone(frame); f.now += seconds * 1000;
  for (const q of Object.values(f.quotes)) q.ts = f.now;
  for (const q of Object.values(f.spots)) q.ts = f.now;
  return f;
}
function enabledState(strategy = 'put_credit') { const s = freshOptionsState(); s.enabled[strategy] = true; return s; }
test('independent options stress misses an entry available under primary latency',()=>{
  const state=enabledState('call_debit'),f=frameFor('call_debit'),records=[optionsRecord(state,f,true,true)];advanceOptions(state,f);
  const next=later(f,2);records.push(optionsRecord(state,next));advanceOptions(state,next);
  assert.equal(replayOptions(records).positions.length,1);
  const stress=replayOptionsStress(records);assert.equal(stress.positions.length,0);assert.equal(stress.pending,1);assert.equal(stress.scenario,'independent_3500ms_adverse_costs');
});
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);

for (const strategy of OPTIONS_STRATEGIES.map(s => s.id)) test(`${strategy}: standard same-expiry vertical and 100-share economics`, () => {
  const f = frameFor(strategy), scan = scanOptions(f, [strategy]);
  assert.equal(scan.candidates.length, 1);
  const c = scan.candidates[0]; assert.equal(c.quantity, 1); assert.equal(c.long.expiry, c.short.expiry);
  near(c.entryCost, strategy === 'put_credit' ? -.28 : .54); near(c.maxLoss, strategy === 'put_credit' ? 72.4 : 54.4);
  near(c.immediateRoundTripLoss, 8.4); assert.ok(c.maxProfit > 0);
});
test('zero commission still crosses both bid/ask spreads and pays adverse slippage', () => {
  const f = frameFor(), c = scanOptions(f).candidates[0];
  const x = spreadEconomics(c, f.quotes, f.now, { ...P, feePerContractSide: 0 }); near(x.immediateRoundTripLoss, 8);
});
test('reject indicative, bad clock, future context and closed/late sessions', () => {
  for (const modify of [f => { f.source = 'indicative'; }, f => { f.clockUncertaintyMs = 1001; }, f => { f.marketOpen = false; }, f => { f.now = f.session.close - 59999; }, f => { f.contexts.SPY.through = f.now; }]) {
    const f = frameFor(); modify(f); assert.equal(scanOptions(f).candidates.length, 0);
  }
});
test('reject stale/future/crossed/zero/unknown-condition and insufficient-size quotes', () => {
  const original = Object.values(frameFor().quotes)[0];
  for (const patch of [{ ts: start - 5001 }, { ts: start + 1001 }, { bid: 0 }, { ask: .1 }, { condition: 'H' }, { condition: undefined }, { bidSize: 0 }, { bidSize: 1 }, { ask: 2 }]) assert.ok(quoteProblem({ ...original, ...patch }, start));
});
test('reject adjusted deliverables, missing/stale OI, wrong type and multiplier', () => {
  const f = frameFor(), c = Object.values(f.contracts)[0], d = OPTIONS_STRATEGIES[0];
  for (const patch of [{ multiplier: 10 }, { root: 'SPY1' }, { size: 50 }, { deliverables: [] }, { openInterest: null }, { oiDate: '2026-09-01' }, { type: 'call' }, { expiry: '2026-09-28' }]) assert.ok(contractProblem({ ...c, ...patch }, f, d));
});
test('missing Greeks and unsynchronized legs cannot enter', () => {
  const f = frameFor(), quotes = Object.values(f.quotes); quotes[0].delta = null;
  assert.equal(scanOptions(f).candidates.length, 0);
  quotes[0].delta = -.25; quotes[1].ts -= 1001; assert.equal(scanOptions(f).candidates.length, 0);
});
test('position and portfolio caps reserve pending spread risk; zero size is not rounded up', () => {
  const f = frameFor(); assert.equal(scanOptions(f, ['put_credit'], { ...P, maxRisk: 10 }).candidates.length, 0);
  const s = enabledState(); advanceOptions(s, f); assert.equal(s.pending.length, 1);
  advanceOptions(s, later(f)); assert.equal(s.positions.length, 1); assert.equal(s.pending.length, 0);
  advanceOptions(s, later(f, 60)); assert.equal(s.positions.length, 1); assert.equal(s.pending.length, 0);
});
test('fills require a later observation and both leg quotes after decision latency', () => {
  const f = frameFor(), s = enabledState(); advanceOptions(s, f); assert.equal(s.positions.length, 0);
  const stale = later(f, 2); Object.values(stale.quotes)[0].ts = start; advanceOptions(s, stale); assert.equal(s.positions.length, 0);
  advanceOptions(s, later(f, 30)); assert.equal(s.positions.length, 1);
});
test('limit price does not fill after adverse movement and expires without chasing', () => {
  const f = frameFor(), s = enabledState(); advanceOptions(s, f);
  const laterFrame = later(f); const short = laterFrame.quotes[s.pending[0].short.symbol]; short.bid -= .02; short.ask -= .02;
  advanceOptions(s, laterFrame); assert.equal(s.positions.length, 0);
  advanceOptions(s, later(f, 91)); assert.equal(s.pending.length, 0); assert.equal(s.positions.length, 0);
});
test('off cancels pending while preserving open exit management; P/L includes multiplier and all four leg fees', () => {
  const f = frameFor(), s = enabledState(); advanceOptions(s, f); advanceOptions(s, later(f)); s.enabled.put_credit = false;
  const closeFrame = later(f, 60), short = closeFrame.quotes[s.positions[0].short.symbol]; short.bid = .75; short.ask = .77;
  advanceOptions(s, closeFrame); assert.equal(s.trades.length, 0); assert.equal(s.positions[0].exitReason, 'profit_target');
  advanceOptions(s, later(closeFrame)); assert.equal(s.positions.length, 0); assert.equal(s.trades.length, 1);
  near(s.trades[0].netPnl, 16.6); near(s.trades[0].fees, .4); near(s.trades[0].stressNetPnl, 6.4);
  assert.equal(optionsSummary(s).strategies[0].winRate, 1);
  const p = enabledState(); advanceOptions(p, f); p.enabled.put_credit = false; advanceOptions(p, later(f)); assert.equal(p.pending.length, 0); assert.equal(p.positions.length, 0);
});
test('intraday exits occur before early session close and use subsequent quotes', () => {
  const f = frameFor('call_debit'), s = enabledState('call_debit'); f.session.close = start + 70 * 60000;
  advanceOptions(s, f); const fill = later(f); advanceOptions(s, fill);
  const exit = later(f, 50 * 60); advanceOptions(s, exit); assert.equal(s.positions[0].exitReason, 'time');
  advanceOptions(s, later(exit)); assert.equal(s.trades.length, 1);
  assert.ok(s.qualityIssues.includes('open_position_capture_gap'));
});
test('no fabricated expiration fills; stale marks and capture gaps block new entries', () => {
  const f = frameFor(), s = enabledState(); advanceOptions(s, f); advanceOptions(s, later(f));
  const expired = later(f, 28 * 86400); expired.session.date = '2026-10-26'; expired.quotes = {};
  advanceOptions(s, expired); assert.equal(s.positions[0].markNet, null); assert.equal(s.trades.length, 0);
  assert.ok(s.qualityIssues.includes('unmodeled_expiration_or_overnight_intraday_position'));
  assert.equal(optionsSummary(s).validation.liveEligible, false);
});
test('daily loss uses current liquidation marks, blocks entry and requests exit', () => {
  const f = frameFor(), s = enabledState(); advanceOptions(s, f); advanceOptions(s, later(f));
  const bad = later(f, 60), short = bad.quotes[s.positions[0].short.symbol]; short.bid = 2; short.ask = 2.02;
  advanceOptions(s, bad); assert.equal(s.lastScan.entryGate, 'daily_loss'); assert.ok(s.positions[0].exitRequestedAt); assert.equal(s.pending.length, 0);
});
test('raw future/incomplete candles cannot create a breakout; realized volatility uses prior days only', () => {
  const session = frameFor().session;
  const daily = Array.from({ length: 60 }, (_, i) => ({ t: new Date(start - (61 - i) * 86400000).toISOString(), o: 99, h: 102, l: 98, c: 100 + (i % 2), v: 100 }));
  const bars = Array.from({ length: 8 }, (_, i) => ({ t: new Date(session.open + i * 300000).toISOString(), o: 100, h: 102, l: 99, c: 101, v: 100, vw: 100.5 }));
  const now = session.open + 35 * 60000;
  const x = optionContext(daily, bars, session, now); assert.equal(x.barEnd, now); assert.equal(x.intradayReady, true);
  bars[7].c = 10000; bars[7].h = 10000; const y = optionContext(daily, bars, session, now); assert.equal(y.close, x.close); assert.equal(y.rv20, x.rv20);
  bars.splice(2, 1); assert.equal(optionContext(daily, bars, session, now).intradayReady, false);
});
test('replay is deterministic, rejects mutated policy/code and out-of-order timestamps', () => {
  const f = frameFor(), s = enabledState(), frames = [f, later(f)];
  const records = frames.map((frame,i) => { const r=optionsRecord(s,frame,true,i===0);advanceOptions(s,frame);return r; });
  assert.deepEqual(replayOptions(records).positions, optionsSummary(s).positions);
  assert.throws(() => replayOptions([{ ...records[0], codeHash: 'changed' }]), /mismatch/);
  assert.throws(() => replayOptions([records[0], records[0]]), /state_discontinuity|out_of_order/);
});
test('Alpaca adapter permits only fixed read-only endpoints and sanitizes failures', async () => {
  const requests = [], adapter = new OptionsData({ key: 'secret-key', secret: 'secret-value', fetchFn: async (url, init) => { requests.push({ url, init }); return { ok: false, status: 403 }; } });
  await assert.rejects(() => adapter.get('https://paper-api.alpaca.markets', '/v2/orders'), /read_only_endpoint/);
  await assert.rejects(() => adapter.get('https://api.alpaca.markets', '/v2/clock'), /read_only_endpoint/);
  await assert.rejects(() => adapter.capture(), /^Error: options_data_http_403$/);
  assert.equal(requests.length, 1); assert.equal(requests[0].init.method, 'GET'); assert.equal(requests[0].init.redirect, 'error');
});
test('normalizers preserve missing Greek/interest values instead of inventing zeroes', () => {
  assert.equal(normalizeOption({}).openInterest, null); assert.equal(normalizeOptionQuote({}).delta, null); assert.equal(normalizeOptionQuote({}).iv, null);
});
test('options controls persist, use compare-and-swap and do not call broker execution', async t => {
  const f = await fixture(); t.after(() => f.store.close()); f.engine.cfg.mode = 'paper';
  let requests = 0; const adapter = { capture: () => { requests++; throw Error('unexpected'); } };
  f.engine.optionsLab = new OptionsLab(f.engine, adapter);
  const lab = f.engine.optionsLab;
  await lab.update({ strategy: 'put_credit', enabled: true, expectedRevision: 0 });
  assert.equal(new OptionsLab(f.engine, adapter).state.enabled.put_credit, true);
  await assert.rejects(() => lab.update({ strategy: 'call_debit', enabled: true, expectedRevision: 0 }), { status: 409 });
  await assert.rejects(() => lab.update({ strategy: 'put_credit', enabled: 'yes', expectedRevision: 1 }), { status: 400 });
  await assert.rejects(() => lab.update({ strategy: 'put_credit', enabled: false, expectedRevision: 1, live: true }), { status: 400 });
  assert.equal(requests, 0); assert.equal(f.store.orders().length, 0);
});
test('options HTTP endpoints require token and same origin; demo cannot enable data collection', async t => {
  const f = await fixture(); f.engine.optionsLab = new OptionsLab(f.engine, null); const server = createDashboard(f.engine, f.cfg);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(async () => { server.closeStreams(); await new Promise(resolve => server.close(resolve)); f.store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/api/options')).status, 401);
  const headers = { Authorization: `Bearer ${f.cfg.token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(base + '/api/options', { headers })).status, 200);
  const body = JSON.stringify({ strategy: 'put_credit', enabled: true, expectedRevision: 0 });
  assert.equal((await fetch(base + '/api/options-settings', { method: 'POST', headers: { ...headers, Origin: 'https://bad.example' }, body })).status, 403);
  assert.equal((await fetch(base + '/api/options-settings', { method: 'POST', headers, body })).status, 409);
});

test('daily halt and sampled drawdown survive a price rebound and serialization', () => {
  const f = frameFor(), s = enabledState(); advanceOptions(s, f); advanceOptions(s, later(f));
  const bad = later(f, 60), short = bad.quotes[s.positions[0].short.symbol]; short.bid = 2; short.ask = 2.02;
  advanceOptions(s, bad); const drawdown = s.maxDrawdown; assert.ok(drawdown > 100);
  const restored = JSON.parse(JSON.stringify(s)); advanceOptions(restored, later(f, 90));
  assert.equal(restored.haltedDate, '2026-09-28'); assert.equal(restored.lastScan.entryGate, 'daily_loss'); assert.equal(restored.maxDrawdown, drawdown);
});
test('checkpoint replay reproduces cancellations during off/on edits and detects damaged data', () => {
  const f = frameFor(), s = enabledState(), records = [optionsRecord(s, f, true, true)]; advanceOptions(s, f);
  s.pending = []; s.revision += 2; // An off/on cycle between observations must not restore the cancelled intent.
  records.push(optionsRecord(s, later(f))); advanceOptions(s, later(f));
  assert.equal(replayOptions(records).positions.length, 0);
  const changed = structuredClone(records); Object.values(changed[1].frame.quotes)[0].bid += .01;
  assert.throws(() => replayOptions(changed), /data_mismatch/);
});
test('a daily tape checkpoint retains prior positions and cannot hide missing intermediate frames', () => {
  const f = frameFor(), s = enabledState(); advanceOptions(s, f); advanceOptions(s, later(f));
  const record = optionsRecord(s, later(f, 60), true, true); advanceOptions(s, record.frame);
  assert.deepEqual(replayOptions([record]).positions, s.positions);
  const next = optionsRecord(s, later(f, 90)); advanceOptions(s, next.frame);
  const missing = optionsRecord(s, later(f, 120));
  assert.throws(() => replayOptions([record, missing]), /state_discontinuity/);
});
test('code drift disables only the options lab and preserves the prior ledger', async t => {
  const f = await fixture(); t.after(() => f.store.close());
  const old = freshOptionsState(); old.codeHash = 'old-implementation'; f.store.set('optionsLab', old);
  const lab = new OptionsLab(f.engine, null);
  assert.match(lab.unavailable(), /experiment changed/); assert.equal(lab.snapshot().strategies[0].netPnl, null);
  await assert.rejects(() => lab.update({ strategy: 'put_credit', enabled: false, expectedRevision: 0 }), { status: 409 });
  assert.equal(f.store.get('optionsLab').codeHash, 'old-implementation'); assert.equal(f.engine.status().version, '1.16.0');
});
