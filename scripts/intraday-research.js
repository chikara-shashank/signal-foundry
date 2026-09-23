// Pre-specified tests of published intraday strategies on Alpaca SIP history.
// Every rule and parameter comes from the cited paper; nothing is fitted to this data.
// Results: docs/INTRADAY-RESEARCH-2026-09.md.
//
// node --env-file=.env scripts/intraday-research.js [--study all|momentum|noise|orb|inplay|fetch]
//   [--from 2016-01-04] [--to 2026-09-23] [--inplay-from 2024-09-23] [--symbols SPY,QQQ] [--out data/research/intraday.json]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { sleep } from '../src/util.js';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const STUDY = arg('study', 'all'), FROM = arg('from', '2016-01-04'), TO = arg('to', '2026-09-23'), INPLAY_FROM = arg('inplay-from', '2024-09-23');
const SYMBOLS = arg('symbols', 'SPY,QQQ').split(','), CACHE = arg('cache', 'data/history'), OUT = arg('out', `data/research/intraday-${TO}.json`);
const headers = { 'APCA-API-KEY-ID': process.env.ALPACA_KEY ?? '', 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET ?? '' };
const FEED = process.env.ALPACA_FEED ?? 'sip';
// Costs per side in bps. "engine" is the live configuration (3 bps slippage, 1 bps fee);
// "low" approximates commission-free execution of liquid names (1 bps slippage, no fee).
const SCENARIOS = { engine: { slip: 3, fee: 1 }, low: { slip: 1, fee: 0 } };
const HALF_SPREAD = { SPY: 0.13, QQQ: 0.14 }, INPLAY_HALF_SPREAD = { engine: 2, low: 1 };

// ---------- data ----------
async function getJson(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(60000) });
      if ((r.status === 429 || r.status >= 500) && attempt < 6) { await sleep(2000 * (attempt + 1)); continue; }
      if (!r.ok) throw Object.assign(new Error(`http_${r.status}`), { fatal: true });
      return await r.json();
    } catch (error) { if (error.fatal || attempt >= 6) throw error; await sleep(2000 * (attempt + 1)); }
  }
}
async function cached(file, make) {
  if (existsSync(file)) { const raw = readFileSync(file); return JSON.parse(file.endsWith('.gz') ? gunzipSync(raw) : raw); }
  const value = await make(); mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, file.endsWith('.gz') ? gzipSync(JSON.stringify(value)) : JSON.stringify(value)); return value;
}
async function pool(items, width, fn) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: width }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } }));
  return out;
}
const nyOffset = date => { // minutes, e.g. -240 for EDT
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit' }).formatToParts(new Date(`${date}T12:00:00Z`));
  return (Number(parts.find(p => p.type === 'hour').value) - 12) * 60;
};
const utcAt = (date, hhmm) => { const [h, m] = hhmm.split(':').map(Number); const [y, mo, d] = date.split('-').map(Number); return Date.UTC(y, mo - 1, d, h, m) - nyOffset(date) * 60000; };
async function calendar(from, to) {
  const rows = await cached(join(CACHE, `calendar_${from}_${to}.json`), () => getJson(`https://paper-api.alpaca.markets/v2/calendar?start=${from}&end=${to}`));
  return rows.map(r => ({ date: r.date, open: utcAt(r.date, r.open), close: utcAt(r.date, r.close) })).filter(d => d.close - d.open >= 180 * 60000);
}
// Regular-session 1-minute bars for one symbol, month by month: [minute, open, high, low, close, volume, vwap] per day.
async function sessionBars(symbol, days) {
  const months = new Map(); for (const d of days) { const k = d.date.slice(0, 7); if (!months.has(k)) months.set(k, []); months.get(k).push(d); }
  const byDay = new Map();
  await pool([...months.entries()], 4, async ([month, list]) => {
    const file = join(CACHE, 'session', `${symbol}_${month}.json.gz`), complete = list.at(-1).date < TO;
    const load = async () => {
      const rows = []; let token = null;
      do {
        const q = new URLSearchParams({ symbols: symbol, timeframe: '1Min', start: new Date(list[0].open).toISOString(), end: new Date(list.at(-1).close - 1).toISOString(), feed: FEED, adjustment: 'all', limit: '10000', sort: 'asc' });
        if (token) q.set('page_token', token);
        const body = await getJson(`https://data.alpaca.markets/v2/stocks/bars?${q}`);
        rows.push(...(body.bars?.[symbol] ?? []).map(x => [Date.parse(x.t), x.o, x.h, x.l, x.c, x.v, x.vw]));
        token = body.next_page_token;
      } while (token);
      const out = {};
      for (const d of list) out[d.date] = rows.filter(r => r[0] >= d.open && r[0] < d.close).map(([ts, ...rest]) => [(ts - d.open) / 60000, ...rest]);
      return out;
    };
    const data = complete ? await cached(file, load) : await load();
    for (const d of list) byDay.set(d.date, data[d.date] ?? []);
  });
  return byDay;
}

