import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,quote,inlineWorkers} from './helpers.js';
import {Engine} from '../src/engine.js';
import {additionCandidate,checkAddition} from '../src/pyramiding.js';
import {campaignQty,campaignMark} from '../src/position-book.js';
import {tradeScorecard} from '../src/research.js';
import {strategyManifest} from '../src/strategy-manifest.js';
import {comparePyramiding} from '../src/pyramiding-replay.js';
import {pyramidingTape} from './fixtures/pyramiding.js';

const toggle=(e,value,strategy='range_breakout')=>e.strategyControls.update({strategy,addToWinners:value,expectedRevision:e.strategyControls.state.revision});
const close=async f=>{f.engine.stopped=true;clearTimeout(f.engine.streamReconcile);await f.engine.mutex.tail;f.store.close();};
async function held(enabled=true,settings={}) {
  const f=await fixture({MAX_POSITION_USD:'2000',MAX_GROUP_USD:'5000',MAX_GROSS_USD:'6000',RISK_PER_TRADE_USD:'20',SYMBOL_COOLDOWN_SECONDS:'0',...settings});
  f.engine.scheduleReconcile=()=>{};
  if(enabled)await toggle(f.engine,true);
  const c=f.prepare();c.target=110;c.features.rangeHigh=99;c.features.atr=1;
  c.strategyGeneration=f.engine.strategyControls.generation(c.strategy);
  await f.engine.mutex.run(()=>f.engine.enter(c));
  f.advance(100);await f.engine.onQuote(quote('SPY',f.now()));await f.engine.mutex.tail;await f.engine.reconcile();
  f.root=f.store.orders().find(o=>o.kind==='entry');return f;
}
async function freshSetup(f) {
  f.advance(300000);await f.engine.onQuote(quote('SPY',f.now(),103));await f.engine.mutex.tail;await f.engine.reconcile();
  const ts=Math.floor(f.now()/60000)*60000-60000;
  const bars=[3,2,1].map(i=>({symbol:'SPY',ts:ts-i*60000,open:102.5,high:102.7,low:102.45,close:102.6,volume:100}));
  const bar={symbol:'SPY',ts,open:102.7,high:103.05,low:102.65,close:103,volume:250};
  const features={symbol:'SPY',version:ts,bar,atr:1,ema9:102.5,ema21:102,trend5:.01,trend15:.01,relativeVolume:2,regime:'trend'};
  f.engine.features.history.set('SPY',[...bars,bar]);f.engine.snapshots.set('SPY',features);
  return additionCandidate(f.engine,features);
}
async function add(f,c) {
  assert.ok(c);assert.equal(f.engine.checkEntry(c).ok,true,JSON.stringify(f.engine.checkEntry(c)));
  await f.engine.submitCandidate(c);const order=f.store.orders().find(o=>o.addition);assert.ok(order);
  f.advance(1000);await f.engine.onQuote(quote('SPY',f.now(),103));await f.engine.mutex.tail;await f.engine.reconcile();return f.store.getOrder(order.id);
}

test('additions default off, persist, change manifests, reject unsupported/live settings and preserve legacy positions',async()=>{
  const f=await held(false);
  try {
    assert.equal(f.engine.strategyControls.additionsEnabled('range_breakout'),false);
    const before=strategyManifest(f.engine,'range_breakout');await toggle(f.engine,true);
    assert.notEqual(strategyManifest(f.engine,'range_breakout').experimentId,before.experimentId);
    const restart=new Engine(f.cfg,f.store,f.broker,inlineWorkers,f.now);
    assert.equal(restart.strategyControls.additionsEnabled('range_breakout'),true);
    assert.equal(await freshSetup(f),null);assert.equal(f.store.getOrder(f.root.id).addPolicy,null);
    await assert.rejects(toggle(f.engine,true,'trend_pullback'),{status:409});
    f.cfg.mode='live';await assert.rejects(toggle(f.engine,true),{status:409});f.cfg.mode='demo';
    await assert.rejects(f.engine.strategyControls.update({strategy:'range_breakout',addToWinners:'true',expectedRevision:0}),{status:400});
  }finally{await close(f);}
});

