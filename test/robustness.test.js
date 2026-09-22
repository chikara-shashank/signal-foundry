import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, testConfig, quote } from './helpers.js';
import { Features } from '../src/features.js';
import { CryptoContext } from '../src/crypto-context.js';
import { AlpacaBroker } from '../src/broker.js';
import { parseMessage } from '../src/feeds.js';
import { Microstructure } from '../src/microstructure.js';
import { tradeScorecard, SignalOutcomes } from '../src/research.js';
import { buildReport } from '../scripts/research.js';
import { quantityTolerance } from '../src/portfolio.js';
import { sizeEntry } from '../src/risk.js';
import { createDashboard } from '../src/server.js';
import { once } from 'node:events';

const bars = (now, n=40) => Array.from({length:n}, (_,i) => ({symbol:'ETH/USD', ts:Math.floor(now/300000)*300000-(n-i)*300000, open:100+i, high:102+i, low:99+i, close:101+i, volume:i%3===0?0:10}));
const response = body => ({ok:true,status:200,json:async()=>body});

test('five-minute crypto context uses real interval trends, zero-volume observations and rejects missing groups', () => {
  const f=new Features(5), now=1800000000000; let result;
  for(const b of bars(now)) result=f.add(b,now);
  assert.equal(result.intervalMs,300000); assert.equal(result.count,40);
  assert.ok(result.trend5>0);assert.ok(result.trend15>0);
  assert.equal(f.add({...bars(now).at(-1),ts:now+300000},now+600000),null);
  assert.equal(f.history.get('ETH/USD').length,41);
});

test('crypto history pagination is GET-only, warms without orders and never consumes an incomplete page set',async()=>{
  const f=await fixture({CRYPTO_SYMBOLS:'ETH/USD'}); f.advance(3000);
  try {
    const rows=bars(f.now()); let calls=0, batches=0;
    f.engine.onCryptoHistory=async(symbol,bs,warm)=>{assert.equal(symbol,'ETH/USD');assert.equal(bs.length,40);assert.equal(warm,true);batches++;};
    const h=new CryptoContext(f.engine,async(url,options)=>{
      assert.ok(url.startsWith('https://data.alpaca.markets/'));assert.equal(options.method,undefined);assert.equal(options.body,undefined);
      const part=calls++===0?rows.slice(0,20):rows.slice(20);
      return response({bars:{'ETH/USD':part.map(b=>({t:new Date(b.ts).toISOString(),o:b.open,h:b.high,l:b.low,c:b.close,v:b.volume}))},next_page_token:calls===1?'next':null});
    });
    await h.poll();await h.poll();assert.equal(calls,2);assert.equal(batches,1);assert.equal(f.store.orders().length,0);
    const broken=new CryptoContext(f.engine,async()=>response({bars:{},next_page_token:'more'}));
    await broken.poll();assert.equal(f.engine.cryptoContextStatus.state,'retrying');assert.equal(batches,1);
  }finally{await f.engine.mutex.tail;f.store.close();}
});

test('crypto history warms immediately, only new recent completed bars scan, and actual gaps invalidate old context',async()=>{
  const f=await fixture({CRYPTO_SYMBOLS:'ETH/USD'});
  try {
    let calls=0;f.engine.processCandidates=async()=>{calls++;};
    const rows=bars(f.now());await f.engine.onCryptoHistory('ETH/USD',rows,true);
    assert.equal(calls,0);assert.equal(f.engine.snapshots.get('ETH/USD').intervalMs,300000);
    f.advance(300000);const more=[...rows,{...rows.at(-1),ts:rows.at(-1).ts+300000}];
    await f.engine.onCryptoHistory('ETH/USD',more,false);assert.equal(calls,1);
    await f.engine.onCryptoHistory('ETH/USD',more,false);assert.equal(calls,1);
    f.advance(600000);await f.engine.onCryptoHistory('ETH/USD',[...more,{...more.at(-1),ts:more.at(-1).ts+600000}],false);
    assert.equal(f.engine.snapshots.has('ETH/USD'),false);assert.equal(calls,1);
  }finally{await f.engine.mutex.tail;f.store.close();}
});

