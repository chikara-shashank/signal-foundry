import { finite, nyDate } from './util.js';
const positive = x => finite(x) && x > 0;
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;

export function optionContext(daily, intraday, session, now) {
  const prior = daily.filter(b => nyDate(Date.parse(b.t)) < session.date).sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  const bars = intraday.filter(b => Date.parse(b.t) >= session.open && Date.parse(b.t) + 300000 <= now && Date.parse(b.t) < session.close)
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  const valid = b => [b.o, b.h, b.l, b.c].every(positive) && finite(b.v) && b.v >= 0 && b.l <= Math.min(b.o, b.c) && b.h >= Math.max(b.o, b.c);
  if (prior.length < 50 || !prior.every(valid) || !bars.every(valid) || new Set(prior.map(b => b.t)).size !== prior.length) return { reason: 'history_unavailable' };
  const returns = prior.slice(-21).slice(1).map((b, i) => Math.log(b.c / prior.slice(-21)[i].c)), average = mean(returns);
  const rv20 = Math.sqrt(252 * returns.reduce((sum, r) => sum + (r - average) ** 2, 0) / 19);
  const contiguous = bars.length >= 7 && bars.every((b, i) => Date.parse(b.t) === session.open + i * 300000) && now - (Date.parse(bars.at(-1).t) + 300000) <= 360000;
  const opening = bars.slice(0, 6), volume = bars.reduce((sum, b) => sum + b.v, 0);
  return { rv20, sma20: mean(prior.slice(-20).map(b => b.c)), sma50: mean(prior.slice(-50).map(b => b.c)), previousClose: prior.at(-1).c,
    through: Date.parse(prior.at(-1).t), intradayReady: contiguous && volume > 0,
    barEnd: bars.length ? Date.parse(bars.at(-1).t) + 300000 : null, close: bars.at(-1)?.c ?? null,
    rangeHigh: opening.length === 6 ? Math.max(...opening.map(b => b.h)) : null,
    rangeLow: opening.length === 6 ? Math.min(...opening.map(b => b.l)) : null,
    vwap: volume > 0 ? bars.reduce((sum, b) => sum + (positive(b.vw) ? b.vw : (b.h + b.l + b.c) / 3) * b.v, 0) / volume : null };
}