// ---------- statistics ----------
function summarize(trades, days) {
  const n = trades.length; if (!n) return { trades: 0 };
  const net = trades.map(t => t.net), mean = net.reduce((a, b) => a + b, 0) / n, sd = Math.sqrt(net.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const daily = new Map(); for (const t of trades) daily.set(t.date, (daily.get(t.date) ?? 0) + t.net / (t.weight ?? 1));
  const series = days.map(d => daily.get(d) ?? 0), dm = series.reduce((a, b) => a + b, 0) / series.length;
  const dsd = Math.sqrt(series.reduce((a, b) => a + (b - dm) ** 2, 0) / Math.max(1, series.length - 1));
  let equity = 0, peak = 0, maxDrawdown = 0; for (const x of series) { equity += x; peak = Math.max(peak, equity); maxDrawdown = Math.min(maxDrawdown, equity - peak); }
  const years = {}; for (const t of trades) { const y = t.date.slice(0, 4); (years[y] ??= { trades: 0, netBps: 0 }); years[y].trades++; years[y].netBps += t.net / (t.weight ?? 1); }
  for (const y of Object.values(years)) y.netBps = +y.netBps.toFixed(0);
  const r = trades.filter(t => Number.isFinite(t.r)).map(t => t.r);
  const side = dir => { const x = trades.filter(t => t.dir === dir); return { trades: x.length, meanNetBps: x.length ? +(x.reduce((q, t) => q + t.net, 0) / x.length).toFixed(2) : null, meanGrossBps: x.length ? +(x.reduce((q, t) => q + t.gross, 0) / x.length).toFixed(2) : null }; };
  return { trades: n, long: side(1), short: side(-1), winRate: +(net.filter(x => x > 0).length / n).toFixed(3), meanNetBps: +mean.toFixed(2), tStat: sd ? +(mean / (sd / Math.sqrt(n))).toFixed(2) : null,
    meanGrossBps: +(trades.reduce((a, t) => a + t.gross, 0) / n).toFixed(2), ...(r.length ? { meanR: +(r.reduce((a, b) => a + b, 0) / r.length).toFixed(3) } : {}),
    annualReturnPct: +(dm * 252 / 100).toFixed(2), sharpe: dsd ? +(dm / dsd * Math.sqrt(252)).toFixed(2) : null, maxDrawdownPct: +(maxDrawdown / 100).toFixed(2), years };
}
const costOf = (scenario, halfSpread, exitIsLimit = false) => { const c = SCENARIOS[scenario], side = c.slip + c.fee + halfSpread; return side + (exitIsLimit ? c.fee : side); };
const priceAt = (bars, minute) => { let p = null; for (const b of bars) { if (b[0] >= minute) break; p = b[4]; } return p; }; // last trade before `minute`

// ---------- 1. Gao, Han, Li & Zhou (2018): first half-hour predicts last half-hour ----------
function momentum(symbol, days, bars) {
  const trades = { first: [], agree: [] }, xs = [], ys = [];
  for (let k = 1; k < days.length; k++) {
    const d = days[k], today = bars.get(d.date), prev = bars.get(days[k - 1].date), len = (d.close - d.open) / 60000;
    if (!today?.length || !prev?.length) continue;
    const prevClose = prev.at(-1)[4], p30 = priceAt(today, 30), p12 = priceAt(today, len - 60), entry = priceAt(today, len - 30), exit = today.at(-1)[4];
    if (![p30, p12, entry, exit].every(Number.isFinite) || today.at(-1)[0] < len - 5) continue;
    const rFirst = p30 / prevClose - 1, r12 = entry / p12 - 1, rLast = exit / entry - 1;
    if (d.date >= FROM) { xs.push(rFirst); ys.push(rLast); }
    const dir = Math.sign(rFirst); if (!dir) continue;
    const gross = dir * rLast * 10000;
    const trade = scenario => ({ date: d.date, dir, gross, net: gross - costOf(scenario, HALF_SPREAD[symbol] ?? 1) });
    trades.first.push(trade);
    if (Math.sign(r12) === dir) trades.agree.push(trade);
  }
  // OLS of the last half-hour return on the first half-hour return.
  const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0), beta = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / sxx;
  const resid = ys.map((y, i) => y - my - beta * (xs[i] - mx)), s2 = resid.reduce((a, e) => a + e * e, 0) / (n - 2), syy = ys.reduce((a, y) => a + (y - my) ** 2, 0);
  return { trades, regression: { days: n, beta: +beta.toFixed(4), tStat: +(beta / Math.sqrt(s2 / sxx)).toFixed(2), r2Pct: +((1 - resid.reduce((a, e) => a + e * e, 0) / syy) * 100).toFixed(2) } };
}

