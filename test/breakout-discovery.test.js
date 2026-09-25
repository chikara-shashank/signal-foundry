import test from 'node:test';
import assert from 'node:assert/strict';
import { breakoutPolicy, observeBreakout, breakoutInvalidated } from '../src/breakout-exits.js';
import { EquityUniverse, eligibleEquities, screenSnapshot, contextShortlist } from '../src/equity-universe.js';
import { AlpacaFeed } from '../src/feeds.js';
import { Engine } from '../src/engine.js';
import { strategyManifest } from '../src/strategy-manifest.js';
import { testConfig, fixture, quote, inlineWorkers } from './helpers.js';

const entry=(cfg=testConfig())=>({id:'entry',symbol:'SPY',strategy:'range_breakout',filledAt:1000,fillPrice:100,filledQty:2,stop:98,feeRateBps:1,
  exitPolicy:breakoutPolicy({strategy:'range_breakout',symbol:'SPY',features:{rangeHigh:99.9,atr:1}},cfg)});
const close=async f=>{f.engine.stopped=true;clearTimeout(f.engine.streamReconcile);await f.engine.mutex.tail;f.store.close();};
test('a tiny positive mark does not arm protection; a 1R move creates a cost-aware floor that only rises',()=>{
  const e=entry(),m={openedAt:1000};
  assert.equal(observeBreakout(m,e,{bid:100.02,ts:2000},2000),null);assert.equal(m.excursion.floor,undefined);assert.ok(m.excursion.lastNet<0);
  observeBreakout(m,e,{bid:102.1,ts:3000},3000);const first=m.excursion.floor;assert.ok(first>100.05);
  observeBreakout(m,e,{bid:103,ts:4000},4000);assert.ok(m.excursion.floor>first);
  const floor=m.excursion.floor;assert.equal(observeBreakout(m,e,{bid:floor-.01,ts:5000},5000),'profit_protection');assert.equal(m.excursion.floor,floor);
});
test('legacy trades are measured but not silently migrated; new partial-fill cost basis starts a fresh mark segment',()=>{
  const e=entry(),m={};delete e.exitPolicy;observeBreakout(m,e,{bid:105,ts:2000},2000);
  assert.equal(observeBreakout(m,e,{bid:100,ts:3000},3000),null);assert.equal(m.excursion.floor,undefined);
  const newer={...entry(),filledQty:3,fillPrice:101};observeBreakout(m,newer,{bid:101.1,ts:4000},4000);
  assert.equal(m.excursion.maxBid,101.1);assert.equal(m.excursion.fillQty,3);
});
test('partial exits keep the per-share protection floor but suppress incompatible dollar peaks',()=>{
  const e=entry(),m={};observeBreakout(m,e,{bid:103,ts:2000},2000,2);assert.ok(m.excursion.peakNet>0);
  const floor=m.excursion.floor;observeBreakout(m,e,{bid:102,ts:3000},3000,1);
  assert.equal(m.excursion.peakNet,null);assert.equal(m.excursion.netComparable,false);assert.equal(m.excursion.floor,floor);
});
test('invalidation uses the entry range and a fresh completed post-fill bar; no-progress exits require observed quotes',()=>{
  const e=entry(),b={ts:60000,close:99.5};assert.ok(breakoutInvalidated(e,b,120001));
  assert.equal(breakoutInvalidated(e,b,118000),false);assert.equal(breakoutInvalidated(e,b,140000),false);
  assert.equal(breakoutInvalidated(e,{...b,ts:0},60001),false);
  assert.equal(observeBreakout({},e,{ts:0,bid:105},1000),null);
  assert.equal(observeBreakout({},e,{ts:1001000,bid:100.1},1001000),'breakout_no_progress');
});
test('quote-triggered giveback exit survives rebound and engine reconstruction while native orders are canceled before selling',async()=>{
  const f=await fixture({BREAKOUT_PROTECTION:'on'});
  try {
    f.engine.scheduleReconcile=()=>{};const c=f.prepare();c.features.rangeHigh=99;c.features.atr=1;await f.engine.enter(c);
    f.advance(100);await f.engine.onQuote(quote('SPY',f.now(),100));await f.engine.reconcile();
    const e=f.store.orders().find(x=>x.kind==='entry');assert.ok(e.filledQty>0);assert.ok(e.exitPolicy);
    const parent=f.broker.state.orders[e.id];parent.legs=[{id:'native-stop',brokerId:'native-stop',type:'stop',status:'new',filledQty:0}];
    let canceled=false;f.broker.cancel=async()=>{canceled=true;};
    f.advance(100);await f.engine.onQuote(quote('SPY',f.now(),102.5));await f.engine.mutex.tail;
    const floor=f.engine.managed.SPY.excursion.floor;assert.ok(floor>100);
    // A stale dip must not trigger. A fresh one is durable before REST reconciliation.
    f.engine.onQuote(quote('SPY',f.now()-10000,floor-.1));assert.equal(f.engine.managed.SPY.exitReason,null);
    f.advance(10);f.engine.onQuote(quote('SPY',f.now(),floor-.1));f.advance(1);f.engine.onQuote(quote('SPY',f.now(),103));
    assert.equal(f.store.get('managed').SPY.exitReason,'profit_protection');
    const restarted=new Engine(f.cfg,f.store,f.broker,inlineWorkers,f.now);assert.equal(restarted.managed.SPY.exitReason,'profit_protection');
    await f.engine.reconcile();assert.ok(canceled);assert.equal(f.store.orders().filter(o=>o.kind==='exit').length,0);
    parent.legs[0].status='canceled';
    await f.engine.reconcile();assert.equal(f.store.orders().find(o=>o.kind==='exit')?.reason,'profit_protection');
  } finally{await close(f);}
});

