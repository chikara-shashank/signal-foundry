import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, quote, inlineWorkers } from './helpers.js';
import { Engine } from '../src/engine.js';
import { MarketSchedule } from '../src/market-schedule.js';
import { ResearchDesk, normalizeNews } from '../src/research-desk.js';
import { closingPattern, overnightAllocation, favorableNews } from '../src/overnight-policy.js';
import { newsDigest } from '../src/news-analysis.js';
import { AlpacaBroker } from '../src/broker.js';
import { nyTimestamp } from '../src/util.js';
import { strategyManifest } from '../src/strategy-manifest.js';

const dispose=async f=>{f.engine.stopped=true;clearTimeout(f.engine.streamReconcile);await f.engine.mutex.tail;f.store.close();};
const bars=(symbol,end)=>Array.from({length:60},(_,i)=>({symbol,ts:end-(60-i)*60000,open:100+i*.015,close:100+(i+1)*.015,high:100+(i+1)*.015+.01,low:100+i*.015-.01,volume:i<30?10000:20000}));
async function carryFixture() {
  const f=await fixture({MODE:'shadow',ALPACA_KEY:'test',ALPACA_SECRET:'test',EQUITY_SYMBOLS:'SPY,QQQ,AAPL,MSFT',CRYPTO_UNIVERSE:'off',JEV_MODE:'shadow',TYPESAFE_API_KEY:'test'}),e=f.engine;
  f.advance(nyTimestamp('2026-09-22','15:35')-f.now());
  e.schedule=new MarketSchedule(e,{});e.schedule.cache={fetchedAt:f.now(),through:'2026-09-25',rows:['22','23','24','25'].map(d=>({date:`2026-09-${d}`,open:nyTimestamp(`2026-09-${d}`,'09:30'),close:nyTimestamp(`2026-09-${d}`,'16:00')}))};
  f.broker.clock=async now=>({...e.schedule.state(now).today,open:e.schedule.state(now).regular,ts:now});
  e.desk=new ResearchDesk(e);e.desk.state.newsComplete=true;e.desk.state.newsAt=f.now();e.desk.state.sourceSession='2026-09-22';
  for(const symbol of f.cfg.equities) {
    const bs=bars(symbol,f.now());e.features.history.set(symbol,bs);e.desk.state.patterns.push({symbol,session:'2026-09-22',pattern:closingPattern(bs,e.schedule.state().today,f.now())});
    const article=normalizeNews({id:symbol,created_at:new Date(f.now()-60000).toISOString(),headline:'Company reports signed commercial agreement',summary:'A material agreement was announced.',symbols:[symbol],url:'https://example.com/news'},f.now());e.desk.articles.push(article);
    e.desk.views[symbol]={symbol,at:f.now(),latestPublishedAt:article.publishedAt,digest:newsDigest(symbol,[article],f.cfg),direction:'positive',relevance:.95,confidence:.95,materiality:1,materialityConfidence:.95,hazard:'none_identified',hazardConfidence:.95};
    e.onQuote(quote(symbol,f.now(),bs.at(-1).close));
  }
  await e.reconcile();return f;
}
test('closing pattern requires completed contiguous bars, participation and strength without future leakage',()=>{
  const end=nyTimestamp('2026-09-22','15:35'),s={open:end-5*3600000,close:end+25*60000},bs=bars('SPY',end);
  assert.equal(closingPattern(bs,s,end).matched,true);assert.equal(closingPattern(bs.filter((_,i)=>i!==35),s,end),null);
  assert.equal(closingPattern(bs.map(b=>({...b,volume:1000})),s,end).matched,false);
  assert.deepEqual(closingPattern([...bs,{...bs.at(-1),ts:end,close:10000}],s,end),closingPattern(bs,s,end));
  assert.equal(favorableNews({at:end,latestPublishedAt:end,relevance:1,confidence:1,direction:'positive',materiality:1,materialityConfidence:.5,hazard:'none_identified',hazardConfidence:1},end),false);
});
test('simultaneous carry signals reserve aggregate capital below ten percent and preserve per-position limits',async()=>{
  const f=await carryFixture();try{
    await Promise.all(f.cfg.equities.map(s=>f.engine.desk.onBar(f.engine.features.history.get(s).at(-1))));
    const entries=f.store.orders();assert.equal(entries.length,3);assert.ok(entries.every(o=>o.reserved<=350));
    const allocation=overnightAllocation(f.engine);assert.ok(allocation.exposure<=950);assert.ok(allocation.exposure<allocation.base*.1);assert.equal(allocation.held,0);assert.ok(allocation.reserved>900);
    assert.ok(entries.every(o=>o.timeInForce==='gtc'&&o.holdingPolicy.exitBy===nyTimestamp('2026-09-25','15:55')));
    assert.ok(entries[0].experiment.manifest===undefined);assert.equal(entries[0].experiment.parameters.overnight.capFraction,.095);
  }finally{await dispose(f);}
});
test('carry rejects stale/revised news, incomplete intake, a closed window and sizing bypasses',async()=>{
  const f=await carryFixture();try{
    const e=f.engine,bar=e.features.history.get('SPY').at(-1);
    e.desk.state.newsComplete=false;await e.desk.onBar(bar);assert.equal(f.store.orders().length,0);assert.equal(f.store.candidates(1)[0].reason,'carry_thesis_stale');
    e.desk.state.newsComplete=true;e.desk.articles[0].digest='revised';await e.desk.onBar(bar);assert.equal(f.store.orders().length,0);assert.equal(e.desk.currentView('SPY'),null);
    const c={symbol:'QQQ',strategy:'close_strength_carry',holdingPolicy:{type:'carry',exitBy:f.now()+3600000},sizing:{notional:5000}};assert.equal(e.checkEntry(c).reason,'carry_policy_invalid');
    f.advance(21*60000);assert.equal(e.checkEntry({...c,sizing:undefined}).reason,'carry_entry_window_closed');
  }finally{await dispose(f);}
});
test('carry allocation counts partial fills and unfilled buys once, ignores outside account capital and falls with losses',async()=>{
  const f=await carryFixture();try{
    const e=f.engine;await e.desk.onBar(e.features.history.get('SPY').at(-1));const o=f.store.orders()[0];
    o.filledQty=1;o.fillPrice=101;o.status='partially_filled';f.store.order(o);e.account.equity=1e6;e.portfolio.state.totalPnl=-1000;
    const a=overnightAllocation(e);assert.equal(a.base,9000);assert.equal(a.cap,855);assert.ok(Math.abs(a.held-101)<1e-9);assert.ok(Math.abs(a.reserved-(o.qty-1)*o.limit*1.0001)<1e-7);
    e.portfolio.state.valid=false;assert.equal(overnightAllocation(e).headroom,0);assert.equal(overnightAllocation(e).breached,false);
  }finally{await dispose(f);}
});
test('paper broker sends carry GTC brackets while ordinary intraday entries remain DAY',async()=>{
  const f=await carryFixture();try{
    const bodies=[],broker=new AlpacaBroker(f.cfg,async(url,o)=>{bodies.push(JSON.parse(o.body));return {ok:true,status:200,json:async()=>({id:'broker',symbol:'SPY',status:'new',time_in_force:bodies.at(-1).time_in_force})};});
    await broker.submit({id:'carry',symbol:'SPY',kind:'entry',qty:2,limit:101,stop:99,target:104,holdingPolicy:{type:'carry'}});
    await broker.submit({id:'day',symbol:'SPY',kind:'entry',qty:2,limit:101,stop:99,target:104});
    assert.equal(bodies[0].time_in_force,'gtc');assert.equal(bodies[0].order_class,'bracket');assert.equal(bodies[0].extended_hours,undefined);assert.equal(bodies[1].time_in_force,'day');
  }finally{await dispose(f);}
});
test('carry survives the intraday timeout and session end; off-hours exits preserve native protection',async()=>{
  const f=await carryFixture();try{
    const e=f.engine;await e.desk.onBar(e.features.history.get('SPY').at(-1));f.advance(1000);e.onQuote(quote('SPY',f.now(),100.9));await e.reconcile();
    assert.ok(e.managed.SPY);const parent=f.store.orders()[0];parent.legs=[{id:'stop',brokerId:'stop',symbol:'SPY',type:'stop',status:'new',brokerTimeInForce:'gtc',filledQty:0}];parent.brokerTimeInForce='gtc';f.store.order(parent);
    f.advance(nyTimestamp('2026-09-22','15:58')-f.now());e.session={open:true,close:nyTimestamp('2026-09-22','16:00')};e.managed.SPY.openedAt=f.now()-2*3600000;
    let cancels=0,sells=0;f.broker.cancel=async()=>{cancels++;};f.broker.submit=async()=>{sells++;};
    await e.manageExits(f.now());assert.equal(e.managed.SPY.exitReason,null);assert.equal(cancels,0);
    e.cfg.mode='paper';e.session.open=false;e.managed.SPY.exitReason='carry_news_invalidated';await e.manageExits(f.now()+86400000);assert.equal(cancels,0);assert.equal(sells,0);
    e.session.open=true;await e.manageExits(f.now()+86400000);assert.equal(cancels,1);assert.equal(sells,0);
  }finally{await dispose(f);}
});
test('oversized carry exposure cancels buys and queues owned reductions, never outside holdings',async()=>{
  const f=await carryFixture();try{
    const e=f.engine;await e.desk.onBar(e.features.history.get('SPY').at(-1));const parent=f.store.orders()[0];parent.status='filled';parent.filledQty=20;parent.qty=20;parent.fillPrice=100;f.store.order(parent);
    e.managed.SPY={entryId:parent.id};e.managed.QQQ={entryId:'intraday'};e.positions=[{symbol:'SPY',qty:20,marketValue:2000}];
    e.desk.enforceAllocation(f.now());assert.equal(e.managed.SPY.exitReason,'carry_allocation_reduction');assert.equal(e.managed.QQQ.exitReason,undefined);assert.match(e.desk.state.allocationAlert.reason,/next regular session/);
    parent.legs=[{filledQty:20,fillPrice:100}];f.store.order(parent);e.desk.enforceAllocation(f.now());assert.equal(e.desk.state.allocationAlert,null);
  }finally{await dispose(f);}
});
test('manual carry toggle survives restart and changes in carry rules create a new experiment',async()=>{
  const f=await carryFixture();try{
    const e=f.engine;assert.equal(e.strategyControls.enabled('close_strength_carry'),true);const before=strategyManifest(e,'close_strength_carry').experimentId;
    f.cfg.overnight.sessions=2;assert.notEqual(strategyManifest(e,'close_strength_carry').experimentId,before);
    await e.strategyControls.update({strategy:'close_strength_carry',enabled:false,expectedRevision:0});
    const next=new Engine(f.cfg,f.store,f.broker,inlineWorkers,f.now);assert.equal(next.strategyControls.enabled('close_strength_carry'),false);
  }finally{await dispose(f);}
});
test('fresh adverse news blocks new stock longs and invalidates a held carry thesis',async()=>{
  const f=await carryFixture();try{
    const e=f.engine;await e.desk.onBar(e.features.history.get('SPY').at(-1));f.advance(1000);e.onQuote(quote('SPY',f.now(),100.9));await e.reconcile();
    e.desk.views.SPY.direction='negative';assert.equal(e.checkEntry({symbol:'SPY',strategy:'range_breakout'}).reason,'company_news_adverse');
    await e.manageExits(f.now());assert.equal(e.managed.SPY.exitReason,'carry_news_invalidated');
  }finally{await dispose(f);}
});
test('carry holding deadline executes in an exchange session and preserves protection in the last 30 seconds',async()=>{
  const f=await carryFixture();try{
    const e=f.engine;await e.desk.onBar(e.features.history.get('SPY').at(-1));f.advance(1000);e.onQuote(quote('SPY',f.now(),100.9));await e.reconcile();
    const p=f.store.orders()[0];p.holdingPolicy.exitBy=f.now();p.legs=[{id:'guard',brokerId:'guard',type:'stop',status:'new',filledQty:0}];f.store.order(p);let canceled=0;f.broker.cancel=async()=>{canceled++;};
    f.advance(nyTimestamp('2026-09-22','15:59')+45000-f.now());e.session.open=true;
    await e.manageExits(f.now());assert.equal(e.managed.SPY.exitReason,'carry_holding_deadline');assert.equal(canceled,0);
    f.advance(nyTimestamp('2026-09-23','09:31')-f.now());e.schedule.cache.fetchedAt=f.now();await e.manageExits(f.now());assert.equal(canceled,1);
  }finally{await dispose(f);}
});