test('fresh confirmation adds at most 25%, keeps cost basis and original timer, and counts one closed position',async()=>{
  const f=await held();
  try {
    const opened=f.engine.managed.SPY.openedAt,c=await freshSetup(f),a=await add(f,c);
    assert.ok(a.filledQty>0 && a.filledQty<=Math.floor(f.root.filledQty*.25));
    assert.equal(f.engine.ready,true,JSON.stringify(f.engine.issues));assert.equal(f.engine.managed.SPY.entryId,f.root.id);
    assert.equal(f.engine.managed.SPY.openedAt,opened);assert.equal(f.engine.portfolio.state.valid,true);
    assert.equal(f.engine.positions[0].qty,f.root.filledQty+a.filledQty);
    const cost=campaignMark(f.store.orders(),f.root.id,103);assert.ok(Math.abs(cost.averagePrice-f.engine.positions[0].entryPrice)<1e-8);
    assert.equal(checkAddition(f.engine,{...c,id:'repeat'}).reason,'addition_limit');
    f.advance(1000);await f.engine.onQuote(quote('SPY',f.now(),102));await f.engine.mutex.tail;await f.engine.reconcile();
    assert.equal(f.engine.managed.SPY.exitReason,'addition_profit_protection');
    for(let i=0;i<4;i++){f.advance(1000);await f.engine.onQuote(quote('SPY',f.now(),102));await f.engine.mutex.tail;await f.engine.reconcile();}
    assert.equal(f.engine.positions.length,0);assert.equal(f.engine.managed.SPY,undefined);
    assert.equal(campaignQty(f.store.orders(),f.root.id),0);
    const score=tradeScorecard(f.store.orders(),f.cfg);assert.equal(score.exceptions.length,0);assert.equal(score.trades.length,1);
    assert.equal(score.trades[0].fullyClosed,true);assert.equal(score.trades[0].addedQty,a.filledQty);
    assert.ok(score.trades[0].additionNetPnl<0);assert.ok(score.trades[0].estimatedNetPnl>0);
    assert.equal(f.engine.strategyControls.snapshot().strategies.find(s=>s.id==='range_breakout').closed,1);
  }finally{await close(f);}
});

test('duplicate/pre-fill bars, insufficient profit, exhausted position and daily budgets cannot add',async()=>{
  const f=await held();
  try {
    const c=await freshSetup(f);assert.equal(checkAddition(f.engine,c).ok,true);
    const history=f.engine.features.history.get('SPY');history[0].ts-=60000;
    assert.equal(checkAddition(f.engine,c).reason,'addition_needs_new_consolidation');history[0].ts+=60000;
    const q=f.engine.quotes.get('SPY');f.engine.quotes.set('SPY',{...q,bid:101.9});
    assert.equal(checkAddition(f.engine,c).reason,'addition_profit_not_protected');f.engine.quotes.set('SPY',q);
    f.cfg.maxPosition=100;assert.equal(f.engine.checkEntry(c).reason,'insufficient_capacity_or_lot_size');f.cfg.maxPosition=2000;
    f.engine.dailyLossLimit=.01;assert.equal(checkAddition(f.engine,c).reason,'addition_daily_risk_budget');
    assert.equal(f.store.orders().length,1);
  }finally{await close(f);}
});

test('turning additions off cancels an unfilled add without canceling the initial holding',async()=>{
  const f=await held();
  try {
    const c=await freshSetup(f);await f.engine.submitCandidate(c);await toggle(f.engine,false);await f.engine.reconcile();
    const a=f.store.orders().find(o=>o.addition);assert.equal(a.status,'canceled');
    assert.equal(f.engine.positions[0].qty,f.root.filledQty);assert.equal(f.engine.managed.SPY.exitReason,null);
    assert.equal(f.engine.strategyControls.enabled('range_breakout'),true);
  }finally{await close(f);}
});

test('partial added fills survive restart; canceled remainder exits every owned share with correct attribution',async()=>{
  const f=await held();
  try {
    const c=await freshSetup(f);await f.engine.submitCandidate(c);
    const a=f.store.orders().find(o=>o.addition),remote=f.broker.state.orders[a.id];assert.ok(a.qty>=2);
    const parent=f.broker.state.positions.SPY;
    Object.assign(remote,{filledQty:1,fillPrice:103,status:'partially_filled',fee:.0103,filledAt:f.now()});
    parent.entryPrice=(parent.qty*parent.entryPrice+103)/(parent.qty+1);parent.qty++;f.broker.state.cash-=103.0103;
    await f.engine.reconcile();assert.equal(f.engine.portfolio.state.valid,true);
    const opened=f.engine.managed.SPY.openedAt,restart=new Engine(f.cfg,f.store,f.broker,inlineWorkers,f.now);restart.scheduleReconcile=()=>{};
    await restart.init();f.engine=restart;assert.equal(restart.managed.SPY.openedAt,opened);
    await toggle(restart,false);await restart.reconcile();assert.equal(restart.managed.SPY.exitReason,'partial_entry_canceled');
    for(let i=0;i<4;i++){f.advance(1000);await restart.onQuote(quote('SPY',f.now(),103));await restart.mutex.tail;await restart.reconcile();}
    assert.equal(restart.positions.length,0);const score=tradeScorecard(f.store.orders(),f.cfg);
    assert.equal(score.trades.length,1);assert.equal(score.trades[0].addedQty,1);assert.equal(score.trades[0].fullyClosed,true);
  }finally{await close(f);}
});

