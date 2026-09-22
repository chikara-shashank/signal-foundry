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
