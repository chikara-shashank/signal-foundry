import { hash, nyDate, finite } from './util.js';

// Frozen hypotheses, not optimized parameters or a claim of positive expectancy.
export const OPTIONS_POLICY = Object.freeze({
  version: 'options-v1', holdoutStart: '2026-09-28', capital: 10000,
  maxRisk: 100, maxPortfolioRisk: 200, maxPositions: 2, dailyLoss: 100,
  feePerContractSide: 0.10, slippagePerLeg: 0.01, stressFee: 0.65, stressSlippage: 0.03,
  quoteAgeMs: 5000, quoteSkewMs: 1000, latencyMs: 1000, pendingTtlMs: 90000,
  maxSpread: 0.20, maxRelativeSpread: 0.15, minSize: 5, minOpenInterest: 100,
  maxOiAgeDays: 7, maxWidth: 5, pollMs: 30000, maxGapMs: 90000,
  minimumSessions: 60, minimumTrades: 100,
});
export const OPTIONS_STRATEGIES = Object.freeze([
  Object.freeze({ id: 'put_credit', name: 'Put credit · volatility premium', type: 'put', credit: true, minDte: 21, maxDte: 45, targetDte: 30,
    description: 'Non-bearish daily trend; short-put IV ≥ 1.25× prior realized volatility. Multi-day hypothesis.' }),
  Object.freeze({ id: 'call_debit', name: 'Call debit · opening-range breakout', type: 'call', credit: false, minDte: 7, maxDte: 21, targetDte: 14,
    description: 'Completed five-minute close above the first 30-minute range and session VWAP. Intraday hypothesis.' }),
  Object.freeze({ id: 'put_debit', name: 'Put debit · opening-range breakdown', type: 'put', credit: false, minDte: 7, maxDte: 21, targetDte: 14,
    description: 'Completed five-minute close below the first 30-minute range and session VWAP. Intraday hypothesis.' }),
]);
export const optionsDefinition = id => OPTIONS_STRATEGIES.find(s => s.id === id);
export const OPTIONS_FINGERPRINT = hash({ policy: OPTIONS_POLICY, strategies: OPTIONS_STRATEGIES });
const DAY = 86400000;
export const daysToExpiry = (expiry, now) => (Date.parse(expiry + 'T00:00:00Z') - Date.parse(nyDate(now) + 'T00:00:00Z')) / DAY;
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

export function quoteProblem(q, now, policy = OPTIONS_POLICY, entry = true) {
  if (!q || !positive(q.bid) || !positive(q.ask) || q.ask < q.bid || !finite(q.ts) || q.ts > now + 1000 || now - q.ts > policy.quoteAgeMs) return 'invalid_or_stale_quote';
  if (!positive(q.bidSize) || !positive(q.askSize) || q.condition !== ' ') return 'quote_size_or_condition';
  if (entry && (q.bidSize < policy.minSize || q.askSize < policy.minSize || q.ask - q.bid > policy.maxSpread + 1e-9 || (q.ask - q.bid) / ((q.ask + q.bid) / 2) > policy.maxRelativeSpread)) return 'illiquid_quote';
  return null;
}

export function contractProblem(c, frame, definition, policy = OPTIONS_POLICY) {
  if (!c || c.status !== 'active' || c.tradable !== true || !['SPY', 'QQQ'].includes(c.underlying) || c.root !== c.underlying || c.multiplier !== 100 || c.size !== 100 || c.style !== 'american' || c.type !== definition.type || !positive(c.strike)) return 'unsupported_contract';
  const d = c.deliverables;
  if (!Array.isArray(d) || d.length !== 1 || d[0].type !== 'equity' || d[0].symbol !== c.underlying || Number(d[0].amount) !== 100 || Number(d[0].allocation_percentage) !== 100 || d[0].delayed_settlement !== false) return 'adjusted_deliverable';
  const dte = daysToExpiry(c.expiry, frame.now), oiAge = daysToExpiry(c.oiDate, frame.now);
  if (!finite(dte) || dte < definition.minDte || dte > definition.maxDte) return 'expiration_window';
  if (!finite(c.openInterest) || c.openInterest < policy.minOpenInterest || !finite(oiAge) || oiAge > 0 || oiAge < -policy.maxOiAgeDays) return 'open_interest_unavailable';
  return null;
}