test('known broker IDs need one nested lookup and uncertain submissions are not retried',async()=>{
  const requests=[], b=new AlpacaBroker(testConfig(),async(url,opts)=>{requests.push([url,opts]);return response({id:'venue',client_order_id:'local',symbol:'SPY',status:'new',qty:'1',legs:[]});});
  await b.find('local','venue');assert.equal(requests.length,1);assert.ok(requests[0][0].endsWith('/venue?nested=true'));
  let attempts=0;const failing=new AlpacaBroker(testConfig(),async()=>{attempts++;throw new Error('lost response');});
  await assert.rejects(failing.submit({id:'x',symbol:'ETH/USD',kind:'entry',qty:1,limit:100}));assert.equal(attempts,1);
});

test('broker budgets block extra reads, preserve cancellation headroom and honor 429 backoff',async()=>{
  let calls=0;const b=new AlpacaBroker(testConfig(),async()=>{calls++;return response({});});
  b.requests=Array(160).fill(Date.now());assert.equal(b.entryBudgetAvailable(),false);
  await assert.rejects(b.request('/v2/account'), e=>e.notSent===true);
  await b.cancel({brokerId:'x'});assert.equal(calls,1);
  const limited=new AlpacaBroker(testConfig(),async()=>({ok:false,status:429,headers:{get:()=> '30'}}));
  await assert.rejects(limited.request('/v2/account'));assert.ok(limited.blockedUntil>Date.now()+28000);
  await assert.rejects(limited.request('/v2/orders','POST',{}),e=>e.notSent===true);
});

test('saturated order snapshots fail closed instead of hiding external orders',async()=>{
  const b=new AlpacaBroker(testConfig(),async()=>response(Array(500).fill({})));
  await assert.rejects(b.openOrders(),/incomplete/);
});

test('sub-millisecond quotes contribute to OFI and old sub-millisecond updates cannot replace the latest book',()=>{
  const m=new Microstructure(), raw={T:'q',S:'SPY',bp:100,ap:100.02,bs:100,as:50};
  const a=parseMessage({...raw,t:'2026-09-22T15:00:00.123000001Z'}),b=parseMessage({...raw,bs:200,t:'2026-09-22T15:00:00.123000002Z'});
  m.add(a);assert.equal(m.add(b).observations,2);assert.equal(m.add(a).observations,2);
  assert.equal(m.snapshot('SPY',b.ts).imbalance,.6);
});

test('entry expiry follows the signal and IOC cannot linger awaiting a favorable later quote',async()=>{
  const f=await fixture({CRYPTO_SYMBOLS:'ETH/USD'});
  try {
    const c=f.prepare('ETH/USD');c.expires=f.now()+1000;await f.engine.enter(c);
    const order=f.store.orders()[0];assert.equal(order.timeInForce,'ioc');assert.equal(order.entryDeadline,c.expires);
    f.advance(1100);f.engine.onQuote(quote('ETH/USD',f.now()));await f.engine.reconcile();
    assert.equal(f.store.orders()[0].status,'expired');assert.equal(f.engine.positions.length,0);
    f.broker.state.orders={};await f.broker.submit({...order,id:'ioc-test',status:'reserved',ts:f.now(),entryDeadline:f.now()+2000});
    f.broker.onQuote(quote('ETH/USD',f.now()+1,102));assert.equal(f.broker.state.orders['ioc-test'].status,'canceled');
  }finally{await f.engine.mutex.tail;f.store.close();}
});

test('crypto software exit latches a brief price crossing before the next scheduled account poll',async()=>{
  const f=await fixture({CRYPTO_SYMBOLS:'ETH/USD'});
  try {
    f.engine.managed['ETH/USD']={entryId:'owned',stop:99,target:103};let scheduled=0;
    f.engine.scheduleReconcile=()=>{scheduled++;};
    f.engine.onQuote(quote('ETH/USD',f.now(),98));await f.engine.mutex.tail;await new Promise(r=>setImmediate(r));
    f.advance(1);f.engine.onQuote(quote('ETH/USD',f.now(),101));
    assert.equal(f.engine.managed['ETH/USD'].exitReason,'stop');assert.equal(scheduled,1);
  }finally{await f.engine.mutex.tail;f.store.close();}
});

