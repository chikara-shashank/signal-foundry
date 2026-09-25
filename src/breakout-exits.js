import { isCrypto, positive } from './util.js';

export const BREAKOUTS = ['range_breakout', 'failed_breakout'];
// A fixed forward paper experiment, not parameters optimized against past winners.
export function breakoutPolicy(candidate, cfg) {
  if (!BREAKOUTS.includes(candidate.strategy) || isCrypto(candidate.symbol) || !cfg.breakoutProtection) return null;
  const f = candidate.features;
  return { version: 1, armR: cfg.breakoutArmR, trailR: cfg.breakoutTrailR, lockR: .1,
    noProgressMs: cfg.breakoutNoProgress, progressR: .25, slippageBps: cfg.slippage,
    invalidation: candidate.strategy === 'range_breakout' ? f.rangeHigh : f.rangeLow,
    invalidationBuffer: positive(f.atr) ? .15 * f.atr : null };
}

// Called only with accepted fresh, ordered bid quotes, after a confirmed owned fill.
// The floor is a software exit trigger; it is not a guaranteed fill or native stop replacement.
export function observeBreakout(m, entry, q, now, heldQty = entry.filledQty) {
  if (!BREAKOUTS.includes(entry.strategy) || !positive(entry.fillPrice) || !positive(entry.filledQty)) return null;
  const start = entry.filledAt ?? entry.lastFillObservedAt ?? m.openedAt;
  if (q.ts < start) return null;
  const policy = entry.exitPolicy, feeRate = (entry.feeRateBps ?? 0) / 10000;
  const costBasis = entry.fillPrice + (Number.isFinite(entry.fee) ? entry.fee / entry.filledQty : entry.fillPrice * feeRate);
  const exitSlip = (policy?.slippageBps ?? 0) / 10000;
  const proceeds = q.bid * (1 - exitSlip) * (1 - feeRate), net = entry.filledQty * (proceeds - costBasis);
  // A later partial fill changes the average cost and quantity. Start a new mark
  // segment instead of presenting incomparable dollars as one continuous peak.
  const prior = m.excursion?.fillQty === entry.filledQty && m.excursion?.fillPrice === entry.fillPrice ? m.excursion : {}, risk = entry.fillPrice - entry.stop;
  const comparable = prior.netComparable !== false && heldQty === entry.filledQty;
  m.excursion = { ...prior, fillQty:entry.filledQty,fillPrice:entry.fillPrice,firstObservedAt: prior.firstObservedAt ?? now, lastObservedAt: now,
    maxBid: Math.max(prior.maxBid ?? q.bid, q.bid), minBid: Math.min(prior.minBid ?? q.bid, q.bid),
    netComparable:comparable,slippageBps:exitSlip*10000,
    peakNet: comparable ? Math.max(prior.peakNet ?? net, net) : null, worstNet: comparable ? Math.min(prior.worstNet ?? net, net) : null, lastNet: comparable ? net : null,
    basis: comparable ? 'Observed bid marks with estimated exit costs; no fill guarantee' : 'Partial exits changed held quantity; dollar excursions are unavailable',
    ...(prior.peakNet == null || net > prior.peakNet ? { peakAt: q.ts } : {}) };
  if (!policy || !positive(risk)) return null; // Existing unversioned trades retain their original exits.
  const x = m.excursion, breakEven = costBasis / ((1 - exitSlip) * (1 - feeRate));
  if (x.maxBid >= entry.fillPrice + policy.armR * risk && x.maxBid >= breakEven + policy.lockR * risk) {
    x.armedAt ??= now;
    x.floor = Math.max(x.floor ?? entry.stop, breakEven + policy.lockR * risk, x.maxBid - policy.trailR * risk);
  }
  if (x.floor != null && q.bid <= x.floor) return 'profit_protection';
  if (now - start >= policy.noProgressMs && x.maxBid < entry.fillPrice + policy.progressR * risk) return 'breakout_no_progress';
  return null;
}

export function breakoutInvalidated(entry, bar, now) {
  const p = entry.exitPolicy, filledAt = entry.filledAt ?? entry.lastFillObservedAt;
  return p && Number.isFinite(p.invalidation) && Number.isFinite(p.invalidationBuffer) && Number.isFinite(filledAt) &&
    bar.ts >= filledAt && bar.ts + 60000 <= now + 1000 && now - (bar.ts + 60000) <= 10000 &&
    bar.close < p.invalidation - p.invalidationBuffer;
}
