import { hash, nyDate } from './util.js';

// Frozen hypotheses, not optimized parameters or a claim of positive expectancy.
export const OPTIONS_POLICY = Object.freeze({
  version: 'options-v3', holdoutStart: '2026-09-28', capital: 10000,
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
  Object.freeze({ id: 'call_credit', name: 'Call credit - volatility premium', type: 'call', credit: true, minDte: 21, maxDte: 45, targetDte: 30,
    description: 'Non-bullish daily trend; short-call IV >= 1.25x prior realized volatility. Defined-risk research adaptation; unvalidated.' }),
  Object.freeze({ id: 'iron_condor', name: 'Iron condor · volatility premium', type: 'condor', credit: true, minDte: 21, maxDte: 45, targetDte: 30,
    description: 'Four-leg SPY/QQQ credit position; 15–25 delta shorts, both IVs >= 1.25x realized volatility, protected wings. CNDR-inspired adaptation; published benchmark return was weak. Quote-shadow only; executable history missing.' }),
]);
export const optionsDefinition = id => OPTIONS_STRATEGIES.find(s => s.id === id);
export const OPTIONS_FINGERPRINT = hash({ policy: OPTIONS_POLICY, strategies: OPTIONS_STRATEGIES });
const DAY = 86400000;
export const daysToExpiry = (expiry, now) => (Date.parse(expiry + 'T00:00:00Z') - Date.parse(nyDate(now) + 'T00:00:00Z')) / DAY;
