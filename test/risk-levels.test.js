import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { closedTrade, fixture, testConfig } from './helpers.js';
import { earnedLevel } from '../src/risk-levels.js';
import { closedTradeStats } from '../src/scorecard.js';
import { codeHash } from '../src/strategy-manifest.js';
import { createDashboard } from '../src/server.js';

const close = async f => { f.engine.stopped = true; clearTimeout(f.engine.streamReconcile); await f.engine.mutex.tail; f.store.close(); };
const policy = { level2Trades: 100, level3Trades: 300 };
const stats = nets => closedTradeStats(nets.map((n, i) => ({ fullyClosed: true, estimatedNetPnl: n, grossPnl: n, estimatedFees: 0, closedAt: i })));
const repeat = (n, value) => Array(n).fill(value);

test('a level is earned by enough profitable trades that hold up over time, and says what is missing', () => {
  assert.deepEqual(earnedLevel(stats(repeat(99, 1)), policy), { level: 1, next: 2, missing: ['99/100 closed trades'] });
  assert.equal(earnedLevel(stats(repeat(100, 1)), policy).level, 2);
  assert.deepEqual(earnedLevel(stats([...repeat(50, 3), ...repeat(50, -1)]), policy).missing, ['not profitable in both halves']);
  assert.deepEqual(earnedLevel(stats(repeat(100, -1)), policy).missing, ['net P/L after costs is not positive', 'not profitable in both halves']);
  assert.deepEqual(earnedLevel(stats(repeat(299, 1)), policy), { level: 2, next: 3, missing: ['299/300 closed trades'] });
  assert.deepEqual(earnedLevel(stats(repeat(300, 1)), policy), { level: 3, next: null, missing: [] });
  // Profitable in every half and third, but one dip was deeper than everything it made.
  const dip = stats([...repeat(200, .5), ...repeat(20, -20), ...repeat(80, 5.25)]);
  assert.ok(dip.maxDrawdown > dip.net && dip.thirds.every(x => x > 0) && dip.halves.every(x => x > 0));
  assert.deepEqual(earnedLevel(dip, policy), { level: 2, next: 3, missing: ['worst drawdown is larger than net profit'] });
  assert.equal(earnedLevel({ ...stats(repeat(300, 1)), exceptions: 1 }, policy).level, 1);
});

test('settings are validated, off by default, and never automatic with real money', () => {
  assert.equal(testConfig().riskLevels.mode, 'off');
  assert.deepEqual({ ...testConfig({ RISK_LEVELS: 'auto' }).riskLevels, mode: undefined },
    { mode: undefined, max: 2, level2Multiplier: 10, level3Multiplier: 50, level2Trades: 100, level3Trades: 300, halvePct: 5, haltPct: 10, maxAccountRiskPct: .5 });
  assert.throws(() => testConfig({ RISK_LEVELS: 'max' }), /Invalid RISK_LEVELS/);
  assert.throws(() => testConfig({ RISK_LEVELS: 'auto', RISK_BRAKE_HALVE_PCT: '10' }), /Inconsistent risk level settings/);
  assert.throws(() => testConfig({ RISK_LEVELS: 'auto', RISK_LEVEL3_MIN_TRADES: '100' }), /Inconsistent risk level settings/);
  assert.throws(() => testConfig({ RISK_LEVELS: 'auto', RISK_LEVEL3_MULTIPLIER: '5' }), /Inconsistent risk level settings/);
  assert.throws(() => testConfig({ RISK_LEVELS: 'auto', RISK_LEVEL_MAX: '4' }), /Invalid RISK_LEVEL_MAX/);
  const live = { MODE: 'live', ALPACA_KEY: 'k', ALPACA_SECRET: 's', LIVE_ACK: 'I_ACCEPT_REAL_MONEY_RISK', EXPECTED_ACCOUNT_ID: 'acct', CRYPTO_UNIVERSE: 'off' };
  assert.equal(testConfig(live).riskLevels.mode, 'off');
  assert.throws(() => testConfig({ ...live, RISK_LEVELS: 'auto' }), /limited to demo, shadow and paper/);
});

test('Level 1 sizes exactly like RISK_LEVELS=off; Level 2 sizes ten times larger inside scaled caps', async () => {
  const off = await fixture(), one = await fixture({ RISK_LEVELS: 'auto' }), two = await fixture({ RISK_LEVELS: 'auto', RISK_MAX_ACCOUNT_RISK_PCT: '5' });
  try {
    const a = off.engine.checkEntry(off.prepare()), b = one.engine.checkEntry(one.prepare());
    assert.equal(a.ok, true); assert.equal(b.ok, true); assert.equal(b.qty, a.qty); assert.equal(b.limit, a.limit);
    assert.equal(a.riskLevel, undefined); assert.deepEqual(b.riskLevel, { level: 1, multiplier: 1, brake: 'normal' });
    assert.equal(off.engine.effectiveDailyLoss(), 100); assert.equal(one.engine.effectiveDailyLoss(), 100);
    two.engine.riskLevels.state.levels.range_breakout = 2;
    const c = two.engine.checkEntry(two.prepare());
    assert.equal(c.ok, true); assert.deepEqual(c.riskLevel, { level: 2, multiplier: 10, brake: 'normal' });
    assert.ok(c.qty >= a.qty * 9, `${a.qty} -> ${c.qty}`);
    assert.equal(two.engine.effectiveDailyLoss(), 1000); assert.equal(two.engine.status().limits.effectiveDailyLoss, 1000);
    assert.equal(two.engine.riskLevels.portfolioMultiplier(), 10);
  } finally { await close(off); await close(one); await close(two); }
});

