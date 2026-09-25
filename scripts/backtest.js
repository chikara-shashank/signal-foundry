// Walk-forward research backtest of the bar strategies on Alpaca historical bars.
// Signals come from the production Features and assess() code; entries, exits and
// costs are bar approximations, not live execution parity. Short variants apply the same rules to the
// reciprocal price series (mirrored rules), which the live engine cannot trade yet.
//
// node --env-file-if-exists=.env scripts/backtest.js --from 2026-03-23 --to 2026-09-23 --split 2026-07-23 \
//   [--equities SPY,QQQ] [--crypto BTC/USD] [--quotes data/paper.sqlite] [--out data/research/backtest.json]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Features } from '../src/features.js';
import { assess, BAR_STRATEGIES } from '../src/strategies.js';
import { isCrypto, sleep, validBar } from '../src/util.js';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const list = (name, fallback) => arg(name, fallback).split(',').map(s => s.trim()).filter(Boolean);
const FROM = Date.parse(`${arg('from', '2026-03-23')}T00:00:00Z`), TO = Date.parse(`${arg('to', '2026-09-23')}T00:00:00Z`), SPLIT = Date.parse(`${arg('split', '2026-07-23')}T00:00:00Z`);
const EQUITIES = list('equities', 'SPY,QQQ,AAPL,MSFT,NVDA,AMD,AMZN,META,GOOGL,TSLA,PLTR,NKE,LULU'), CRYPTO = list('crypto', 'BTC/USD,ETH/USD');
const OUT = arg('out', `data/research/backtest-${arg('to', '2026-09-23')}.json`), CACHE = arg('cache', 'data/history');
const env = process.env, headers = { 'APCA-API-KEY-ID': env.ALPACA_KEY ?? '', 'APCA-API-SECRET-KEY': env.ALPACA_SECRET ?? '' };
const SLIP = Number(env.SLIPPAGE_BPS ?? 3), EQUITY_FEE = Number(env.EQUITY_FEE_BPS ?? 1), CRYPTO_FEE = Number(env.CRYPTO_FEE_BPS ?? 25);
const MAX_SPREAD = Number(env.MAX_SPREAD_BPS ?? 20), COOLDOWN = Number(env.SYMBOL_COOLDOWN_SECONDS ?? 300) * 1000;
const HOLDS = { equity: [15, 30, 60, 120, 'eod'], crypto: [60, 180, 360, 1440] }, TARGETS = ['prod', '1R', '3R', 'none'];
const PRODUCTION = { equity: { hold: 60, target: 'prod' }, crypto: { hold: 180, target: 'prod' } };

// Median quoted spread per symbol from recorded market samples; the default is used only when none were recorded.
function spreads(files) {
  const found = {};
  for (const file of files) {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite'), db = new DatabaseSync(file, { readOnly: true });
    for (const r of db.prepare("SELECT data FROM events WHERE type='market_sample'").all()) {
      const { bar, quote: q } = JSON.parse(r.data);
      if (q?.bid > 0 && q.ask >= q.bid) (found[bar.symbol] ??= []).push((q.ask - q.bid) / ((q.ask + q.bid) / 2) * 10000);
    }
    db.close();
  }
  return Object.fromEntries(Object.entries(found).filter(([, v]) => v.length >= 30).map(([k, v]) => [k, v.sort((a, b) => a - b)[Math.floor(v.length / 2)]]));
}
const SPREADS = spreads(list('quotes', ''));
const spreadFor = symbol => SPREADS[symbol] ?? (isCrypto(symbol) ? 3 : 2);

