import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname } from 'node:path';

// Small, read-only provenance and entitlement check. Never print credentials or
// provider error bodies. These fixed requests do not start an engine or place orders.
const headers = { 'APCA-API-KEY-ID': process.env.ALPACA_KEY, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET };
if (!headers['APCA-API-KEY-ID'] || !headers['APCA-API-SECRET-KEY']) throw new Error('Alpaca credentials required');
const report = { observedAt: new Date().toISOString(), checks: [], liveEligible: false };
for (const [name, path] of [
  ['opra_latest', '/v1beta1/options/quotes/latest?symbols=SPY261016C00700000&feed=opra'],
  ['historical_option_quotes', '/v1beta1/options/quotes?symbols=SPY260918C00650000&start=2026-09-17T14:00:00Z&end=2026-09-17T14:01:00Z&limit=1'],
  ['historical_option_trades', '/v1beta1/options/trades?symbols=SPY260918C00650000&start=2026-09-17T14:00:00Z&end=2026-09-17T14:01:00Z&limit=1'],
  ['equity_cache_spot_check', '/v2/stocks/SPY/bars?timeframe=1Min&start=2026-09-01T13:30:00Z&end=2026-09-01T13:31:00Z&adjustment=all&feed=sip&limit=2'],
]) {
  try {
    const response = await fetch('https://data.alpaca.markets' + path, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
    const body = response.ok ? await response.json() : {};
    const row = { name, status: response.status };
    if (name === 'opra_latest') row.quoteCount = Object.keys(body.quotes ?? {}).length;
    if (name === 'historical_option_trades') row.tradeCount = Object.values(body.trades ?? {}).flat().length;
    if (name === 'equity_cache_spot_check' && response.ok) {
      const cached = JSON.parse(gunzipSync(readFileSync('data/history/session/SPY_2026-09.json.gz')))['2026-09-01'][0];
      const b = body.bars?.find(x => Date.parse(x.t) === Date.parse('2026-09-01T13:30:00Z'));
      row.matchesCache = !!b && [b.o,b.h,b.l,b.c,b.v].every((v,i) => v === cached[i+1]);
    }
    report.checks.push(row);
  } catch (error) { report.checks.push({ name, error: error.name }); }
}
report.optionsVerdict = 'BLOCKED_MISSING_HISTORICAL_EXECUTABLE_QUOTES_AND_POINT_IN_TIME_CHAIN';
report.note = 'Historical trades do not supply two-leg bid/ask, contemporaneous Greeks, OI or assignment outcomes. This probe does not validate a strategy.';
const file = 'data/research/data-check-2026-09-25.json'; mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
