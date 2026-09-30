// Prospective hypotheses. These settings never size or authorize broker orders.
export const ALTERNATIVES_POLICY = Object.freeze({
  version: 'trade-alternatives-v1', risk: 100, maxNotional: 5000,
  horizonMs: 1800000, closeBufferMs: 300000, maxCohorts: 200,
  stockFeeBps: 1, stockSlippageBps: 3, stockMaxSpreadBps: 10,
  assetAgeMs: 900000, minimumPairs: 100, minimumSessions: 60,
});
export const ALTERNATIVE_ROUTES = Object.freeze([
  'stock_long', 'stock_short', 'call_debit', 'put_debit', 'put_credit',
  'call_credit', 'iron_condor', 'long_volatility', 'no_trade',
]);