async function getJson(url) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (r.status === 429 && attempt < 6) { await sleep(2000 * (attempt + 1)); continue; }
    if (!r.ok) throw new Error(`history_http_${r.status}`);
    return r.json();
  }
}
// One cached file per symbol and calendar month. Split-adjusted so corporate actions do not create false breakouts.
async function history(symbol) {
  const crypto = isCrypto(symbol), bars = [];
  for (let t = FROM; t < TO;) {
    const d = new Date(t), next = Math.min(TO, Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    const file = join(CACHE, `${symbol.replace('/', '-')}_${crypto ? '5Min' : '1Min'}_${new Date(t).toISOString().slice(0, 10)}_${new Date(next).toISOString().slice(0, 10)}.json`);
    let rows;
    if (existsSync(file)) rows = JSON.parse(readFileSync(file, 'utf8'));
    else {
      rows = []; let token = null;
      do {
        const q = new URLSearchParams({ symbols: symbol, timeframe: crypto ? '5Min' : '1Min', start: new Date(t).toISOString(), end: new Date(next - 1).toISOString(), limit: '10000', sort: 'asc', ...(crypto ? {} : { feed: env.ALPACA_FEED ?? 'iex', adjustment: 'split' }) });
        if (token) q.set('page_token', token);
        const body = await getJson(crypto ? `https://data.alpaca.markets/v1beta3/crypto/${env.ALPACA_CRYPTO_LOCATION ?? 'us'}/bars?${q}` : `https://data.alpaca.markets/v2/stocks/bars?${q}`);
        rows.push(...(body.bars?.[symbol] ?? []).map(x => [Date.parse(x.t), x.o, x.h, x.l, x.c, x.v]));
        token = body.next_page_token;
      } while (token);
      mkdirSync(CACHE, { recursive: true }); writeFileSync(file, JSON.stringify(rows));
    }
    for (const [ts, open, high, low, close, volume] of rows) { const b = { symbol, ts, open, high, low, close, volume }; if (validBar(b)) bars.push(b); }
    t = next;
  }
  return bars;
}

// Regular session in New York time; the offset is resolved once per UTC date.
const offsets = new Map();
function nyMinute(ts) {
  const day = Math.floor(ts / 86400000);
  if (!offsets.has(day)) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(day * 86400000 + 12 * 3600000));
    const h = Number(parts.find(p => p.type === 'hour').value); offsets.set(day, (h - 12) * 60);
  }
  return ((Math.floor(ts / 60000) % 1440) + offsets.get(day) + 1440) % 1440;
}
const OPEN = 570, CLOSE = 960; // 09:30 and 16:00

function signals(symbol, bars, side) {
  const crypto = isCrypto(symbol), iv = crypto ? 300000 : 60000, features = new Features(crypto ? 5 : 1), out = [];
  for (let i = 0; i < bars.length - 1; i++) {
    const s = bars[i], b = side === 'long' ? s : { ...s, open: 1 / s.open, high: 1 / s.low, low: 1 / s.high, close: 1 / s.close };
    const now = b.ts + iv, f = features.add(b, now);
    if (!f || f.regime === 'shock') continue;
    // Live entries need an open session with at least ten minutes before the close.
    if (!crypto) { const m = nyMinute(now); if (m <= OPEN || m > CLOSE - 10) continue; }
    for (const strategy of BAR_STRATEGIES) {
      const c = assess(strategy, f, now).candidate;
      if (!c) continue;
      const toPrice = x => side === 'long' ? x : 1 / x, ref = toPrice(c.reference), dist = Math.abs(toPrice(c.stop) - ref);
      out.push({ symbol, strategy, side, i, ts: now, ref, dist, prodTarget: toPrice(c.target), vwap: strategy === 'vwap_reversion' });
    }
  }
  return out;
}

function simulate(sig, bars, hold, targetMode) {
  const crypto = isCrypto(sig.symbol), iv = crypto ? 300000 : 60000, fee = crypto ? CRYPTO_FEE : EQUITY_FEE, spread = spreadFor(sig.symbol);
  const long = sig.side === 'long', dir = long ? 1 : -1, first = bars[sig.i + 1];
  // Entries are 20s limit orders: the next bar must exist and the price must not have moved 30 bps.
  if (!first || first.ts !== bars[sig.i].ts + iv || Math.abs(first.open / sig.ref - 1) * 10000 > 30) return null;
  if (spread > MAX_SPREAD) return { gated: 'spread_limit' };
  const edge = (spread / 2 + SLIP) / 10000, entry = first.open * (1 + dir * edge);
  const stop = sig.ref - dir * sig.dist;
  const target = targetMode === 'prod' ? sig.prodTarget : targetMode === '1R' ? sig.ref + dir * sig.dist : targetMode === '3R' ? sig.ref + dir * 3 * sig.dist : null;
  const cost = entry * (2 * (fee + SLIP) + spread) / 10000, gate = target ?? sig.prodTarget;
  if (dir * (gate - entry) < 2 * cost) return { gated: 'reward_does_not_clear_cost_buffer' };
  if (dir * (stop - entry) >= 0) return { gated: 'invalid_bracket' };
  const deadline = hold === 'eod' ? Infinity : sig.ts + hold * 60000;
  let exit = null, reason = null, j = sig.i + 1;
  for (; j < bars.length; j++) {
    const b = bars[j];
    if (b.ts - bars[j - 1].ts > 6 * 3600000) { exit = bars[j - 1].close; reason = 'data_gap'; break; }
    if (!crypto && nyMinute(b.ts) >= CLOSE - 5) { exit = b.open; reason = 'session_end'; break; }
    const hitStop = long ? b.low <= stop : b.high >= stop, hitTarget = target !== null && (long ? b.high > target : b.low < target);
    if (hitStop) { exit = long ? Math.min(stop, b.open) : Math.max(stop, b.open); reason = 'stop'; break; } // Stop first when both touch.
    if (hitTarget) { exit = long ? Math.max(target, b.open) : Math.min(target, b.open); reason = 'target'; break; }
    if (b.ts + iv >= deadline) { exit = b.close; reason = 'time'; break; }
  }
  if (exit === null) return null;
  const exitFill = reason === 'target' ? exit : exit * (1 - dir * edge);
  const net = dir * (exitFill / entry - 1) * 10000 - 2 * fee, gross = dir * (exit / first.open - 1) * 10000;
  return { ts: sig.ts, exitTs: bars[j].ts + iv, net, gross, reason };
}

