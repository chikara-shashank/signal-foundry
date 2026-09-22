import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../src/config.js';
import { AlpacaBroker } from '../src/broker.js';

// Never log provider bodies, headers, exception messages, or account IDs.
export function providerFailure(error) {
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) {
    const hint = error.status === 401 ? 'Credentials were rejected; check the key/secret pair and paper versus live account.'
      : error.status === 403 ? 'Access was denied; check credentials and account permissions.'
      : error.status === 429 ? 'Rate limit reached; wait before retrying.'
      : error.status >= 500 ? 'Provider service error; retry later.' : 'Provider rejected this read request.';
    return `HTTP ${error.status}. ${hint}`;
  }
  const hints = {
    ENOTFOUND: 'DNS lookup failed inside the container.', EAI_AGAIN: 'Temporary DNS lookup failure.',
    ECONNREFUSED: 'Connection refused; check Docker networking, VPN, firewall, and provider availability.',
    ECONNRESET: 'Connection reset; check the network or proxy.',
    ETIMEDOUT: 'Connection timed out.', UND_ERR_CONNECT_TIMEOUT: 'Connection timed out.',
    UND_ERR_HEADERS_TIMEOUT: 'Timed out waiting for response headers.', UND_ERR_BODY_TIMEOUT: 'Timed out reading the response.',
    CERT_HAS_EXPIRED: 'TLS certificate expired; check system time and any corporate proxy.',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS certificate verification failed; check the trusted certificate configuration.',
    SELF_SIGNED_CERT_IN_CHAIN: 'TLS certificate verification failed; check the trusted certificate configuration.',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS certificate verification failed; check the trusted certificate configuration.',
    ERR_TLS_CERT_ALTNAME_INVALID: 'TLS certificate hostname mismatch.',
    ERR_INVALID_CHAR: 'Invalid character in request headers; check copied credentials.',
  };
  const queue = [error];
  for (let i = 0; i < queue.length && i < 12; i++) {
    const e = queue[i];
    if (!e || typeof e !== 'object') continue;
    if (Object.hasOwn(hints, e.code)) return `${e.code}. ${hints[e.code]}`;
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'Request timed out before completion.';
    if (e.cause) queue.push(e.cause);
    if (Array.isArray(e.errors)) queue.push(...e.errors.slice(0, 4));
  }
  return error?.name === 'SyntaxError' ? 'Provider response was not valid JSON.' : 'Request failed without an HTTP status; check network connectivity and response format.';
}

export async function runDoctor(cfg, { fetchFn = fetch, log = console.log } = {}) {
  log(`Configuration valid. Mode=${cfg.mode}; equities=${cfg.equities.length}; crypto=${cfg.crypto.length}; Jev=${cfg.jevMode}`);
  if (cfg.mode === 'demo') {
    log('MODE=demo uses synthetic data and ignores Alpaca keys. Use MODE=paper with paper-account keys for real prices and simulated-money execution.');
    return true;
  }
  log(`Alpaca endpoint: ${cfg.brokerUrl}. Running read-only checks.`);
  const broker = new AlpacaBroker(cfg, fetchFn);
  const checks = [
    { label: 'Alpaca account /v2/account', run: () => broker.account(Date.now()) },
    { label: 'Alpaca clock /v2/clock', run: () => broker.clock(Date.now()) },
    { label: 'Alpaca assets /v2/assets', run: () => broker.assets() },
  ];
  if (cfg.jevMode !== 'off') checks.push({ label: 'Jev models /v1/models', run: async () => {
    const response = await fetchFn('https://api.typesafe.ai/v1/models', {
      method: 'GET', headers: { Authorization: `Bearer ${cfg.jevKey}` },
      redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    await response.body?.cancel();
    if (!response.ok) throw Object.assign(new Error('Provider rejected read check'), { status: response.status });
  } });
  const results = await Promise.allSettled(checks.map(check => check.run()));
  let passed = true;
  for (let i = 0; i < checks.length; i++) {
    const result = results[i];
    if (result.status === 'rejected') {
      passed = false; log(`FAIL ${checks[i].label}: ${providerFailure(result.reason)}`);
    } else log(`OK ${checks[i].label}`);
  }
  if (results[0].status === 'fulfilled') {
    const account = results[0].value;
    if (account.blocked) { passed = false; log('FAIL Alpaca account is not active or is blocked for trading. Check the account dashboard.'); }
    if (cfg.mode === 'live' && account.id !== cfg.expectedAccount) { passed = false; log('FAIL Expected account ID does not match.'); }
  }
  if (results[1].status === 'fulfilled') {
    const session = results[1].value;
    log(`Equity session open=${session.open}; a closed session does not mean authentication failed.`);
    if (Number.isFinite(session.providerTime)) {
      const offset = session.providerTime - session.ts;
      log(`Alpaca clock versus host: approximately ${(offset / 1000).toFixed(2)}s (includes request latency). v1.3 calibrates the engine clock from this endpoint; quote timestamps are retained.`);
      if (Math.abs(offset) > 300000) { passed = false; log('FAIL Host clock differs by over five minutes. Synchronize the operating system clock before starting.'); }
    }
  }
  if (results[2].status === 'fulfilled') {
    const missing = cfg.symbols.filter(symbol => !results[2].value.get(symbol)?.tradable);
    if (missing.length) { passed = false; log(`FAIL Unavailable assets: ${missing.join(',')}`); }
  }
  log('No order was submitted. Streaming entitlement and Jev inference are separate checks after startup.');
  log(passed ? 'Read-only checks passed. Start the engine with docker compose up -d --force-recreate --wait --wait-timeout 180.'
    : 'Read-only checks failed. Correct the FAIL items above, then rerun doctor before starting the engine.');
  return passed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let cfg;
  try { cfg = config(); }
  catch (error) {
    console.error(/^(Invalid |Set |Live |ALPACA_|TYPESAFE_|Demo forbids|Empty universe|Universe exceeds|Inconsistent |LIVE_|HEARTBEAT_URL)/.test(error.message)
      ? error.message : 'Configuration could not be loaded; check the .env settings.');
    process.exitCode = 1;
  }
  if (cfg) {
    try { process.exitCode = await runDoctor(cfg) ? 0 : 1; }
    catch { console.error('Diagnostic failed unexpectedly; no provider details were logged.'); process.exitCode = 1; }
  }
}