// ---------- 2. Zarattini, Aziz & Barbon (2024): noise-area breakout with VWAP trailing stop ----------
function noise(symbol, days, bars) {
  const moves = new Map(), out = [];
  for (const d of days) {
    const b = bars.get(d.date); if (!b?.length) continue;
    const len = (d.close - d.open) / 60000, open = b[0][1], m = new Float64Array(len + 1).fill(NaN);
    let j = 0, last = null; for (let t = 1; t <= len; t++) { while (j < b.length && b[j][0] < t) last = b[j++][4]; if (last !== null) m[t] = Math.abs(last / open - 1); }
    moves.set(d.date, m);
  }
  for (let k = 15; k < days.length; k++) {
    const d = days[k], b = bars.get(d.date), prev = bars.get(days[k - 1].date), len = (d.close - d.open) / 60000;
    if (!b?.length || !prev?.length) continue;
    const history = days.slice(k - 14, k).map(x => moves.get(x.date)).filter(Boolean);
    if (history.length < 14) continue;
    const open = b[0][1], prevClose = prev.at(-1)[4], up = Math.max(open, prevClose), down = Math.min(open, prevClose);
    let pos = 0, entry = 0, pv = 0, vol = 0, j = 0;
    const close = price => ({ date: d.date, dir: pos, gross: pos * (price / entry - 1) * 10000 });
    const legs = [];
    for (let t = 30; t <= len - 30; t += 30) {
      while (j < b.length && b[j][0] < t) { pv += (b[j][6] ?? b[j][4]) * b[j][5]; vol += b[j][5]; j++; }
      const price = priceAt(b, t); if (price === null || !vol) continue;
      const seen = history.map(m => m[t]).filter(Number.isFinite); if (seen.length < 10) continue;
      const sigma = seen.reduce((a, x) => a + x, 0) / seen.length;
      const ub = up * (1 + sigma), lb = down * (1 - sigma), vwap = pv / vol;
      let exited = 0;
      if (pos === 1 && price < Math.max(ub, vwap)) { legs.push(close(price)); exited = 1; pos = 0; }
      if (pos === -1 && price > Math.min(lb, vwap)) { legs.push(close(price)); exited = -1; pos = 0; }
      // A stop at a check may flip the position but does not re-enter the same side at that check.
      if (pos === 0 && price > ub && exited !== 1) { pos = 1; entry = price; }
      else if (pos === 0 && price < lb && exited !== -1) { pos = -1; entry = price; }
    }
    if (pos !== 0) legs.push(close(b.at(-1)[4]));
    out.push(...legs);
  }
  return scenario => out.map(t => ({ ...t, net: t.gross - costOf(scenario, HALF_SPREAD[symbol] ?? 1) }));
}

