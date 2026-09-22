import { floorStep, isCrypto, positive, validateQuote } from './util.js';

export function sizeEntry(c, q, account, positions, pending, cfg, asset, now, session) {
  const deny = reason => ({ ok: false, reason });
  if (!validateQuote(q, now, cfg.maxQuoteAge)) return deny('stale_or_invalid_quote');
  if (now > c.expires || c.ts > now + 1000) return deny('candidate_expired');
  if (!account || now - account.ts > 15000 || account.blocked || !positive(account.equity)) return deny('account_not_ready');
  if (!asset?.tradable) return deny('asset_not_tradable');
  if (c.features?.regime === 'shock') return deny('volatility_shock');
  const crypto = isCrypto(c.symbol);
  if (!crypto && (!session?.open || session.close - now < 10 * 60000 || now - session.ts > 15000)) return deny('equity_session_closed');
  if (positions.some(p => p.symbol === c.symbol) || pending.some(o => o.symbol === c.symbol)) return deny('symbol_already_allocated');
  // Zero disables only the count cap; pending capital remains reserved below.
  if (cfg.maxPositions > 0 && positions.length + pending.filter(x => x.kind === 'entry').length >= cfg.maxPositions) return deny('position_limit');
  const spread = (q.ask - q.bid) / ((q.ask + q.bid) / 2) * 10000;
  if (spread > cfg.maxSpread) return deny('spread_limit');
  if (Math.abs(q.ask / c.reference - 1) * 10000 > 30) return deny('price_moved');
  const tick = crypto ? asset.price_increment : q.ask >= 1 ? .01 : .0001;
  const limit = floorStep(q.ask * (1 + cfg.slippage / 10000) + tick, tick);
  const stop = floorStep(c.stop, tick), target = floorStep(c.target, tick);
  if (![limit, stop, target].every(positive) || !(stop < q.bid && target > limit)) return deny('invalid_bracket');
  const fee = crypto ? cfg.cryptoFee : cfg.equityFee;
  const costPerUnit = limit * (2 * (fee + cfg.slippage) + spread) / 10000;
  if (target - limit < 2 * costPerUnit) return deny('reward_does_not_clear_cost_buffer');
  const gross = positions.reduce((s, p) => s + Math.abs(p.marketValue), 0);
  const reserved = pending.filter(o => o.kind === 'entry').reduce((s, o) => s + o.reserved, 0);
  const group = positions.filter(p => isCrypto(p.symbol) === crypto).reduce((s, p) => s + Math.abs(p.marketValue), 0) + pending.filter(o => o.kind === 'entry' && isCrypto(o.symbol) === crypto).reduce((s, o) => s + o.reserved, 0);
  const capacity = Math.min(cfg.maxPosition, cfg.maxGross - gross - reserved, cfg.maxGroup - group, cfg.capital - gross - reserved, account.cash - reserved, account.buyingPower - reserved);
  const qty = floorStep(Math.min(cfg.risk / (limit - stop + costPerUnit), capacity / (limit * (1 + fee / 10000))), crypto ? asset.min_trade_increment : 1);
  if (!positive(qty) || qty < (crypto ? asset.min_order_size : 1)) return deny('insufficient_capacity_or_lot_size');
  return { ok: true, qty, limit, stop, target, reserved: qty * limit * (1 + fee / 10000), estimatedRoundTripCost: costPerUnit * qty, riskAtStop: (limit - stop + costPerUnit) * qty };
}