test('a native lot exit cancels every remaining bracket before bounded market exits',async()=>{
  const f=await held();
  try {
    const a=await add(f,await freshSetup(f)),root=f.broker.state.orders[f.root.id],child=f.broker.state.orders[a.id];
    root.legs=[{id:'root-target',brokerId:'root-target',status:'filled',type:'limit',filledQty:root.filledQty,fillPrice:104},
      {id:'root-stop',brokerId:'root-stop',status:'canceled',type:'stop',filledQty:0}];
    child.legs=[{id:'add-stop',brokerId:'add-stop',status:'new',type:'stop',filledQty:0}];
    f.broker.state.positions.SPY.qty=a.filledQty;f.broker.state.cash+=104*root.filledQty;
    const canceled=[];f.broker.cancel=async o=>{canceled.push(o.id);};
    await f.engine.reconcile();assert.equal(f.engine.portfolio.state.valid,true);assert.ok(canceled.includes('add-stop'));
    assert.equal(f.store.orders().filter(o=>o.kind==='exit').length,0);
    child.legs[0].status='canceled';await f.engine.reconcile();
    const exit=f.store.orders().find(o=>o.kind==='exit');assert.equal(exit.entryId,a.id);assert.equal(exit.qty,a.filledQty);
  }finally{await close(f);}
});

test('unknown addition submission is not retried and a subsequent confirmed fill remains owned',async()=>{
  const f=await held();
  try {
    const c=await freshSetup(f),submit=f.broker.submit.bind(f.broker);let calls=0;
    f.broker.submit=async o=>{calls++;await submit(o);throw new Error('lost response');};
    await f.engine.submitCandidate(c);assert.equal(f.store.orders().find(o=>o.addition).status,'unknown');
    f.broker.submit=submit;f.advance(1000);await f.engine.onQuote(quote('SPY',f.now(),103));await f.engine.mutex.tail;await f.engine.reconcile();
    assert.equal(calls,1);assert.equal(f.engine.portfolio.state.valid,true);assert.equal(f.engine.managed.SPY.entryId,f.root.id);
  }finally{await close(f);}
});

test('campaign result filters include later additions without counting them as independent wins',()=>{
  const orders=[{id:'r',kind:'entry',symbol:'SPY',strategy:'range_breakout',ts:10,status:'filled',filledQty:4,fillPrice:100,fee:0},
    {id:'a',campaignId:'r',addition:true,kind:'entry',symbol:'SPY',strategy:'range_breakout',ts:30,status:'filled',filledQty:1,fillPrice:103,fee:0},
    {id:'rx',entryId:'r',kind:'exit',ts:40,status:'filled',filledQty:4,fillPrice:102,fee:0},
    {id:'ax',entryId:'a',kind:'exit',ts:40,status:'filled',filledQty:1,fillPrice:102,fee:0}];
  const score=tradeScorecard(orders,{equityFee:0},{from:1,to:20});
  assert.equal(score.trades.length,1);assert.equal(score.trades[0].estimatedNetPnl,7);assert.equal(score.trades[0].additionNetPnl,-1);
  assert.equal(score.strategies[0].closed,1);assert.equal(tradeScorecard(orders,{equityFee:0},{from:20}).trades.length,0);
});

test('paired replay remains explicitly unqualified even for an empty synthetic sample',async()=>{
  const open=Date.parse('2026-09-22T13:30:00Z'),calendar={coverageFrom:'2026-09-22',coverageTo:'2026-09-22',observedAt:open-1,sessions:[{date:'2026-09-22',open,close:open+23400000}]};
  const tape={schema:1,source:'synthetic',quoteSizeUnits:'shares',events:[{kind:'quote',symbol:'SPY',now:open,ts:open,bid:100,ask:100.01,askSize:100,bidSize:100}]};
  const report=await comparePyramiding(tape,calendar,{STRATEGIES:'range_breakout'});
  assert.equal(report.liveEligible,false);assert.equal(report.evidence,'synthetic_functional_check');assert.equal(report.scaled.additionFills,0);
  assert.equal(report.baseline.replay.inputSha256,report.scaled.replay.inputSha256);
});