// ---------- 3. Zarattini & Aziz (2023): 5-minute opening range breakout ----------
function orb(symbol, days, bars) {
  const out = [];
  for (const d of days) {
    const b = bars.get(d.date); if (!b?.length) continue;
    const first = b.filter(x => x[0] < 5), rest = b.filter(x => x[0] >= 5);
    if (first.length < 3 || !rest.length || first[0][0] !== 0) continue;
    const o = first[0][1], c = first.at(-1)[4], hi = Math.max(...first.map(x => x[2])), lo = Math.min(...first.map(x => x[3]));
    const dir = Math.sign(c - o); if (!dir) continue;
    const entry = rest[0][1], stop = dir > 0 ? lo : hi, risk = dir * (entry - stop); if (risk <= 0) continue;
    const target = entry + dir * 10 * risk; let exit = rest.at(-1)[4], how = 'close';
    for (const x of rest) {
      if (dir > 0 ? x[3] <= stop : x[2] >= stop) { exit = dir > 0 ? Math.min(stop, x[1]) : Math.max(stop, x[1]); how = 'stop'; break; }
      if (dir > 0 ? x[2] > target : x[3] < target) { exit = target; how = 'target'; break; }
    }
    out.push({ date: d.date, dir, gross: dir * (exit / entry - 1) * 10000, riskBps: risk / entry * 10000, how });
  }
  return scenario => out.map(t => { const net = t.gross - costOf(scenario, HALF_SPREAD[symbol] ?? 1, t.how === 'target'); return { ...t, net, r: net / t.riskBps }; });
}