export function spreadEconomics(candidate, quotes, now, policy = OPTIONS_POLICY, entry = true) {
  const l = quotes[candidate.long.symbol], s = quotes[candidate.short.symbol];
  const reason = quoteProblem(l, now, policy, entry) ?? quoteProblem(s, now, policy, entry);
  if (reason) return { reason };
  if (Math.abs(l.ts - s.ts) > policy.quoteSkewMs) return { reason: 'unsynchronized_legs' };
  const width = Math.abs(candidate.long.strike - candidate.short.strike);
  // Dollars per underlying share. Positive entryCost is a debit; negative is a credit.
  const entryCost = l.ask - s.bid + 2 * policy.slippagePerLeg;
  const exitValue = l.bid - s.ask - 2 * policy.slippagePerLeg;
  const fees = 4 * policy.feePerContractSide;
  const maxLoss = (candidate.credit ? width + entryCost : entryCost) * 100 + fees;
  const maxProfit = (candidate.credit ? -entryCost : width - entryCost) * 100 - fees;
  return { entryCost, exitValue, maxLoss, maxProfit, roundTripFees: fees, immediateRoundTripLoss: (entryCost - exitValue) * 100 + fees,
    oldestQuote: Math.min(l.ts, s.ts), width };
}

export function scanOptions(frame, enabled = OPTIONS_STRATEGIES.map(s => s.id), policy = OPTIONS_POLICY) {
  const candidates = [], rejected = {};
  const reject = reason => { rejected[reason] = (rejected[reason] ?? 0) + 1; };
  if (frame.source !== 'alpaca_opra' || frame.stockFeed !== 'sip' || !finite(frame.now) || !finite(frame.clockUncertaintyMs) || frame.clockUncertaintyMs > 1000) return { candidates, rejected: { source_or_clock: 1 } };
  if (!frame.marketOpen || !frame.session || frame.now < frame.session.open + 35 * 60000 || frame.now >= frame.session.close - 60 * 60000) return { candidates, rejected: { outside_entry_window: 1 } };
  for (const definition of OPTIONS_STRATEGIES.filter(s => enabled.includes(s.id))) for (const symbol of frame.universe) {
    const context = frame.contexts[symbol], spot = frame.spots[symbol];
    if (!context || context.reason || !positive(spot?.price) || !finite(spot.ts) || frame.now - spot.ts > policy.quoteAgeMs || spot.ts > frame.now + 1000 || !(context.through < Date.parse(frame.session.date + 'T00:00:00Z')) || frame.now - context.through > 5 * DAY) { reject('underlying_context_unavailable'); continue; }
    const trend = definition.credit ? context.previousClose >= context.sma50 && spot.price >= context.sma20 && positive(context.rv20)
      : context.intradayReady && context.barEnd <= frame.now && frame.now - context.barEnd <= 360000 &&
        (definition.type === 'call' ? context.close > context.rangeHigh && context.close > context.vwap : context.close < context.rangeLow && context.close < context.vwap);
    if (!trend) { reject(definition.id + ':regime'); continue; }
    const contracts = Object.values(frame.contracts).filter(c => c.underlying === symbol && !contractProblem(c, frame, definition, policy));
    let best = null;
    for (const anchor of contracts) {
      const q = frame.quotes[anchor.symbol], delta = Math.abs(q?.delta);
      if (!finite(delta) || delta < (definition.credit ? .20 : .45) || delta > (definition.credit ? .35 : .65) || !positive(q.iv)) continue;
      if ((definition.type === 'put' && q.delta >= 0) || (definition.type === 'call' && q.delta <= 0)) continue;
      if (definition.credit && (anchor.strike >= spot.price || q.iv < 1.25 * context.rv20)) continue;
      for (const hedge of contracts) {
        if (hedge.expiry !== anchor.expiry || hedge.symbol === anchor.symbol) continue;
        const width = definition.type === 'call' ? hedge.strike - anchor.strike : anchor.strike - hedge.strike;
        if (width < 1 || width > policy.maxWidth) continue;
        const candidate = { strategy: definition.id, underlying: symbol, credit: definition.credit, expiry: anchor.expiry,
          long: definition.credit ? hedge : anchor, short: definition.credit ? anchor : hedge, quantity: 1, decisionAt: frame.now };
        if (!definition.credit && (definition.type === 'call' ? candidate.short.strike <= spot.price : candidate.short.strike >= spot.price)) continue;
        const economics = spreadEconomics(candidate, frame.quotes, frame.now, policy);
        if (economics.reason) { reject(economics.reason); continue; }
        const premium = Math.abs(economics.entryCost);
        if ((definition.credit ? economics.entryCost >= 0 || premium < width * .20 : economics.entryCost <= 0 || premium > width * .65) || premium >= width) { reject('premium_to_width'); continue; }
        if (!(economics.maxLoss > 0 && economics.maxLoss <= policy.maxRisk && economics.maxProfit > economics.immediateRoundTripLoss * 2)) { reject('risk_or_cost'); continue; }
        // Rank closeness to frozen expiry/delta, then cost. Never rank by backtest P/L.
        const rank = Math.abs(daysToExpiry(anchor.expiry, frame.now) - definition.targetDte) + Math.abs(delta - (definition.credit ? .25 : .55)) * 10 + economics.immediateRoundTripLoss / 100;
        if (!best || rank < best.rank) best = { ...candidate, ...economics, rank };
      }
    }
    if (best) candidates.push(best); else reject(definition.id + ':no_eligible_spread');
  }
  return { candidates, rejected };
}
