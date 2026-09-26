import { finite } from './util.js';
import { OPTIONS_POLICY, OPTIONS_STRATEGIES, daysToExpiry } from './options-policy.js';
import { contractProblem, spreadEconomics } from './options-pricing.js';
import { scanCondor } from './options-condor.js';
export { OPTIONS_POLICY, OPTIONS_STRATEGIES, OPTIONS_FINGERPRINT, optionsDefinition, daysToExpiry } from './options-policy.js';
export { optionContext } from './options-context.js';
export { quoteProblem, contractProblem, spreadEconomics } from './options-pricing.js';
const positive = x => finite(x) && x > 0;
const DAY = 86400000;

export function scanOptions(frame, enabled = OPTIONS_STRATEGIES.map(s => s.id), policy = OPTIONS_POLICY) {
  const candidates = [], rejected = {};
  const reject = reason => { rejected[reason] = (rejected[reason] ?? 0) + 1; };
  if (frame.source !== 'alpaca_opra' || frame.stockFeed !== 'sip' || !finite(frame.now) || !finite(frame.clockUncertaintyMs) || frame.clockUncertaintyMs > 1000) return { candidates, rejected: { source_or_clock: 1 } };
  if (!frame.marketOpen || !frame.session || frame.now < frame.session.open + 35 * 60000 || frame.now >= frame.session.close - 60 * 60000) return { candidates, rejected: { outside_entry_window: 1 } };
  for (const definition of OPTIONS_STRATEGIES.filter(s => enabled.includes(s.id))) for (const symbol of frame.universe) {
    const context = frame.contexts[symbol], spot = frame.spots[symbol];
    if (!context || context.reason || !positive(spot?.price) || !finite(spot.ts) || frame.now - spot.ts > policy.quoteAgeMs || spot.ts > frame.now + 1000 || !(context.through < Date.parse(frame.session.date + 'T00:00:00Z')) || frame.now - context.through > 5 * DAY) { reject('underlying_context_unavailable'); continue; }
    if (definition.type === 'condor') {
      const candidate=scanCondor(frame,symbol,definition,policy,reject);
      if(candidate)candidates.push(candidate);else reject('iron_condor:no_eligible_spread');
      continue;
    }
    const trend = definition.credit ? positive(context.rv20) && (definition.type === 'put' ? context.previousClose >= context.sma50 && spot.price >= context.sma20 : context.previousClose <= context.sma50 && spot.price <= context.sma20)
      : context.intradayReady && context.barEnd <= frame.now && frame.now - context.barEnd <= 360000 &&
        (definition.type === 'call' ? context.close > context.rangeHigh && context.close > context.vwap : context.close < context.rangeLow && context.close < context.vwap);
    if (!trend) { reject(definition.id + ':regime'); continue; }
    const contracts = Object.values(frame.contracts).filter(c => c.underlying === symbol && !contractProblem(c, frame, definition, policy));
    let best = null;
    for (const anchor of contracts) {
      const q = frame.quotes[anchor.symbol], delta = Math.abs(q?.delta);
      if (!finite(delta) || delta < (definition.credit ? .20 : .45) || delta > (definition.credit ? .35 : .65) || !positive(q.iv)) continue;
      if ((definition.type === 'put' && q.delta >= 0) || (definition.type === 'call' && q.delta <= 0)) continue;
      if (definition.credit && ((definition.type === 'put' ? anchor.strike >= spot.price : anchor.strike <= spot.price) || q.iv < 1.25 * context.rv20)) continue;
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