// ---------- 4. Zarattini, Barbon & Aziz (2024): opening range breakout on stocks in play ----------
async function universe(days) {
  const start = days.findIndex(d => d.date >= INPLAY_FROM), window = days.slice(Math.max(0, start - 20), start);
  return cached(join(CACHE, `inplay_universe_${INPLAY_FROM}.json`), async () => {
    const assets = await getJson('https://paper-api.alpaca.markets/v2/assets?status=active&asset_class=us_equity');
    const fund = /\b(ETF|ETN|Fund|Trust|ProShares|Direxion|iShares|SPDR|Leveraged|Inverse|2X|3X|Bull|Bear|Daily)\b/i;
    const candidates = assets.filter(a => a.tradable && ['NYSE', 'NASDAQ', 'AMEX', 'ARCA', 'BATS'].includes(a.exchange) && /^[A-Z]{1,5}(\.[A-Z])?$/.test(a.symbol) && !fund.test(a.name)).map(a => a.symbol);
    const batches = []; for (let i = 0; i < candidates.length; i += 200) batches.push(candidates.slice(i, i + 200));
    const dollar = new Map();
    await pool(batches, 4, async symbols => {
      let token = null;
      do {
        const q = new URLSearchParams({ symbols: symbols.join(','), timeframe: '1Day', start: window[0].date, end: window.at(-1).date, feed: FEED, adjustment: 'split', limit: '10000' });
        if (token) q.set('page_token', token);
        const body = await getJson(`https://data.alpaca.markets/v2/stocks/bars?${q}`);
        for (const [s, rows] of Object.entries(body.bars ?? {})) for (const r of rows) { if (!dollar.has(s)) dollar.set(s, []); dollar.get(s).push({ c: r.c, dv: r.c * r.v }); }
        token = body.next_page_token;
      } while (token);
    });
    const median = xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
    // Top 100 common stocks by median dollar volume in the 20 sessions before the test, priced above $5.
    return [...dollar.entries()].filter(([, rows]) => rows.length >= 15 && median(rows.map(r => r.c)) > 5)
      .map(([s, rows]) => [s, median(rows.map(r => r.dv))]).sort((a, b) => b[1] - a[1]).slice(0, 100).map(([s]) => s);
  });
}
async function inplayDay(symbols, d, tag) {
  return cached(join(CACHE, `inplay-${tag}`, `${d.date}.json.gz`), async () => {
    const out = {}; let token = null;
    do {
      const q = new URLSearchParams({ symbols: symbols.join(','), timeframe: '1Min', start: new Date(d.open).toISOString(), end: new Date(d.close - 1).toISOString(), feed: FEED, adjustment: 'split', limit: '10000', sort: 'asc' });
      if (token) q.set('page_token', token);
      const body = await getJson(`https://data.alpaca.markets/v2/stocks/bars?${q}`);
      for (const [s, rows] of Object.entries(body.bars ?? {})) (out[s] ??= []).push(...rows.map(x => [(Date.parse(x.t) - d.open) / 60000, x.o, x.h, x.l, x.c, x.v]));
      token = body.next_page_token;
    } while (token);
    return out;
  });
}
async function inplay(allDays) {
  const start = allDays.findIndex(d => d.date >= INPLAY_FROM), days = allDays.slice(Math.max(0, start - 20)), symbols = await universe(allDays);
  const tag = createHash('sha256').update(symbols.join(',')).digest('hex').slice(0, 8);
  // Pass 1: daily summaries (open, range, volume, first-5-minute candle and volume) from regular-session bars.
  let done = 0; const stats = new Map(symbols.map(s => [s, new Array(days.length).fill(null)]));
  await pool(days, 4, async (d, k) => {
    const day = await inplayDay(symbols, d, tag);
    for (const s of symbols) {
      const b = day[s]; if (!b?.length || b[0][0] !== 0) continue;
      const f = b.filter(x => x[0] < 5);
      stats.get(s)[k] = { open: b[0][1], high: Math.max(...b.map(x => x[2])), low: Math.min(...b.map(x => x[3])), close: b.at(-1)[4], volume: b.reduce((a, x) => a + x[5], 0),
        f5: { o: f[0][1], c: f.at(-1)[4], h: Math.max(...f.map(x => x[2])), l: Math.min(...f.map(x => x[3])), v: f.reduce((a, x) => a + x[5], 0) } };
    }
    if (++done % 50 === 0) console.error(`in-play days ${done}/${days.length}`);
  });
  const raw = [], selectedPerDay = [];
  for (let k = 20; k < days.length; k++) {
    const picks = [];
    for (const s of symbols) {
      const today = stats.get(s)[k], prior = stats.get(s).slice(k - 14, k);
      if (!today || prior.some(x => !x)) continue;
      const tr = prior.map((x, i) => { const pc = i ? prior[i - 1].close : stats.get(s)[k - 15]?.close ?? x.open; return Math.max(x.high - x.low, Math.abs(x.high - pc), Math.abs(x.low - pc)); });
      const atr = tr.reduce((a, b) => a + b, 0) / 14, avgVolume = prior.reduce((a, x) => a + x.volume, 0) / 14, avgF5 = prior.reduce((a, x) => a + x.f5.v, 0) / 14;
      const rv = today.f5.v / avgF5;
      if (today.open > 5 && avgVolume >= 1e6 && atr >= 0.5 && rv >= 1 && today.f5.c !== today.f5.o) picks.push({ s, rv, atr, f5: today.f5 });
    }
    picks.sort((a, b) => b.rv - a.rv); const chosen = picks.slice(0, 20); selectedPerDay.push(chosen.length);
    const day = chosen.length ? await inplayDay(symbols, days[k], tag) : null; // Pass 2: reload only selected days.
    for (const p of chosen) {
      const b = day[p.s].filter(x => x[0] >= 5), dir = p.f5.c > p.f5.o ? 1 : -1, level = dir > 0 ? p.f5.h : p.f5.l, stopDistance = 0.1 * p.atr;
      for (const optimistic of [false, true]) {
      let entry = null, stop = null, exit = null, how = null;
      for (const x of b) {
        let entryBar = false;
        if (entry === null) {
          if (dir > 0 ? x[2] >= level : x[3] <= level) { entry = dir > 0 ? Math.max(level, x[1]) : Math.min(level, x[1]); stop = entry - dir * stopDistance; entryBar = true; }
          else continue;
        }
        // Within the entry bar the order is unknown: a touched stop counts as hit at the stop.
        // Later bars that open beyond the stop fill at their open.
        if (entryBar && optimistic) continue; // Upper bound: assume the entry bar's extreme came before the entry.
        if (dir > 0 ? x[3] <= stop : x[2] >= stop) { exit = entryBar ? stop : dir > 0 ? Math.min(stop, x[1]) : Math.max(stop, x[1]); how = 'stop'; break; }
      }
      if (entry === null) continue;
      if (exit === null) { exit = b.at(-1)[4]; how = 'close'; }
      raw.push({ date: days[k].date, symbol: p.s, dir, gross: dir * (exit / entry - 1) * 10000, riskBps: stopDistance / entry * 10000, how, count: chosen.length, optimistic });
      }
    }
  }
  const testDays = days.slice(20).map(d => d.date);
  return { symbols, testDays, selectedPerDay: +(selectedPerDay.reduce((a, b) => a + b, 0) / selectedPerDay.length).toFixed(1),
    trades: (scenario, optimistic = false) => raw.filter(t => t.optimistic === optimistic).map(t => { const net = t.gross - costOf(scenario, INPLAY_HALF_SPREAD[scenario]); return { ...t, net, r: net / t.riskBps, weight: t.count }; }) };
}

