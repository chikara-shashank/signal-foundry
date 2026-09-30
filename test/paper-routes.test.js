import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { PaperRoutes } from '../src/paper-routes.js';
import { AlpacaBroker } from '../src/broker.js';
import { shortBody, spreadBody, routeExposure, validatePaperBody, mergeRouteOrder } from '../src/paper-route-orders.js';
import { createDashboard } from '../src/server.js';
import { nyDate } from '../src/util.js';

function observation(now, bear = true) {
  const expiry = '2026-10-12', type = bear ? 'put' : 'call', date = nyDate(now);
  const contract = strike => ({ symbol: `SPY261012${bear ? 'P' : 'C'}${String(strike * 1000).padStart(8, '0')}`, underlying: 'SPY', root: 'SPY', expiry, type,
    style: 'american', status: 'active', tradable: true, strike, multiplier: 100, size: 100, openInterest: 1000, oiDate: date,
    deliverables: [{ type: 'equity', symbol: 'SPY', amount: '100', allocation_percentage: '100', delayed_settlement: false }] });
  const long = contract(bear ? 101 : 100), short = contract(bear ? 100 : 101);
  const q = (bid, delta) => ({ bid, ask: bid + .02, bidSize: 100, askSize: 100, condition: ' ', ts: now, delta, iv: .25 });
  return { now, source: 'alpaca_opra', stockFeed: 'sip', clockUncertaintyMs: 50, marketOpen: true, universe: ['SPY'],
    session: { date, open: now - 5400000, close: now + 18000000 },
    spots: { SPY: { price: 100.2, bid: 100.19, ask: 100.21, bidSize: 100, askSize: 100, ts: now } },
    assets: { SPY: { at: now, status: 'active', tradable: true, shortable: true, easyToBorrow: true } },
    contexts: { SPY: { intradayReady: true, barEnd: now - 1000, close: bear ? 99 : 102, rangeHigh: bear ? 101 : 100.1, rangeLow: bear ? 100.3 : 99, vwap: bear ? 100.5 : 100,
      through: now - 86400000, rv20: .15, sma20: 99, sma50: 98, previousClose: 100 } },
    contracts: { [long.symbol]: long, [short.symbol]: short }, quotes: { [long.symbol]: q(1.5, bear ? -.55 : .55), [short.symbol]: q(1, bear ? -.2 : .4) } };
}
async function setup(overrides = {}) {
  const f = await fixture({ MODE: 'paper', ALPACA_KEY: 'test', ALPACA_SECRET: 'test', ACCOUNT_POLICY: 'shared', RESEARCH_CONTEXT_MODE: 'off', ...overrides });
  f.advance(6 * 86400000); const b = f.broker, routes = new Map(), positions = new Map(); let calls = 0;
  const account = b.account.bind(b), find = b.find.bind(b);
  b.account = async now => ({ ...await account(now), shortingEnabled: true, optionsTradingLevel: 3, optionsBuyingPower: 10000 });
  b.entryBudgetAvailable = () => true;
  b.positions = async () => [...positions.values()];
  b.openOrders = async () => [...routes.values()].filter(o => !['filled','canceled','rejected'].includes(o.status)).map(o => structuredClone(o));
  b.find = async (id, brokerId) => structuredClone([...routes.values()].find(o => o.id === id || o.brokerId === brokerId)) ?? find(id, brokerId);
  b.submitPaperRoute = async body => {
    calls++; validatePaperBody(body);
    const r = { id: body.client_order_id, brokerId: body.client_order_id, qty: Number(body.qty), status: 'new', filledQty: 0, fillPrice: 0,
      symbol: body.symbol ?? 'SPY', side: body.side, orderClass: body.order_class ?? 'simple',
      legs: (body.legs ?? []).map((l,i) => ({ brokerId: body.client_order_id + '-' + i, symbol: l.symbol, side: l.side, qty: 1, filledQty: 0, fillPrice: 0, status: 'new' })) };
    routes.set(r.id, r); return structuredClone(r);
  };
  b.cancel = async o => { const r = [...routes.values()].flatMap(r => [r,...r.legs]).find(x => x.brokerId === o.brokerId); if (r) r.status = 'canceled'; };
  await f.engine.reconcile(); await f.engine.paperRoutes.update({ enabled: true, expectedRevision: 0 });
  const fill = (order, prices, qty = order.qty) => {
    order.status = qty === order.qty ? 'filled' : 'partially_filled'; order.filledQty = qty;
    const items = order.orderClass === 'mleg' ? order.legs : [order];
    for (let i = 0; i < items.length; i++) {
      const l = items[i], price = prices[i]; l.filledQty = qty; l.fillPrice = price; l.status = order.status;
      const old = positions.get(l.symbol)?.qty ?? 0, next = old + (l.side === 'buy' ? qty : -qty), multiplier = order.orderClass === 'mleg' ? 100 : 1;
      b.state.cash += (l.side === 'sell' ? 1 : -1) * qty * price * multiplier;
      if (!next) positions.delete(l.symbol); else positions.set(l.symbol, { symbol: l.symbol, qty: next, availableQty: next, marketValue: next * price * multiplier, unrealized: 0, entryPrice: price, side: next < 0 ? 'short' : 'long' });
    }
  };
  return { ...f, routes, positions, fill, calls: () => calls, capture: async bear => f.engine.mutex.run(() => f.engine.paperRoutes.observe(observation(f.now(), bear))),
    close: async () => { await f.engine.mutex.tail; f.store.close(); } };
}
test('paper account capability checks prevent unsupported shorts and spreads', async () => {
  const f = await setup();
  try { f.engine.account.shortingEnabled = false; f.engine.account.optionsTradingLevel = 2; await f.capture(true); assert.equal(f.calls(), 0); }
  finally { await f.close(); }
});
test('Jev filter blocks independent route entries at observation and submission boundaries',async()=>{
  const f=await setup();try{
    f.cfg.jevMode='filter';await f.capture(true);await f.capture(false);assert.equal(f.calls(),0);
    assert.equal(f.engine.paperRoutes.lastDecision.reason,'jev_route_review_required');
    await assert.rejects(f.engine.paperRoutes.send({}, {}, 'entry'),/jev_route_review_required/);
  }finally{await f.close();}
});
test('enabling Jev filter never blocks protective exits for already owned routes',async()=>{
  const f=await setup();try{
    await f.capture(false);const t=f.engine.paperRoutes.active()[0];f.fill(f.routes.get(t.orders[0].id),[1.5,1]);await f.engine.reconcile();
    f.cfg.jevMode='filter';await f.engine.control('flatten');await f.engine.reconcile();
    assert.equal(t.orders.length,2);assert.equal(t.orders[1].kind,'exit');
  }finally{await f.close();}
});
test('short sells first, shares global capital, then buys only the reconciled quantity to close', async () => {
  const f = await setup();
  try {
    await f.capture(true); const t = f.engine.paperRoutes.active()[0], entry = f.routes.get(t.orders[0].id);
    assert.equal(t.route, 'stock_short'); assert.equal(t.orders[0].body.side, 'sell'); assert.ok(t.qty * t.limit <= 1000);
    f.fill(entry, [100.19]); await f.engine.reconcile();
    assert.equal(f.engine.ready, true); assert.equal(f.engine.externalSymbols.has('SPY'), false);
    assert.ok(f.engine.portfolio.state.totalPnl < 0); assert.ok(f.engine.paperRoutes.capitalReserved() >= t.qty * t.limit);
    assert.equal(f.engine.checkEntry({ symbol: 'SPY' }).reason, 'paper_route_symbol_reserved');
    await f.engine.control('flatten'); await f.engine.reconcile(); const exit = t.orders[1];
    assert.equal(exit.body.side, 'buy'); assert.equal(Number(exit.body.qty), t.qty);
    f.fill(f.routes.get(exit.id), [99]); await f.engine.reconcile();
    assert.equal(f.engine.paperRoutes.active().length, 0); assert.ok(f.engine.portfolio.state.totalPnl > 0);
    assert.equal(f.store.orders().length, 0);
  } finally { await f.close(); }
});
test('bracket cancellation must be acknowledged before a buy-to-cover is sent', async () => {
  const f = await setup();
  try {
    await f.capture(true); const t = f.engine.paperRoutes.active()[0], entry = f.routes.get(t.orders[0].id); f.fill(entry, [100.19]);
    entry.legs = [{ brokerId: 'native-stop', symbol: 'SPY', side: 'buy', qty: t.qty, filledQty: 0, fillPrice: 0, type: 'stop', status: 'new' }];
    let cancels = 0; f.broker.cancel = async () => { cancels++; };
    await f.engine.reconcile(); await f.engine.control('flatten'); await f.engine.reconcile();
    assert.equal(t.orders.length, 1); assert.equal(cancels, 1);
    entry.legs[0].status = 'canceled'; await f.engine.reconcile(); assert.equal(t.orders.length, 2); assert.equal(t.orders[1].body.side, 'buy');
  } finally { await f.close(); }
});
test('partial short entry is canceled, then the actual fill is covered without reversing long', async () => {
  const f = await setup();
  try {
    await f.capture(true); const t = f.engine.paperRoutes.active()[0], entry = f.routes.get(t.orders[0].id); assert.ok(t.qty > 1);
    f.fill(entry, [100.19], 1); f.advance(21000); await f.engine.reconcile(); assert.equal(t.orders.length, 1);
    await f.engine.reconcile(); assert.equal(t.orders[1].body.qty, '1'); assert.equal(t.orders[1].body.side, 'buy');
  } finally { await f.close(); }
});
test('lost acknowledgment and restart recover by client ID without sending a second order', async () => {
  const f = await setup();
  try {
    const send = f.broker.submitPaperRoute; f.broker.submitPaperRoute = async body => { await send(body); throw Error('lost response'); };
    await f.capture(true); assert.equal(f.calls(), 1); assert.equal(f.engine.paperRoutes.active()[0].orders[0].status, 'unknown');
    f.engine.paperRoutes = new PaperRoutes(f.engine); assert.equal(f.engine.paperRoutes.stats.valid, false);
    await f.engine.reconcile(); assert.equal(f.engine.paperRoutes.active()[0].orders[0].status, 'new');
    await f.capture(true); assert.equal(f.calls(), 1);
  } finally { await f.close(); }
});
test('unknown missing submission remains reserved and blocks all new entries', async () => {
  const f = await setup();
  try {
    f.broker.submitPaperRoute = async () => { throw Error('timeout'); }; await f.capture(true); await f.engine.reconcile();
    assert.equal(f.engine.ready, false); assert.ok(f.engine.paperRoutes.capitalReserved() > 0);
    assert.equal(f.engine.checkEntry({symbol:'QQQ'}).reason, 'paper_route_reconciliation_required');
  } finally { await f.close(); }
});
test('debit spread uses one packaged entry and inverse close intents with 100-share cash accounting', async () => {
  const f = await setup();
  try {
    await f.capture(false); const t = f.engine.paperRoutes.active()[0]; assert.equal(t.route, 'call_debit');
    const entry = t.orders[0]; assert.equal(entry.body.order_class, 'mleg'); assert.equal(entry.body.qty, '1');
    assert.deepEqual(entry.body.legs.map(l => l.position_intent), ['buy_to_open','sell_to_open']);
    f.fill(f.routes.get(entry.id), [1.5, 1]); await f.engine.reconcile();
    assert.equal(f.engine.ready, true); assert.equal(f.engine.portfolio.state.valid, true);
    assert.equal(f.engine.paperRoutes.stats.cashFlow, -50); assert.equal(f.engine.paperRoutes.stats.fees, 1.3);
    await f.engine.control('flatten'); await f.engine.reconcile(); const exit = t.orders[1];
    assert.equal(exit.body.order_class, 'mleg'); assert.deepEqual(exit.body.legs.map(l => l.position_intent), ['sell_to_close','buy_to_close']);
    f.fill(f.routes.get(exit.id), [1.7, 1]); await f.engine.reconcile();
    assert.equal(f.engine.paperRoutes.active().length, 0); assert.ok(Math.abs(f.engine.portfolio.state.totalPnl - 17.4) < 1e-8);
  } finally { await f.close(); }
});
test('mismatched stock quantities or assignment-like extra stock pause entries and prevent unsafe flatten', async () => {
  for (const bear of [true,false]) {
    const f = await setup();
    try {
      await f.capture(bear); const t = f.engine.paperRoutes.active()[0]; f.fill(f.routes.get(t.orders[0].id), bear ? [100.19] : [1.5,1]);
      if (bear) f.positions.get('SPY').qty -= 1;
      else f.positions.set('SPY', {symbol:'SPY',qty:100,availableQty:100,marketValue:10000,unrealized:0});
      await f.engine.reconcile(); assert.equal(f.engine.ready, false); assert.equal(f.engine.portfolio.state.valid, false);
      await f.engine.control('flatten'); await f.engine.reconcile(); assert.equal(t.orders.length, 1);
    } finally { await f.close(); }
  }
});
test('asymmetric option fills cannot be recorded as closed or authorize a new order', async () => {
  const f = await setup();
  try {
    await f.capture(false); const t = f.engine.paperRoutes.active()[0], r = f.routes.get(t.orders[0].id);
    r.status = 'filled'; r.filledQty = 1; r.legs[0].filledQty = 1; r.legs[0].fillPrice = 1.5;
    await f.engine.reconcile(); assert.equal(f.engine.ready, false); assert.equal(t.closedAt, undefined); assert.equal(t.orders.length, 1);
  } finally { await f.close(); }
});
test('expiry horizon and missing option quotes trigger a package close even when entries are disabled', async () => {
  const f = await setup();
  try {
    await f.capture(false); const t = f.engine.paperRoutes.active()[0]; f.fill(f.routes.get(t.orders[0].id), [1.5,1]); await f.engine.reconcile();
    await f.engine.paperRoutes.update({enabled:false,expectedRevision:1}); f.advance(91000); await f.engine.reconcile();
    assert.equal(t.exitReason, 'option_quote_gap'); assert.equal(t.orders[1].body.type, 'market'); assert.equal(t.orders[1].body.order_class, 'mleg');
  } finally { await f.close(); }
});
test('route loss ceiling persists across restart and disables new entries', async () => {
  const f = await setup();
  try {
    await f.capture(true); const t = f.engine.paperRoutes.active()[0]; f.fill(f.routes.get(t.orders[0].id), [100.19]);
    f.positions.get('SPY').marketValue = -t.qty * 130; await f.engine.reconcile();
    assert.equal(f.store.get(`paperRouteHalt:${nyDate(f.now())}`), true);
    f.engine.paperRoutes = new PaperRoutes(f.engine); assert.equal(f.store.get(`paperRouteHalt:${nyDate(f.now())}`), true);
  } finally { await f.close(); }
});
test('paper broker boundary rejects live host, naked options, reversed spreads and excessive debit', async () => {
  let calls = 0; const broker = new AlpacaBroker({mode:'live',brokerUrl:'https://api.alpaca.markets'}, async () => { calls++; });
  await assert.rejects(broker.submitPaperRoute({}), /forbidden/); assert.equal(calls, 0);
  const f = await setup();
  try {
    await f.capture(false); const body = f.engine.paperRoutes.active()[0].orders[0].body;
    for (const alter of [b => b.legs.pop(), b => b.limit_price = '3', b => b.legs.reverse().forEach((l,i) => {l.side=i?'sell':'buy';l.position_intent=l.side+'_to_open';})]) {
      const b = structuredClone(body); alter(b); assert.throws(() => validatePaperBody(b));
    }
    const cfg = f.engine.cfg; f.engine.cfg = {...cfg,mode:'live'}; assert.equal(f.engine.paperRoutes.enabled(), false);
    await assert.rejects(f.engine.paperRoutes.update({enabled:true,expectedRevision:1}), /paper account/);
  } finally { await f.close(); }
});
test('settings require authentication, same origin and a fresh revision', async () => {
  const f = await setup(), server = createDashboard(f.engine, f.cfg); await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/paper-routes`, headers = {Authorization:`Bearer ${f.cfg.token}`,'Content-Type':'application/json'};
    assert.equal((await fetch(url)).status,401);
    assert.equal((await fetch(url,{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:'{}'})).status,403);
    assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({enabled:false,expectedRevision:0})})).status,409);
  } finally { await new Promise(resolve => server.close(resolve)); await f.close(); }
});

test('global position limits include an owned paper route and pause cancels its pending entry', async () => {
  const f = await setup({MAX_POSITIONS:'1'});
  try {
    await f.capture(true); await f.engine.reconcile();
    assert.equal(f.engine.checkEntry(f.prepare('QQQ')).reason, 'position_limit');
    await f.engine.control('pause'); await f.engine.reconcile(); await f.engine.reconcile();
    assert.equal(f.engine.paperRoutes.active().length, 0); assert.equal(f.calls(), 1);
  } finally { await f.close(); }
});
test('unknown broker IDs cannot claim external orders, and external options reserve the underlying', async () => {
  const f = await setup();
  try {
    f.broker.submitPaperRoute = async () => { throw Error('timeout'); }; await f.capture(true);
    assert.equal(f.engine.paperRoutes.ownsOrder({id:'external'}), false);
  } finally { await f.close(); }
  const g = await setup();
  try {
    g.positions.set('SPY261012C00100000', {symbol:'SPY261012C00100000',qty:1,marketValue:100,availableQty:1});
    await g.engine.reconcile(); await g.capture(false); assert.equal(g.calls(), 0);
  } finally { await g.close(); }
});
test('missing individual option quotes close the spread despite fresh observation timestamps', async () => {
  const f = await setup();
  try {
    await f.capture(false); const t = f.engine.paperRoutes.active()[0]; f.fill(f.routes.get(t.orders[0].id), [1.5,1]); await f.engine.reconcile();
    f.advance(91000); const frame = observation(f.now(), false); frame.quotes = {}; f.engine.paperRoutes.lastFrame = frame;
    await f.engine.reconcile(); assert.equal(t.exitReason, 'option_quote_gap'); assert.equal(t.orders.length, 2);
  } finally { await f.close(); }
});
test('restart retains signed holdings; native fills retain fees and cannot disappear or reverse exposure silently', async () => {
  const f = await setup();
  try {
    await f.capture(true); let t = f.engine.paperRoutes.active()[0]; const entry = f.routes.get(t.orders[0].id); f.fill(entry,[100.19]); await f.engine.reconcile();
    f.engine.paperRoutes = new PaperRoutes(f.engine); await f.engine.reconcile(); t = f.engine.paperRoutes.active()[0];
    assert.equal(f.engine.ready,true); assert.equal(f.calls(),1);
    entry.legs = [{brokerId:'stop',symbol:'SPY',side:'buy',qty:t.qty,filledQty:t.qty,fillPrice:101,status:'filled'}];
    f.positions.clear(); await f.engine.reconcile(); assert.ok(t.closedAt);
    const local = t.orders[0]; local.legs[0].fee = .22; local.legs[0].feeSource = 'broker_activity_provisional';
    mergeRouteOrder(local, structuredClone(entry)); assert.equal(local.legs[0].fee,.22);
    assert.throws(() => mergeRouteOrder(local, {...entry,legs:[]}), /disappeared/);
    assert.throws(() => mergeRouteOrder(local, {...entry,legs:[{...entry.legs[0],filledQty:0}]}), /regressed/);
  } finally { await f.close(); }
});
test('drawdown sizing halves shorts, rejects oversized whole spreads, and retains closed route losses', async () => {
  const f = await setup({RISK_LEVELS:'auto'});
  try {
    f.engine.riskLevels.state.brake = 'halved'; await f.capture(false); assert.equal(f.calls(),0);
    f.advance(60000); await f.engine.reconcile(); f.engine.riskLevels.state.brake = 'halved'; await f.capture(true);
    const t = f.engine.paperRoutes.active()[0]; assert.ok(t.qty * t.limit <= 500); assert.ok(t.risk <= 50);
    f.fill(f.routes.get(t.orders[0].id),[100.19]); await f.engine.reconcile(); await f.engine.control('flatten'); await f.engine.reconcile();
    f.fill(f.routes.get(t.orders[1].id),[102]); f.advance(31000); await f.engine.reconcile();
    assert.ok(t.closedAt); assert.ok(f.engine.paperRoutes.stats.totalPnl < 0);
    assert.ok(Math.abs(f.engine.riskLevels.state.pnl - f.engine.paperRoutes.stats.totalPnl) < 1e-8);
  } finally { await f.close(); }
});