test('signal outcomes use future ask/bid, delay and fees, exclude missing quotes and overlapping samples',async()=>{
  const f=await fixture();
  try {
    const o=new SignalOutcomes(f.engine), c={id:'one',symbol:'SPY',strategy:'range_breakout',preflight:{ok:true},model:{requested:true,quality:.8,pass:true}};
    o.start(c);o.start({...c,id:'two'});assert.equal(o.pending.size,1);
    o.quote(quote('SPY',f.now()),f.now());assert.equal(o.pending.get('SPY').entry,null);
    f.advance(1000);o.quote(quote('SPY',f.now()),f.now());assert.ok(o.pending.get('SPY').entry>100);
    f.advance(180000);o.quote(quote('SPY',f.now(),101),f.now());assert.equal(o.pending.size,0);
    const row=o.summary().rows[0];assert.equal(row.count,1);assert.ok(row.meanNetBps>0 && row.meanNetBps<100);
    o.start({...c,id:'three'});f.advance(7000);o.sweep(f.now());assert.equal(o.summary().rows[0].missing,1);
  }finally{await f.engine.mutex.tail;f.store.close();}
});

test('strategy results deduplicate native fills, freeze fees, separate partial exits and exclude external account drawdown',async()=>{
  const f=await fixture({ACCOUNT_POLICY:'shared'});
  try {
    const exit={id:'x',brokerId:'venue-x',kind:'exit',entryId:'e',symbol:'SPY',status:'filled',filledQty:1,fillPrice:102,feeRateBps:5,ts:f.now()+1};
    const entry={id:'e',symbol:'SPY',strategy:'range_breakout',kind:'entry',status:'filled',filledQty:1,fillPrice:100,feeRateBps:5,ts:f.now(),legs:[exit]};
    f.store.order(entry);f.store.order(exit);
    const result=tradeScorecard(f.store.orders(),{...f.cfg,equityFee:99});assert.equal(result.trades.length,1);assert.equal(result.strategies[0].closed,1);assert.ok(Math.abs(result.strategies[0].netPnl-1.899)<1e-8);
    f.store.event('equity',{dailyPnl:-5000},f.now());f.store.event('agent_equity',{dailyPnl:2},f.now());f.store.event('agent_equity',{dailyPnl:1},f.now()+1);
    const report=buildReport(f.store,f.cfg);assert.equal(report.scope,'agent');assert.equal(report.recordedDailyDrawdownUsd,1);
    entry.filledQty=2;const partial=tradeScorecard([entry,exit],f.cfg);assert.equal(partial.strategies[0].closed,0);assert.equal(partial.strategies[0].partial,1);
  }finally{await f.engine.mutex.tail;f.store.close();}
});

test('crypto rejects targets that cannot pay costs and fee quantity tolerance uses the entry rate',async()=>{
  const f=await fixture({CRYPTO_SYMBOLS:'ETH/USD'});
  try {
    const c=f.prepare('ETH/USD');c.target=100.6;
    const d=sizeEntry(c,f.engine.quotes.get('ETH/USD'),f.engine.account,[],[],f.cfg,f.engine.assets.get('ETH/USD'),f.now(),f.engine.session);
    assert.equal(d.reason,'reward_does_not_clear_cost_buffer');assert.equal(d.economics.feePerSideBps,25);assert.ok(d.economics.roundTripCostBps>50);
    assert.equal(quantityTolerance({symbol:'ETH/USD',filledQty:1,feeRateBps:10},{cryptoFee:99},{min_trade_increment:.00001}),.00151);
  }finally{await f.engine.mutex.tail;f.store.close();}
});

test('isolated absent crypto bucket stays absent and only recovers after fresh consecutive evidence',()=>{
  const f=new Features(5), now=1800000000000, source=bars(now,40);source.splice(25,1);
  let result;for(const b of source)result=f.add(b,now);
  assert.ok(result);assert.equal(result.count,39);assert.equal(result.coverage,39/40);
  assert.equal(f.history.get('ETH/USD').length,39);
  const sparse=new Features(5);let bad;for(const [i,b] of bars(now,40).entries())if(i%10!==5)bad=sparse.add(b,now);
  assert.equal(bad,null);
});

test('research endpoint is authenticated, read-only and excludes credentials',async()=>{
  const f=await fixture(),server=createDashboard(f.engine,f.cfg);server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const url=`http://127.0.0.1:${server.address().port}/api/research`;
    assert.equal((await fetch(url)).status,401);
    const response=await fetch(url,{headers:{Authorization:`Bearer ${f.cfg.token}`}});assert.equal(response.status,200);
    const body=await response.text();assert.equal(body.includes(f.cfg.token),false);assert.equal(JSON.parse(body).strategies.length,0);
    assert.equal(f.store.orders().length,0);
  }finally{await new Promise(r=>server.close(r));f.store.close();}
});
