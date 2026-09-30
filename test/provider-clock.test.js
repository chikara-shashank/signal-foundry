import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderClock } from '../src/provider-clock.js';
import { AlpacaBroker } from '../src/broker.js';
import { validateQuote } from '../src/util.js';
import { fixture, quote, testConfig } from './helpers.js';

function clockFixture() {
  const utc = Date.parse('2026-09-22T15:00:00Z'); let elapsed = 100, jump = 0;
  const clock = new ProviderClock({ wall: () => utc - 18000 + elapsed + jump, mono: () => elapsed });
  return { clock, utc, advance: ms => { elapsed += ms; }, jump: ms => { jump += ms; }, elapsed: () => elapsed };
}

function suspensionFixture(utc = Date.parse('2026-09-22T15:00:00Z')) {
  let wall = utc, mono = 0;
  const clock = new ProviderClock({ wall: () => wall, mono: () => mono });
  const sample = (offset = 0, rtt = 0) => clock.observe(new Date(wall + offset).toISOString(), mono - rtt, mono);
  assert.equal(sample(), true);
  return { clock, sample, wall: () => wall, mono: () => mono,
    advance: ms => { wall += ms; mono += ms; }, suspend: ms => { wall += ms; } };
}

test('18-second host lag is calibrated without changing quote timestamps or freshness limits', () => {
  const f = clockFixture();
  assert.equal(f.clock.status().synchronized, false);
  assert.equal(f.clock.observe(new Date(f.utc + 50).toISOString(), 0, 100), true);
  assert.equal(f.clock.status().offsetMs, 18000);
  assert.equal(validateQuote(quote('SPY', f.utc + 50), f.clock.now(), 5000), true);
  assert.equal(validateQuote(quote('SPY', f.utc - 10000), f.clock.now(), 5000), false);
  assert.equal(validateQuote(quote('SPY', f.utc + 2000), f.clock.now(), 5000), false);
  f.advance(700); f.jump(18000);
  assert.equal(f.clock.now(), f.utc + 800); assert.equal(f.clock.status().offsetMs, 0);
});

test('clock samples expire, excessive RTT and inconsistent provider clocks block entries', () => {
  const f = clockFixture();
  f.clock.observe(new Date(f.utc + 50).toISOString(), 0, 100);
  f.advance(60001); assert.equal(f.clock.status().reason, 'provider_clock_sample_expired');
  assert.equal(f.clock.observe(new Date(f.utc + f.elapsed()).toISOString(), f.elapsed() - 1500), false);
  assert.equal(f.clock.status().reason, 'provider_clock_request_too_slow');
  assert.equal(f.clock.observe(new Date(f.utc + f.elapsed() + 3000).toISOString(), f.elapsed()), false);
  assert.equal(f.clock.status().reason, 'provider_clock_discontinuity');
  assert.equal(f.clock.observe(new Date(f.utc + f.elapsed() - 50).toISOString(), f.elapsed() - 100), true);
  assert.equal(f.clock.status().synchronized, true);
  f.jump(400000);
  assert.equal(f.clock.observe(new Date(f.utc + f.elapsed()).toISOString(), f.elapsed()), false);
  assert.equal(f.clock.status().reason, 'host_clock_skew_exceeds_five_minutes');
});

test('invalid samples fail closed and small corrections never turn time backwards', () => {
  const f = clockFixture();
  assert.equal(f.clock.observe('invalid', 0), false);
  f.clock.observe(new Date(f.utc + 50).toISOString(), 0, 100);
  const before = f.clock.now();
  f.clock.observe(new Date(f.utc + 20).toISOString(), 100, 100);
  assert.equal(f.clock.now(), before); f.advance(100); assert.equal(f.clock.now(), f.utc + 120);
});

test('Alpaca clock adapter uses the authenticated response timestamp', async () => {
  const f = clockFixture();
  const broker = new AlpacaBroker(testConfig(), async (url, opts) => {
    assert.ok(url.endsWith('/v2/clock')); assert.equal(opts.redirect, 'error');
    f.advance(80);
    return new Response(JSON.stringify({ is_open: true, next_close: '2026-09-22T20:00:00Z', timestamp: new Date(f.utc + 140).toISOString() }));
  }, f.clock);
  const session = await broker.clock(f.clock.now());
  assert.equal(session.ts, f.utc + 180); assert.equal(f.clock.status().offsetMs, 18000);
});

test('an expired clock blocks a candidate even between reconciliations', async () => {
  const f = await fixture();
  try {
    f.engine.timebase = { status: () => ({ synchronized: false, reason: 'provider_clock_sample_expired' }) };
    const c = f.prepare(); await f.engine.mutex.run(() => f.engine.enter(c));
    assert.equal(c.reason, 'clock_not_synchronized'); assert.equal(f.store.orders().length, 0);
    assert.equal(f.engine.status().ready, false);
    assert.ok(f.engine.status().issues.includes('clock_not_synchronized'));
    await f.engine.reconcile(); assert.ok(f.engine.issues.includes('clock_not_synchronized'));
  } finally { f.store.close(); }
});