test('no trade risks more than RISK_MAX_ACCOUNT_RISK_PCT of equity, and RISK_LEVEL_MAX caps what was earned', async () => {
  const capped = await fixture({ RISK_LEVELS: 'auto' }), ceiling = await fixture({ RISK_LEVELS: 'auto', RISK_LEVEL_MAX: '1' });
  try {
    capped.engine.riskLevels.state.levels.range_breakout = 2;
    // $10,000 simulated equity at 0.5% allows $50 of stop risk, not Level 2's $100.
    assert.equal(capped.engine.riskLevels.limits('range_breakout', capped.engine.account).risk, 50);
    ceiling.engine.riskLevels.state.levels.range_breakout = 2;
    assert.equal(ceiling.engine.riskLevels.level('range_breakout'), 1);
    assert.deepEqual(ceiling.engine.checkEntry(ceiling.prepare()).riskLevel, { level: 1, multiplier: 1, brake: 'normal' });
  } finally { await close(capped); await close(ceiling); }
});

test('the running code version earns levels from its own journal and records every change', async () => {
  const f = await fixture({ RISK_LEVELS: 'auto' });
  try {
    for (let i = 0; i < 100; i++) f.store.order(closedTrade(i, { code: codeHash, at: f.now() - (200 - i) * 60000 }));
    for (let i = 100; i < 160; i++) f.store.order(closedTrade(i, { code: 'older-code', net: 5, strategy: 'vwap_reversion', at: f.now() - (200 - i) * 60000 }));
    const r = f.engine.riskLevels; r.evaluatedAt = 0; r.tick(f.now(), { unrealized: 0 });
    assert.equal(r.level('range_breakout'), 2); assert.equal(r.level('vwap_reversion'), 1);
    assert.deepEqual(r.strategy('range_breakout'), { level: 2, multiplier: 10, earned: 2, next: null, missing: [], closed: 100, net: 100, ci95: r.evidence.range_breakout.ci95 });
    const changed = f.store.events(50).filter(e => e.type === 'risk_level_changed');
    assert.equal(changed.length, 1); assert.deepEqual([changed[0].data.strategy, changed[0].data.from, changed[0].data.to], ['range_breakout', 1, 2]);
    assert.equal(f.engine.strategyControls.snapshot().strategies.find(s => s.id === 'range_breakout').riskLevel.level, 2);
    // Throttled: a second tick inside 30 seconds does nothing.
    r.state.levels = {}; r.tick(f.now() + 1000, { unrealized: 0 }); assert.equal(r.level('range_breakout'), 1);
  } finally { await close(f); }
});

test('the drawdown brake halves trade size at 5%, stops entries at 10%, and holds until an operator resets it', async () => {
  const f = await fixture({ RISK_LEVELS: 'auto' });
  try {
    const r = f.engine.riskLevels, t = f.now();
    r.updateBrake(0, t); assert.equal(r.state.brake, 'normal');           // budget $10,000
    r.updateBrake(-600, t); assert.equal(r.state.brake, 'halved');        // 6%
    assert.equal(r.limits('range_breakout', f.engine.account).risk, f.cfg.risk / 2);
    assert.equal(f.engine.checkEntry(f.prepare('SPY', 'c-halved')).riskLevel.brake, 'halved');
    r.updateBrake(-300, t); assert.equal(r.state.brake, 'normal');        // back under 5%
    r.updateBrake(-1100, t); assert.equal(r.state.brake, 'halted');       // 11%
    r.updateBrake(0, t); assert.equal(r.state.brake, 'halted');           // a stop holds even after a full recovery
    await f.engine.reconcile();
    assert.ok(f.engine.issues.includes('drawdown_brake'));
    assert.equal(f.engine.checkEntry(f.prepare('SPY', 'c-halted')).reason, 'entries_paused');
    await f.engine.control('reset_drawdown_brake');
    assert.equal(r.state.brake, 'normal'); assert.equal(r.state.peak, r.state.pnl);
    await f.engine.reconcile(); assert.ok(!f.engine.issues.includes('drawdown_brake'));
    assert.deepEqual(f.store.events(50).filter(e => e.type === 'drawdown_brake').map(e => e.data.to).reverse(), ['halved', 'normal', 'halted']);
    assert.equal(f.store.events(50).filter(e => e.type === 'drawdown_brake_reset').length, 1);
    assert.equal(f.store.get('riskLevels').brake, 'normal');
  } finally { await close(f); }
});

test('dashboard: the scorecard route answers and the brake reset needs levels switched on', async () => {
  for (const [env, status] of [[{}, 409], [{ RISK_LEVELS: 'auto' }, 202]]) {
    const f = await fixture(env), server = createDashboard(f.engine, f.cfg);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const origin = `http://127.0.0.1:${server.address().port}`, headers = { Authorization: `Bearer ${f.cfg.token}` };
      const card = await (await fetch(origin + '/api/scorecard', { headers })).json();
      assert.equal(card.codeHash, codeHash); assert.equal(card.riskLevels.mode, env.RISK_LEVELS ?? 'off'); assert.ok(Array.isArray(card.strategies));
      const reset = await fetch(origin + '/api/control', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'reset_drawdown_brake' }) });
      assert.equal(reset.status, status);
    } finally { server.closeStreams?.(); server.close(); await close(f); }
  }
});
