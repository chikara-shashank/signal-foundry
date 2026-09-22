import { validBar, positive } from './util.js';

const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const ema = (xs, n) => xs.slice(1).reduce((a, x) => a + 2 / (n + 1) * (x - a), xs[0]);

export function aggregate(bars, minutes, sourceMinutes = 1) {
  const width = minutes * 60000, groups = new Map();
  for (const b of bars) {
    const start = Math.floor(b.ts / width) * width;
    if (!groups.has(start)) groups.set(start, []);
    groups.get(start).push(b);
  }
  return [...groups.entries()].filter(([start, bs]) => bs.length === minutes / sourceMinutes && bs[0].ts === start && bs.at(-1).ts === start + width - sourceMinutes * 60000)
    .map(([ts, bs]) => ({ ts, open: bs[0].open, close: bs.at(-1).close, high: Math.max(...bs.map(b => b.high)), low: Math.min(...bs.map(b => b.low)), volume: bs.reduce((a, b) => a + b.volume, 0) }));
}

export class Features {
  history = new Map();
  constructor(intervalMinutes = 1) { this.intervalMinutes = intervalMinutes; }
  add(b, now) {
    const intervalMs = this.intervalMinutes * 60000;
    if (!validBar(b) || b.ts % intervalMs !== 0 || b.ts + intervalMs > now + 1000) return null;
    let bs = this.history.get(b.symbol) ?? [];
    if (bs.length && b.ts <= bs.at(-1).ts) return null;
    // Sparse provider crypto buckets remain missing, never synthesized. Permit
    // an isolated absent 5m bucket only after six new consecutive observations.
    if (bs.length && b.ts - bs.at(-1).ts !== intervalMs && (this.intervalMinutes === 1 || b.ts - bs.at(-1).ts > 2 * intervalMs)) bs = [];
    bs.push(b); if (bs.length > 120) bs.shift(); this.history.set(b.symbol, bs);
    if (bs.length < 30) return null;
    const coverage = bs.length / ((b.ts - bs[0].ts) / intervalMs + 1);
    const tail = bs.slice(-6);
    if (coverage < .95 || tail.some((x,i) => i && x.ts - tail[i-1].ts !== intervalMs)) return null;
    const prior = bs.slice(-21, -1), closes = bs.map(x => x.close), p = bs.at(-2);
    const ranges = bs.slice(1).map((x, i) => Math.max(x.high - x.low, Math.abs(x.high - bs[i].close), Math.abs(x.low - bs[i].close)));
    const recent = bs.slice(-60), totalVolume = recent.reduce((a, x) => a + x.volume, 0);
    if (!positive(totalVolume)) return null;
    const f5 = aggregate(bs, 5, this.intervalMinutes), f15 = aggregate(bs, 15, this.intervalMinutes);
    const rollingVwap = recent.reduce((a, x) => a + (x.high + x.low + x.close) / 3 * x.volume, 0) / totalVolume;
    const deviation = Math.sqrt(recent.reduce((s, x) => s + x.volume * (x.close - rollingVwap) ** 2, 0) / totalVolume);
    const path = closes.slice(-20).slice(1).reduce((s, x, i) => s + Math.abs(x - closes.slice(-20)[i]), 0);
    const efficiency = path > 0 ? Math.abs(closes.at(-1) - closes.at(-20)) / path : 0;
    const volatilityRatio = mean(ranges.slice(-5)) / Math.max(mean(ranges.slice(-20)), 1e-8);
    return {
      symbol: b.symbol, version: b.ts, bar: b, intervalMs, coverage, count: bs.length, previous: p,
      ema9: ema(closes, 9), ema21: ema(closes, 21), previousEma9: ema(closes.slice(0, -1), 9),
      atr: mean(ranges.slice(-14)), rangeHigh: Math.max(...prior.map(x => x.high)), rangeLow: Math.min(...prior.map(x => x.low)),
      relativeVolume: b.volume / Math.max(mean(prior.map(x => x.volume)), 1e-8),
      rollingVwap, vwapZ: deviation > 0 ? (b.close - rollingVwap) / deviation : 0,
      efficiency, volatilityRatio, priorCompression: mean(ranges.slice(-6, -1)) / Math.max(mean(ranges.slice(-21, -1)), 1e-8),
      regime: volatilityRatio > 2.5 ? 'shock' : efficiency > .35 ? 'trend' : 'range',
      trend5: f5.length >= 2 && f5.at(-1).ts - f5.at(-2).ts === 300000 ? f5.at(-1).close / f5.at(-2).close - 1 : null,
      trend15: f15.length >= 2 && f15.at(-1).ts - f15.at(-2).ts === 900000 ? f15.at(-1).close / f15.at(-2).close - 1 : null,
    };
  }
}
