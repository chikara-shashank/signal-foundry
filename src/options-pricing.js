import { finite } from './util.js';
import { OPTIONS_POLICY, daysToExpiry } from './options-policy.js';
import { optionLegs, optionGeometry } from './options-structure.js';
const positive = x => finite(x) && x > 0;

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
  const geometry = optionGeometry(candidate);
  if (!geometry) return { reason: 'invalid_spread_geometry' };
  const legs = optionLegs(candidate), {width,count} = geometry;
  for (const leg of legs) { const reason=quoteProblem(quotes[leg.contract.symbol],now,policy,entry); if(reason)return {reason}; }
  const times=legs.map(l=>quotes[l.contract.symbol].ts);
  if (Math.max(...times)-Math.min(...times)>policy.quoteSkewMs)return {reason:'unsynchronized_legs'};
  // Dollars per underlying share. Positive entryCost is a debit; negative is a credit.
  const entryCost = legs.reduce((n,l)=>n+(l.side==='long'?quotes[l.contract.symbol].ask:-quotes[l.contract.symbol].bid),0) + count * policy.slippagePerLeg;
  const exitValue = legs.reduce((n,l)=>n+(l.side==='long'?quotes[l.contract.symbol].bid:-quotes[l.contract.symbol].ask),0) - count * policy.slippagePerLeg;
  const fees = 2 * count * policy.feePerContractSide;
  const maxLoss = (candidate.credit ? width + entryCost : entryCost) * 100 + fees;
  const maxProfit = (candidate.credit ? -entryCost : width - entryCost) * 100 - fees;
  return { entryCost, exitValue, maxLoss, maxProfit, roundTripFees: fees, immediateRoundTripLoss: (entryCost - exitValue) * 100 + fees,
    oldestQuote: Math.min(...times), width, legCount: count };
}