// ---------- run ----------
const days = await calendar('2015-12-01', TO), testDays = days.filter(d => d.date >= FROM && d.date < TO);
const report = { generatedAt: new Date().toISOString(), period: { from: FROM, to: TO }, costs: { scenarios: SCENARIOS, halfSpreadBps: HALF_SPREAD, inplayHalfSpreadBps: INPLAY_HALF_SPREAD }, studies: {} };
const want = s => STUDY === 'all' || STUDY === s;
const PUBLISHED = { momentum: '2019-01-01', noise: '2024-06-01', orb: '2023-03-01' };
const after = (trades, date) => summarize(trades.filter(t => t.date >= date), dates.filter(d => d >= date));
const dates = testDays.map(d => d.date), post = dates.filter(d => d >= '2019-01-01');
// Thirty sessions of lookback before FROM feed the 14-day noise band and the prior close.
const lookback = days.slice(Math.max(0, days.findIndex(d => d.date >= FROM) - 30)).filter(d => d.date < TO);
if (['all', 'momentum', 'noise', 'orb', 'fetch'].includes(STUDY)) {
  for (const symbol of SYMBOLS) {
    const t0 = performance.now(), bars = await sessionBars(symbol, lookback);
    console.error(`${symbol}: ${[...bars.values()].reduce((a, b) => a + b.length, 0)} session bars in ${((performance.now() - t0) / 1000).toFixed(0)}s`);
    if (STUDY === 'fetch') continue;
    const inRange = t => t.date >= FROM;
    if (want('momentum')) {
      const m = momentum(symbol, lookback, bars);
      for (const variant of ['first', 'agree']) for (const scenario of Object.keys(SCENARIOS)) {
        const trades = m.trades[variant].map(f => f(scenario)).filter(inRange);
        report.studies[`momentum|${symbol}|${variant}|${scenario}`] = { ...summarize(trades, dates), postPublication: after(trades, PUBLISHED.momentum) };
      }
      report.studies[`momentum|${symbol}|regression`] = m.regression;
    }
    if (want('noise')) { const n = noise(symbol, lookback, bars); for (const scenario of Object.keys(SCENARIOS)) { const t = n(scenario).filter(inRange); report.studies[`noise|${symbol}|${scenario}`] = { ...summarize(t, dates), postPublication: after(t, PUBLISHED.noise) }; } }
    if (want('orb')) { const o = orb(symbol, testDays, bars); for (const scenario of Object.keys(SCENARIOS)) { const t = o(scenario); report.studies[`orb|${symbol}|${scenario}`] = { ...summarize(t, dates), postPublication: after(t, PUBLISHED.orb) }; } }
  }
}
if (want('inplay') || STUDY === 'fetch') {
  const r = await inplay(days.filter(d => d.date < TO));
  report.inplayUniverse = r.symbols; report.inplaySelectedPerDay = r.selectedPerDay;
  for (const scenario of Object.keys(SCENARIOS)) report.studies[`inplay|top20|${scenario}`] = summarize(r.trades(scenario), r.testDays);
  for (const scenario of Object.keys(SCENARIOS)) report.studies[`inplay|top20|${scenario}|entry-bar-optimistic`] = summarize(r.trades(scenario, true), r.testDays);
}
mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log('study'.padEnd(34), 'trades  win%  net bps     t   gross   meanR  ann%  sharpe  maxDD%');
for (const [k, s] of Object.entries(report.studies)) {
  if (!s.trades && s.trades !== 0) { console.log(k.padEnd(34), JSON.stringify(s)); continue; }
  const line = x => `${String(x.trades).padStart(6)} ${String(((x.winRate ?? 0) * 100).toFixed(0)).padStart(5)} ${String(x.meanNetBps ?? '-').padStart(8)} ${String(x.tStat ?? '-').padStart(6)} ${String(x.meanGrossBps ?? '-').padStart(7)} ${String(x.meanR ?? '-').padStart(7)} ${String(x.annualReturnPct ?? '-').padStart(5)} ${String(x.sharpe ?? '-').padStart(7)} ${String(x.maxDrawdownPct ?? '-').padStart(7)}`;
  console.log(k.padEnd(34), line(s));
  if (s.postPublication) console.log(`  └ after publication`.padEnd(34), line(s.postPublication));
}
console.log(`report: ${OUT}`);
