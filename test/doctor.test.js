import test from 'node:test';
import assert from 'node:assert/strict';
import { runDoctor, providerFailure } from '../scripts/doctor.js';
import { testConfig } from './helpers.js';

const cfg = () => testConfig({ MODE: 'paper', ALPACA_KEY: 'secret-key-canary', ALPACA_SECRET: 'secret-value-canary',
  JEV_MODE: 'shadow', TYPESAFE_API_KEY: 'jev-key-canary', EQUITY_SYMBOLS: 'SPY', CRYPTO_SYMBOLS: 'BTC/USD' });
const goodFetch = async (url, options) => {
  assert.equal(options.method, 'GET');
  assert.equal(options.redirect, 'error');
  const path = new URL(url).pathname;
  const body = path === '/v2/account' ? { id: 'private-account-id', status: 'ACTIVE', cash: '1000', equity: '1000', buying_power: '1000' }
    : path === '/v2/clock' ? { is_open: false, next_close: '2026-09-23T20:00:00Z' }
    : path === '/v2/assets' ? [{ symbol: 'SPY', tradable: true }, { symbol: 'BTCUSD', tradable: true }] : {};
  return Response.json(body);
};

test('doctor performs only GET checks, omits private details and accepts a closed session', async () => {
  const lines = [];
  assert.equal(await runDoctor(cfg(), { fetchFn: goodFetch, log: line => lines.push(line) }), true);
  const output = lines.join('\n');
  assert.match(output, /OK Alpaca account/);
  assert.match(output, /OK Jev models/);
  assert.match(output, /session open=false/);
  assert.doesNotMatch(output, /canary|private-account-id/);
});

test('doctor identifies an Alpaca HTTP failure and still reports other independent checks', async () => {
  const lines = [];
  const fetchFn = async (url, options) => new URL(url).pathname === '/v2/account'
    ? new Response('secret-key-canary must not be logged', { status: 401 }) : goodFetch(url, options);
  assert.equal(await runDoctor(cfg(), { fetchFn, log: line => lines.push(line) }), false);
  const output = lines.join('\n');
  assert.match(output, /FAIL Alpaca account \/v2\/account: HTTP 401/);
  assert.match(output, /OK Alpaca clock/);
  assert.match(output, /OK Jev models/);
  assert.doesNotMatch(output, /canary/);
});

test('doctor isolates Jev authorization failure and redacts transport exception messages', async () => {
  const lines = [];
  const fetchFn = async (url, options) => new URL(url).hostname === 'api.typesafe.ai'
    ? new Response('jev-key-canary', { status: 403 }) : goodFetch(url, options);
  assert.equal(await runDoctor(cfg(), { fetchFn, log: line => lines.push(line) }), false);
  assert.match(lines.join('\n'), /FAIL Jev models \/v1\/models: HTTP 403/);
  assert.doesNotMatch(lines.join('\n'), /canary/);
  const nested = new TypeError('secret-value-canary', { cause: Object.assign(new Error('secret-key-canary'), { code: 'ENOTFOUND' }) });
  assert.match(providerFailure(nested), /^ENOTFOUND/);
  assert.doesNotMatch(providerFailure(nested), /canary/);
  assert.doesNotMatch(providerFailure(Object.assign(new Error('canary'), { code: 'canary' })), /canary/);
  assert.match(providerFailure(new DOMException('canary', 'TimeoutError')), /timed out/);
});

test('doctor skips all provider calls in demo and fails a blocked account', async () => {
  let called = false;
  assert.equal(await runDoctor(testConfig(), { fetchFn: async () => { called = true; }, log: () => {} }), true);
  assert.equal(called, false);
  const fetchFn = async (url, options) => new URL(url).pathname === '/v2/account'
    ? Response.json({ status: 'ACCOUNT_UPDATED', id: 'private-account-id', cash: 1000, equity: 1000 }) : goodFetch(url, options);
  const lines = [];
  assert.equal(await runDoctor(cfg(), { fetchFn, log: line => lines.push(line) }), false);
  assert.match(lines.join('\n'), /not active or is blocked/);
});