test('a 25-hour suspension recovers after two provider reads without weakening quote checks', () => {
  const f = suspensionFixture(), before = f.clock.now();
  f.suspend(25 * 3600000);
  assert.equal(f.clock.status().synchronized, false);
  assert.equal(f.clock.status().reason, 'clock_elapsed_discontinuity');
  assert.equal(f.sample(), false);
  assert.equal(f.clock.status().reason, 'provider_clock_discontinuity');
  assert.equal(f.clock.now(), before);
  const current = quote('SPY', f.wall());
  assert.equal(validateQuote(current, f.clock.now(), 5000), false);
  f.advance(5000);
  assert.equal(f.sample(), true);
  assert.equal(f.clock.status().synchronized, true);
  assert.equal(f.clock.now(), f.wall());
  assert.equal(validateQuote(current, f.clock.now(), 5000), true);
  assert.equal(current.ts, before + 25 * 3600000);
  assert.equal(validateQuote(quote('SPY', f.wall() - 5001), f.clock.now(), 5000), false);
  assert.equal(validateQuote(quote('SPY', f.wall() + 1001), f.clock.now(), 5000), false);
});

test('invalid, slow and host-skewed samples reset recovery confirmation', () => {
  for (const invalid of [
    f => f.clock.observe('invalid', f.mono(), f.mono()),
    f => f.sample(0, 1001),
    f => f.sample(300001),
  ]) {
    const f = suspensionFixture();
    f.suspend(25 * 3600000);
    assert.equal(f.sample(), false);
    f.advance(5000);
    assert.equal(invalid(f), false);
    assert.equal(f.clock.status().synchronized, false);
    f.advance(5000);
    assert.equal(f.sample(), false);
    f.advance(5000);
    assert.equal(f.sample(), true);
  }
});

test('recovery requires separated, recent, consistent reads across uninterrupted elapsed time', () => {
  for (const disrupt of [
    f => f.sample(), // Same instant is not a second independent observation.
    f => { f.advance(60001); return f.sample(); },
    f => { f.advance(5000); return f.sample(3000); },
    f => { f.advance(5000); f.suspend(10000); return f.sample(); },
  ]) {
    const f = suspensionFixture();
    f.suspend(25 * 3600000);
    assert.equal(f.sample(), false);
    assert.equal(disrupt(f), false);
    assert.equal(f.clock.status().synchronized, false);
    f.advance(5000);
    // An inconsistent provider timestamp must itself be replaced before recovery.
    if (!f.sample()) { f.advance(5000); assert.equal(f.sample(), true); }
    assert.equal(f.clock.status().synchronized, true);
    assert.equal(f.clock.now(), f.wall());
  }
});

test('backward provider jumps stay blocked and never roll the trading clock back', () => {
  const f = suspensionFixture(), before = f.clock.now();
  assert.equal(f.sample(-3000), false);
  f.advance(5000);
  assert.equal(f.sample(-3000), false);
  assert.equal(f.clock.status().synchronized, false);
  assert.ok(f.clock.now() >= before);
  assert.equal(f.sample(), true);
});

test('a wall-clock correction blocks entries until the next valid provider calibration', () => {
  const f = clockFixture();
  f.clock.observe(new Date(f.utc + 50).toISOString(), 0, 100);
  f.jump(18000);
  assert.equal(f.clock.status().synchronized, false);
  assert.equal(f.clock.observe(new Date(f.utc + f.elapsed()).toISOString(), f.elapsed()), true);
  assert.equal(f.clock.status().synchronized, true);
  assert.equal(f.clock.status().offsetMs, 0);
});

test('engine blocks entries throughout suspension recovery and reports one clock blocker', async () => {
  const f = await fixture(), time = suspensionFixture(f.now()), duration = 25 * 3600000;
  try {
    f.engine.timebase = time.clock; f.engine.clock = () => time.clock.now();
    const c = f.prepare();
    time.suspend(duration);
    await f.engine.mutex.run(() => f.engine.enter(c));
    assert.equal(c.reason, 'clock_not_synchronized');
    assert.equal(f.store.orders().length, 0);
    await f.engine.reconcile();
    assert.equal(f.engine.status().entryReady, false);
    assert.equal(f.engine.status().entryBlockers.filter(x => x === 'clock_not_synchronized').length, 1);
    assert.equal(time.sample(), false);
    assert.equal(f.engine.status().entryReady, false);
    time.advance(5000); f.advance(duration + 5000);
    assert.equal(time.sample(), true);
    await f.engine.reconcile();
    f.prepare('SPY', 'after-recovery');
    assert.equal(f.engine.status().entryReady, true);
    assert.equal(f.engine.status().entryBlockers.includes('clock_not_synchronized'), false);
  } finally { await f.engine.mutex.tail; f.store.close(); }
});