const asset={tradable:true,assetClass:'us_equity',status:'active',exchange:'NASDAQ'};
const snapshot=now=>({latestQuote:{t:new Date(now).toISOString(),bp:99.99,ap:100.01,bs:100,as:100},
  minuteBar:{t:new Date(Math.floor(now/60000)*60000-60000).toISOString(),o:99.5,h:100.1,l:99.4,c:100,v:10000},
  dailyBar:{t:new Date(now-3600000).toISOString(),c:100,h:102,l:98,v:100000},
  prevDailyBar:{t:new Date(now-86400000).toISOString(),c:99,v:1000000}});
test('discovery considers listed tradable equities outside seeds and rejects OTC, malformed, nontradable and stale data',()=>{
  assert.deepEqual(eligibleEquities(new Map([['NEW',asset],['OLD',{...asset,tradable:false}],['OTC',{...asset,exchange:'OTC'}],['BAD/',asset]])),['NEW']);
  const now=Date.parse('2026-09-22T15:00:00Z'),cfg=testConfig(),s=snapshot(now);
  assert.ok(screenSnapshot('NEW',s,cfg,now).eligible);
  assert.equal(screenSnapshot('NEW',s,cfg,now+10000).reason,'stale_or_invalid_quote');
  assert.equal(screenSnapshot('NEW',{...s,latestQuote:{...s.latestQuote,ap:101}},cfg,now).reason,'spread');
});
test('stage-two shortlist allocates per-strategy candidates and rotates exploration without ticker seeds',()=>{
  const rows=Array.from({length:20},(_,i)=>({symbol:'S'+String(i).padStart(2,'0'),scores:{range_breakout:20-i,failed_breakout:i}}));
  const a=contextShortlist(rows,['range_breakout','failed_breakout'],6,8),b=contextShortlist(rows,['range_breakout','failed_breakout'],6,12);
  assert.ok(a.some(x=>x.symbol==='S00'));assert.ok(a.some(x=>x.symbol==='S19'));assert.equal(new Set(a.map(x=>x.symbol)).size,6);assert.notDeepEqual(a,b);
});
test('full scan paginates all asset batches, rotates out seeds, pins exposure, and keeps the order mutex free during subscription changes',async()=>{
  const f=await fixture({UNIVERSE_STREAM_LIMIT:'3',UNIVERSE_CONTEXT_LIMIT:'4'});
  try {
    const symbols=Array.from({length:405},(_,i)=>'Z'+String(i).padStart(3,'0'));
    f.engine.assets=new Map([...symbols.map(s=>[s,asset]),['QQQ',asset],['SPY',asset]]);
    const calls=[];const u=f.engine.universe=new EquityUniverse(f.engine,async url=>{const batch=new URL(url).searchParams.get('symbols').split(',');calls.push(batch);return{ok:true,json:async()=>Object.fromEntries(batch.map(s=>[s,snapshot(f.now())]))};},async()=>{});
    f.engine.stockHistory={bars:async ss=>{f.engine.managed.SPY={entryId:'owned'};return new Map(ss.map(s=>[s,[]]));}};
    u.feed={setSymbols:async selected=>{assert.ok(selected.includes('SPY'));assert.equal(u.entryReady(f.now()),false);let entered=false;await f.engine.mutex.run(()=>{entered=true;});assert.ok(entered);}};
    await u.poll(true);assert.equal(u.status().state,'ready');assert.equal(calls.flat().length,407);assert.equal(calls.length,3);
    assert.ok(f.cfg.equities.includes('SPY'));assert.ok(f.cfg.equities.some(s=>s.startsWith('Z')));assert.ok(u.entryReady(f.now()));
    assert.equal(u.entryReady(f.now()+900001),false);assert.ok(f.store.get('equityUniverse').scanId);
  }finally{await close(f);}
});
test('partial scan failure never replaces the current watchlist or claims complete coverage',async()=>{
  const f=await fixture();
  try {
    f.engine.assets=new Map(Array.from({length:201},(_,i)=>['Z'+i,asset]));let calls=0;
    const u=new EquityUniverse(f.engine,async()=>{calls++;return calls===1?{ok:true,json:async()=>({})}:{ok:false,status:403};},async()=>{});
    const before=[...f.cfg.equities];await u.poll(true);assert.equal(u.status().state,'degraded');assert.equal(u.status().lastCompleteAt,null);
    assert.deepEqual(f.cfg.equities,before);assert.equal(u.entryReady(f.now()),false);assert.equal(u.status().scanned,200);
  }finally{await close(f);}
});
test('universe membership does not fragment an experiment; policy changes do',async()=>{
  const f=await fixture();try{f.cfg.universe.mode='all';const a=strategyManifest(f.engine,'range_breakout');f.cfg.symbols=['NEW'];assert.equal(strategyManifest(f.engine,'range_breakout').experimentId,a.experimentId);
    f.cfg.universe.minPrice=3;assert.notEqual(strategyManifest(f.engine,'range_breakout').experimentId,a.experimentId);
  }finally{await close(f);}
});
test('subscription failure leaves entries blocked and restores owned price intake on restart even outside seed tickers',async()=>{
  const f=await fixture({UNIVERSE_STREAM_LIMIT:'3',UNIVERSE_CONTEXT_LIMIT:'2'});
  try{
    f.engine.assets=new Map([['NEW',asset],['QQQ',asset]]);
    f.engine.stockHistory={bars:async ss=>new Map(ss.map(s=>[s,[]]))};
    const u=new EquityUniverse(f.engine,async()=>({ok:true,json:async()=>({NEW:snapshot(f.now()),QQQ:snapshot(f.now())})}),async()=>{});
    u.feed={setSymbols:async()=>{throw Error('universe_subscription_timeout');}};await u.poll(true);
    assert.equal(u.entryReady(f.now()),false);assert.equal(u.status().subscriptionReady,false);
    f.engine.managed.NEW={entryId:'owned'};f.store.set('equityUniverse',{symbols:['NEW','QQQ']});u.restore();
    assert.ok(f.cfg.symbols.includes('NEW'));assert.ok(f.engine.realtime.trades.symbols.has('NEW'));
    f.engine.assets.set('NEW',{...asset,tradable:false});u.validateRestoredAssets();assert.ok(f.cfg.symbols.includes('NEW'));
  }finally{await close(f);}
});
test('stream rotation unsubscribes before adding, retains owned subscriptions and acknowledges all three channels',async()=>{
  const messages=[],connected=[],engine={clock:()=>1000,cfg:{symbols:['KEEP','NEW']},realtime:{trades:{setSymbols:()=>{},connected:s=>connected.push(s)}}};
  const feed=new AlpacaFeed('equities','',[],{},engine);feed.socket={send:x=>messages.push(JSON.parse(x)),close:()=>{}};feed.authenticated=true;
  feed.subscriptions={bars:['KEEP','OLD'],quotes:['KEEP','OLD'],trades:['KEEP','OLD']};feed.confirmedSymbols=['KEEP','OLD'];
  const changing=feed.setSymbols(['KEEP','NEW']);assert.equal(messages[0].action,'unsubscribe');assert.deepEqual(messages[0].quotes,['OLD']);
  feed.subscriptions={bars:['KEEP'],quotes:['KEEP'],trades:['KEEP']};feed.syncSubscriptions();assert.equal(messages[1].action,'subscribe');assert.deepEqual(messages[1].quotes,['NEW']);
  feed.subscriptions={bars:['KEEP','NEW'],quotes:['KEEP','NEW'],trades:['KEEP','NEW']};feed.syncSubscriptions();await changing;assert.deepEqual(connected,[['NEW']]);feed.stop();
});
