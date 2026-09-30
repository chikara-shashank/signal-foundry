import { optionLegs, optionGeometry } from './options-structure.js';
export const PAPER_ROUTE_POLICY = Object.freeze({ version: 1, maxRisk: 100, shortNotional: 1000, dailyLoss: 100,
  maxPositions: 1, maxHoldMs: 1800000, entryTtlMs: 20000, closeBufferMs: 600000, optionFee: .65, quoteGapMs: 90000 });
export const routeActive = t => !t.closedAt;
export const finished = o => ['filled','canceled','expired','rejected','aborted'].includes(o.status);
export function spreadBody(t, close = false) {
  if (t.route !== 'call_debit' && t.route !== 'put_debit' || t.candidate.credit || optionGeometry(t.candidate)?.count !== 2) throw new Error('paper_route_geometry');
  return { order_class: 'mleg', qty: '1', type: close ? 'market' : 'limit', time_in_force: 'day',
    ...(!close ? { limit_price: t.limit.toFixed(2) } : {}),
    legs: optionLegs(t.candidate).map(l => {
      const side = (l.side === 'long') !== close ? 'buy' : 'sell';
      return { symbol: l.contract.symbol, ratio_qty: '1', side, position_intent: `${side}_to_${close ? 'close' : 'open'}` };
    }) };
}
export function shortBody(t) {
  if (!(t.target < t.limit && t.limit < t.stop) || !Number.isInteger(t.qty) || t.qty < 1) throw new Error('paper_route_bracket');
  return { symbol: t.symbol, side: 'sell', qty: String(t.qty), type: 'limit', limit_price: t.limit.toFixed(2),
    time_in_force: 'gtc', order_class: 'bracket', take_profit: { limit_price: t.target.toFixed(2) }, stop_loss: { stop_price: t.stop.toFixed(2) } };
}
export function validatePaperBody(body) {
  const fail = () => { throw new Error('invalid_paper_route_order'); };
  if (!/^sf-pr-[a-f0-9]{24}$/.test(body.client_order_id) || !Number.isInteger(Number(body.qty)) || Number(body.qty) < 1) fail();
  if (body.order_class === 'mleg') {
    if (body.qty !== '1' || body.time_in_force !== 'day' || !['limit','market'].includes(body.type) || body.legs?.length !== 2) fail();
    const opening = body.type === 'limit', suffix = opening ? 'open' : 'close';
    if (opening && !(Number(body.limit_price) > 0 && Number(body.limit_price) * 100 + 4 * PAPER_ROUTE_POLICY.optionFee <= PAPER_ROUTE_POLICY.maxRisk)) fail();
    if (new Set(body.legs.map(l => l.symbol)).size !== 2 || new Set(body.legs.map(l => l.side)).size !== 2) fail();
    const parts = body.legs.map(l => /^(SPY|QQQ)(\d{6})([CP])(\d{8})$/.exec(l.symbol));
    if (parts.some(p => !p) || parts.some(p => p[1] !== parts[0][1] || p[2] !== parts[0][2] || p[3] !== parts[0][3])) fail();
    if (body.legs.some(l => l.ratio_qty !== '1' || !['buy','sell'].includes(l.side) || l.position_intent !== `${l.side}_to_${suffix}`)) fail();
    const long = parts[body.legs.findIndex(l => l.side === (opening ? 'buy' : 'sell'))], short = parts[body.legs.findIndex(l => l.side === (opening ? 'sell' : 'buy'))];
    if (!(long[3] === 'C' ? Number(long[4]) < Number(short[4]) : Number(long[4]) > Number(short[4]))) fail();
  } else {
    if (!['SPY','QQQ'].includes(body.symbol)) fail();
    if (body.side === 'sell') {
      if (body.order_class !== 'bracket' || body.type !== 'limit' || body.time_in_force !== 'gtc' ||
          !(Number(body.take_profit?.limit_price) > 0 && Number(body.take_profit.limit_price) < Number(body.limit_price) && Number(body.limit_price) < Number(body.stop_loss?.stop_price)) ||
          Number(body.qty) * Number(body.limit_price) > PAPER_ROUTE_POLICY.shortNotional) fail();
    } else if (body.side !== 'buy' || body.type !== 'market' || body.time_in_force !== 'day' || body.order_class) fail();
  }
  return body;
}
export function mergeRouteOrder(local, remote) {
  if (!remote?.brokerId || remote.id !== local.id || remote.replacedBy || remote.qty !== Number(local.body.qty) || !Number.isFinite(remote.filledQty) || remote.filledQty < (local.filledQty ?? 0) || remote.filledQty > Number(local.body.qty)) throw new Error('paper_route_order_mismatch');
  const expected = local.body.legs ?? [{ symbol: local.body.symbol, side: local.body.side }];
  const fills = local.body.legs ? remote.legs : [remote];
  if (local.body.legs && (!Array.isArray(fills) || fills.length !== 2)) throw new Error('paper_route_legs_missing');
  if (local.body.legs && finished(remote) && fills.some(f => f.filledQty !== remote.filledQty)) throw new Error('paper_route_unbalanced_fill');
  if (remote.status === 'filled' && remote.filledQty !== Number(local.body.qty)) throw new Error('paper_route_incomplete_fill');
  for (const f of fills) {
    const leg = expected.find(x => x.symbol === f.symbol);
    if (!leg || f.side !== leg.side || !Number.isFinite(f.filledQty) || f.filledQty < 0 || f.filledQty > Number(local.body.qty) || (f.filledQty > 0 && !(f.fillPrice > 0))) throw new Error('paper_route_fill_mismatch');
    const prior = (local.legs ?? []).find(x => x.brokerId === f.brokerId);
    if (prior && f.filledQty < prior.filledQty) throw new Error('paper_route_fill_regressed');
  }
  if (!local.body.legs && (remote.legs ?? []).some(l => l.symbol !== local.body.symbol || l.side !== 'buy' || l.replacedBy || !Number.isFinite(l.filledQty) || l.filledQty < 0 || (l.filledQty > 0 && !(l.fillPrice > 0)))) throw new Error('paper_route_bracket_mismatch');
  for (const leg of remote.legs ?? []) {
    const prior = local.legs?.find(x => x.brokerId === leg.brokerId);
    if (prior && leg.filledQty < prior.filledQty) throw new Error('paper_route_fill_regressed');
    if (prior?.feeSource === 'broker_activity_provisional' && leg.fee == null) { leg.fee = prior.fee; leg.feeSource = prior.feeSource; }
  }
  if ((local.legs ?? []).some(l => l.filledQty > 0 && !(remote.legs ?? []).some(r => r.brokerId === l.brokerId))) throw new Error('paper_route_fill_disappeared');
  const { id, body, kind, ts } = local;
  Object.assign(local, remote, { id, body, kind, ts });
}
export function routeFills(t) {
  const fills = new Map();
  for (const o of t.orders) for (const f of o.body.legs ? o.legs ?? [] : [o, ...(o.legs ?? [])]) if (f.brokerId) fills.set(f.brokerId, f);
  return [...fills.values()].filter(f => f.filledQty > 0);
}
export function routeExposure(t) {
  const expected = Object.fromEntries(t.symbols.map(s => [s, 0]));
  let cashFlow = 0, fees = 0;
  for (const f of routeFills(t)) {
    const sign = f.side === 'buy' ? 1 : -1, multiplier = t.route === 'stock_short' ? 1 : 100;
    expected[f.symbol] += sign * f.filledQty;
    cashFlow -= sign * f.filledQty * f.fillPrice * multiplier;
    fees += Number.isFinite(f.fee) && f.fee >= 0 ? f.fee : t.route === 'stock_short' ? f.filledQty * f.fillPrice * .0001 : f.filledQty * PAPER_ROUTE_POLICY.optionFee;
  }
  return { expected, cashFlow, fees };
}