const stats = xs => {
  const n = xs.length; if (!n) return { n: 0 };
  const net = xs.map(x => x.net), mean = net.reduce((a, b) => a + b, 0) / n, sd = n > 1 ? Math.sqrt(net.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const exits = {}; for (const x of xs) exits[x.reason] = (exits[x.reason] ?? 0) + 1;
  return { n, meanNetBps: +mean.toFixed(2), meanGrossBps: +(xs.reduce((a, x) => a + x.gross, 0) / n).toFixed(2), tStat: sd ? +(mean / (sd / Math.sqrt(n))).toFixed(2) : null,
    winRate: +(net.filter(x => x > 0).length / n).toFixed(3), totalNetBps: +net.reduce((a, b) => a + b, 0).toFixed(0), exits };
};

const results = new Map(), baseline = new Map(), gated = {};
const add = (map, key, trade) => { if (!map.has(key)) map.set(key, []); map.get(key).push(trade); };
for (const symbol of [...EQUITIES, ...CRYPTO]) {
  const started = performance.now(), bars = await history(symbol), asset = isCrypto(symbol) ? 'crypto' : 'equity';
  let count = 0;
  for (const side of ['long', 'short']) {
    const sigs = signals(symbol, bars, side); count += sigs.length;
    for (const strategy of BAR_STRATEGIES) for (const hold of HOLDS[asset]) for (const targetMode of TARGETS) {
      let busyUntil = 0, lastEntry = -Infinity;
      for (const sig of sigs) {
        if (sig.strategy !== strategy) continue;
        // One position per symbol and strategy, plus the live per-symbol entry cooldown.
        if (sig.ts < busyUntil || sig.ts - lastEntry < COOLDOWN) continue;
        const t = simulate(sig, bars, hold, targetMode);
        if (!t) continue;
        if (t.gated) { gated[`${asset}|${sig.strategy}|${t.gated}`] = (gated[`${asset}|${sig.strategy}|${t.gated}`] ?? 0) + 1; continue; }
        busyUntil = t.exitTs; lastEntry = sig.ts;
        add(results, `${asset}|${sig.strategy}|${side}|${hold}|${targetMode}|${t.ts < SPLIT ? 'IS' : 'OOS'}`, t);
      }
    }
    // Unconditional baseline: an entry every 15 minutes, time exit only, identical costs.
    for (const hold of HOLDS[asset]) {
      const step = isCrypto(symbol) ? 3 : 15;
      for (let i = 0; i < bars.length - 1; i += step) {
        const now = bars[i].ts + (isCrypto(symbol) ? 300000 : 60000);
        if (asset === 'equity') { const m = nyMinute(now); if (m <= OPEN || m > CLOSE - 10) continue; }
        const t = simulate({ symbol, side, i, ts: now, ref: bars[i].close, dist: bars[i].close * 0.5, prodTarget: bars[i].close * (side === 'long' ? 10 : 0.1) }, bars, hold, 'none');
        if (t && !t.gated) add(baseline, `${asset}|${side}|${hold}|${t.ts < SPLIT ? 'IS' : 'OOS'}`, t);
      }
    }
  }
  console.error(`${symbol.padEnd(8)} ${String(bars.length).padStart(7)} bars ${String(count).padStart(6)} signals ${((performance.now() - started) / 1000).toFixed(1)}s`);
}

// Pick each strategy/side variant on the in-sample period only, then report its untouched out-of-sample result.
const rows = [];
for (const asset of ['equity', 'crypto']) for (const strategy of BAR_STRATEGIES) for (const side of ['long', 'short']) {
  const variants = HOLDS[asset].flatMap(hold => TARGETS.map(target => {
    const is = stats(results.get(`${asset}|${strategy}|${side}|${hold}|${target}|IS`) ?? []), oos = stats(results.get(`${asset}|${strategy}|${side}|${hold}|${target}|OOS`) ?? []);
    const all = stats([...(results.get(`${asset}|${strategy}|${side}|${hold}|${target}|IS`) ?? []), ...(results.get(`${asset}|${strategy}|${side}|${hold}|${target}|OOS`) ?? [])]);
    return { asset, strategy, side, hold, target, is, oos, all };
  }));
  const eligible = variants.filter(v => v.is.n >= 30 && v.is.tStat !== null);
  const chosen = eligible.sort((a, b) => b.is.tStat - a.is.tStat)[0] ?? null;
  const production = side === 'long' ? variants.find(v => v.hold === PRODUCTION[asset].hold && v.target === PRODUCTION[asset].target) : null;
  const promotable = !!chosen && chosen.is.meanNetBps > 0 && chosen.oos.n >= 20 && chosen.oos.meanNetBps > 0 && chosen.all.tStat >= 2;
  rows.push({ asset, strategy, side, variantsTested: variants.length, production, chosen, exploratoryScreenPassed:promotable, promotable:false });
}
const baselineRows = [...baseline.entries()].map(([k, v]) => { const [asset, side, hold, period] = k.split('|'); return { asset, side, hold, period, ...stats(v) }; });
const report = {
  liveEligible:false, evidenceClass:'exploratory_independent_bar_paths',
  generatedAt: new Date().toISOString(), period: { from: new Date(FROM).toISOString(), to: new Date(TO).toISOString(), outOfSampleFrom: new Date(SPLIT).toISOString() },
  universe: { equities: EQUITIES, crypto: CRYPTO }, costs: { slippageBpsPerSide: SLIP, equityFeeBpsPerSide: EQUITY_FEE, cryptoFeeBpsPerSide: CRYPTO_FEE, spreadsBps: Object.fromEntries([...EQUITIES, ...CRYPTO].map(s => [s, +spreadFor(s).toFixed(2)])) },
  rule: 'Variant chosen by in-sample t-statistic (n>=30). Legacy promotable flags are exploratory screen results only: no live qualification, portfolio replay, exchange calendar or prospective registration is established by this report.',
  limitations: ['1-minute bars: intrabar order of stop and target is unknown, so stop is assumed first.', 'Entry at the next bar open plus half the median quoted spread and slippage; no queue or impact model.', 'Short variants mirror the long rules on reciprocal prices; borrow availability and fees are not modeled.', 'Selection among many variants inflates in-sample results; only the untouched out-of-sample column is evidence.'],
  strategies: rows, baseline: baselineRows, gated,
};
mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(report, null, 2));
const fmt = s => s?.n ? `${String(s.n).padStart(5)} ${s.meanNetBps.toFixed(1).padStart(7)} ${String(s.tStat ?? '').padStart(6)} ${(s.winRate * 100).toFixed(0).padStart(3)}%` : '    0       -      -    -';
console.log('asset  strategy              side  | production IS: n net t win | production OOS          | chosen hold/target | chosen IS               | chosen OOS              | promote');
for (const r of rows) console.log(`${r.asset.padEnd(6)} ${r.strategy.padEnd(21)} ${r.side.padEnd(5)} | ${fmt(r.production?.is)} | ${fmt(r.production?.oos)} | ${r.chosen ? `${String(r.chosen.hold).padStart(4)}m ${r.chosen.target.padEnd(4)}` : '     -    '}         | ${fmt(r.chosen?.is)} | ${fmt(r.chosen?.oos)} | ${r.promotable ? 'YES' : 'no'}`);
console.log('\nbaseline (entry every 15m, time exit only)');
for (const b of baselineRows.filter(b => b.period === 'OOS')) console.log(`${b.asset.padEnd(6)} ${b.side.padEnd(5)} hold ${String(b.hold).padStart(4)} OOS ${fmt(b)} gross ${b.meanGrossBps}`);
console.log(`\nreport: ${OUT}`);