test('production scanner paired replay adds once and distinguishes added-share losses from combined wins',async()=>{
  for(const outcome of ['continuation','reversal']) {
    const {tape,calendar,settings}=pyramidingTape(outcome),report=await comparePyramiding(tape,calendar,settings);
    assert.equal(report.baseline.additionFills,0);
    assert.equal(report.scaled.additionFills,1,JSON.stringify(report.scaled));
    assert.equal(report.complete,true);assert.equal(report.scaled.closedPositions,1);
    assert.equal(report.scaled.exceptions,0);assert.equal(report.evidence,'synthetic_functional_check');
    assert.ok(outcome==='continuation'?report.incrementalNet>0:report.incrementalNet<0);
    assert.ok(report.scaled.estimatedNetPnl>0);
  }
});

test('concurrent confirmations submit only one addition even when both preflights pass',async()=>{
  const f=await held();
  try {
    const c=await freshSetup(f);await Promise.all([f.engine.submitCandidate(c),f.engine.submitCandidate({...c,id:'second-confirmation'})]);
    assert.equal(f.store.orders().filter(o=>o.addition).length,1);
    assert.equal(f.store.getCandidate('second-confirmation').status,'rejected');
  }finally{await close(f);}
});

test('unrelated additional shares remain an ownership incident and cannot be sold by flatten',async()=>{
  const f=await held();
  try {
    await add(f,await freshSetup(f));f.broker.state.positions.SPY.qty++;
    await f.engine.reconcile();assert.equal(f.engine.portfolio.state.valid,false);assert.ok(f.engine.externalSymbols.has('SPY'));
    await f.engine.control('flatten');await f.engine.reconcile();
    assert.equal(f.store.orders().filter(o=>o.kind==='exit').length,0);
  }finally{await close(f);}
});

test('combined protection ratchets durably and quote processing uses the cached campaign book',async()=>{
  const f=await held();
  try {
    await add(f,await freshSetup(f));const before=f.engine.managed.SPY.addFloor;
    const orders=f.store.orders.bind(f.store);f.store.orders=()=>{throw new Error('Unexpected full journal read on quote');};
    try {f.advance(1000);await f.engine.onQuote(quote('SPY',f.now(),106));await f.engine.mutex.tail;}
    finally{f.store.orders=orders;}
    const floor=f.engine.managed.SPY.addFloor;assert.ok(floor>before);
    const restored=new Engine(f.cfg,f.store,f.broker,inlineWorkers,f.now);assert.equal(restored.managed.SPY.addFloor,floor);
    assert.equal(f.store.getOrder(f.root.id).campaignExcursion.peakNet,f.engine.managed.SPY.campaignExcursion.peakNet);
  }finally{await close(f);}
});

test('native exit quantity overfill remains an exception with campaign ownership enabled',async()=>{
  const f=await held();
  try {
    const a=await add(f,await freshSetup(f)),remote=f.broker.state.orders[a.id];
    remote.legs=[{id:'over',brokerId:'over',status:'filled',type:'stop',filledQty:a.filledQty+1,fillPrice:102}];
    f.broker.state.positions.SPY.qty-=a.filledQty+1;await f.engine.reconcile();
    assert.equal(f.engine.portfolio.state.valid,false);
    assert.ok(tradeScorecard(f.store.orders(),f.cfg).exceptions.some(x=>x.reason==='native_exit_overfill'));
    assert.equal(f.engine.strategyControls.snapshot().strategies.find(s=>s.id==='range_breakout').realizedNetPnl,null);
  }finally{await close(f);}
});

test('own nested bracket rows permit additions while unrelated open orders still block them',async()=>{
  const f=await held();
  try {
    const c=await freshSetup(f),root=f.store.getOrder(f.root.id);
    root.legs=[{id:'owned-stop',brokerId:'owned-stop',symbol:'SPY',status:'new',side:'sell',type:'stop',filledQty:0}];f.store.order(root);
    f.engine.openOrders=[root];assert.equal(f.engine.checkEntry(c).ok,true);
    f.engine.openOrders.push({id:'foreign',brokerId:'foreign',symbol:'SPY',status:'new',side:'sell'});
    assert.equal(f.engine.checkEntry(c).reason,'broker_orders_present');
  }finally{await close(f);}
});
