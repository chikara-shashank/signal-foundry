import test from 'node:test';
import assert from 'node:assert/strict';
import {Pullback} from '../src/momentum-pullback.js';
import {MomentumPortfolio} from '../src/momentum-portfolio.js';
import {MomentumResearch} from '../src/momentum-research.js';
import {scan} from '../src/momentum-scanner.js';
import {robinhoodEquityFee} from '../src/momentum-fees.js';
import {momentumFixture} from './fixtures/momentum.js';
const open=Date.parse('2026-09-24T13:30:00Z'),date='2026-09-24';
const zeroFee=()=>({total:0});
const session={date,nextDate:'2026-09-25'};
const order=symbol=>({symbol,limit:5,stop:4.8,tickSize:.01});
const quote=(symbol,ts,bid=4.98,ask=4.99,size=10000)=>({symbol,ts,bid,ask,bidSize:size,askSize:size,eligible:true});
function portfolio(opts={}){const p=new MomentumPortfolio({fee:zeroFee,...opts});p.session(session,open);return p;}
test('Point-in-time metadata and reverse split basis fail closed',()=>{
  const facts=momentumFixture().find(e=>e.kind==='metadata').facts;
  const now=open,s={...facts,symbol:'TEST',sessionDate:date,observedAt:now,halted:false,feedHealthy:true,lastTrade:{value:5,availableAt:now,effectiveAt:now},cumulativeVolume:{value:1000000,availableAt:now,effectiveAt:now}};
  s.tradable={...s.tradable,availableAt:now,effectiveAt:now};
  assert.equal(scan([s],now).selected.length,1);
  s.float={...s.float,availableAt:now+1};assert.equal(scan([s],now).selected.length,0);
  s.float={...s.float,availableAt:now};s.splitBasisVerified=false;assert.equal(scan([s],now).selected.length,0);
});
test('Fees use waivers, rounding and dated schedules',()=>{
  assert.equal(robinhoodEquityFee({side:'sell',qty:1000,price:2,date}).total,.25);
  assert.equal(robinhoodEquityFee({side:'sell',qty:50,price:10,date}).total,0);
  assert.equal(robinhoodEquityFee({side:'sell',qty:51,price:10,date}).taf,0);
  assert.equal(robinhoodEquityFee({side:'sell',qty:52,price:2,date}).taf,.01);
  assert.equal(robinhoodEquityFee({side:'buy',qty:1,price:2,date:'2026-09-25'}).total,0);
  assert.equal(robinhoodEquityFee({side:'buy',qty:1,price:2,date:'2026-09-28'}).costAssumption,true);
});
test('Full scanner-to-pullback-to-portfolio fixture executes causally',()=>{
  const r=new MomentumResearch();for(const e of momentumFixture())r.on(e);
  const x=r.report();assert.equal(x.signals.length,1);assert.equal(x.signals[0].accepted,true);
  assert.equal(x.portfolio.closedTrades.length,1);assert.ok(x.portfolio.closedTrades[0].entryAt>x.signals[0].now);
  assert.equal(x.portfolio.openPositions.length,0);assert.equal(x.validationEligible,false);assert.equal(x.source,'synthetic');
});
test('Missing float never becomes a trade',()=>{
  const r=new MomentumResearch();for(const e of momentumFixture()){if(e.kind==='metadata')delete e.facts.float;r.on(e);}
  assert.equal(r.signals.length,0);assert.ok(r.report().rejectionCounts.float_missing_stale_or_ineligible>0);
});
test('Incomplete market coverage cannot qualify',()=>{
  const events=momentumFixture();events[0].coverageComplete=false;const r=new MomentumResearch();events.forEach(e=>r.on(e));
  assert.equal(r.signals.length,0);assert.equal(r.report().coverageComplete,false);
});
test('A feed gap blocks subsequent entries',()=>{
  const events=momentumFixture();events.push({kind:'gap',now:open+6*60000,reason:'disconnect'});events.sort((a,b)=>a.now-b.now);
  const r=new MomentumResearch();events.forEach(e=>r.on(e));assert.equal(r.signals.length,0);
});
test('Future bars, revised bars and deep pullbacks are rejected',()=>{
  const p=new Pullback(open,open+390*60000,.01),b={ts:open,open:4,high:4.1,low:3.9,close:4.05,volume:100};
  assert.throws(()=>p.bar(b,open,4));p.bar(b,open+60000,4);assert.throws(()=>p.bar(b,open+120000,4));
  for(let i=1;i<5;i++)p.bar({...b,ts:open+i*60000},open+(i+1)*60000,4);
  p.bar({...b,ts:open+5*60000,high:5,low:4,close:4.9,volume:1000},open+6*60000,4);
  p.bar({...b,ts:open+6*60000,high:4.9,low:4.4,open:4.8,close:4.7},open+7*60000,4);
  assert.equal(p.trigger({price:5,ts:open+7*60000},open+7*60000),null);
});
test('Pending orders reserve shared capital and expire without a fill',()=>{
  const p=portfolio({maxGross:500,risk:100});p.halt('AAA',false,open);p.halt('BBB',false,open);
  assert.equal(p.reserve(order('AAA'),open),true);assert.equal(p.reserve(order('BBB'),open),false);
  assert.ok(p.exposure()<=500);p.tick(open+2001);assert.equal(p.pending.size,0);assert.equal(p.positions.size,0);
});
test('Delayed entries respect price caps and reject stale/out-of-order quotes',()=>{
  const p=portfolio();p.halt('AAA',false,open);p.reserve(order('AAA'),open);
  p.quote(quote('AAA',open+500),open+500);assert.equal(p.positions.size,0);
  p.quote(quote('AAA',open,4.8,4.9),open+1000);assert.equal(p.positions.size,0);
  p.quote(quote('AAA',open+1000,5,5.01),open+1000);assert.equal(p.positions.size,0);
  p.quote(quote('AAA',open+1100),open+1100);assert.equal(p.positions.size,1);
  p.quote(quote('AAA',open+1050,4,4.01),open+1150);assert.equal(p.quotes.get('AAA').bid,4.98);
});
test('Gapped stop uses delayed executable bid and retains partial exposure',()=>{
  const p=portfolio();p.halt('AAA',false,open);p.reserve(order('AAA'),open);p.quote(quote('AAA',open+1000),open+1000);
  const total=p.positions.get('AAA').qty;p.quote(quote('AAA',open+1500,4.7,4.71),open+1500);
  p.quote(quote('AAA',open+2500,4.5,4.51,100),open+2500);
  assert.equal(p.positions.get('AAA').qty,total-10);assert.equal(p.journal.at(-1).price,4.5);
  p.quote(quote('AAA',open+2600,4.5,4.51,100),open+2600);assert.equal(p.positions.get('AAA').qty,total-10);
  assert.equal(p.report().completeLiquidation,false);
});
test('Halts suppress fills while time exits survive the reopening',()=>{
  const p=portfolio({maxHoldMs:2000});p.halt('AAA',false,open);p.reserve(order('AAA'),open);p.quote(quote('AAA',open+1000),open+1000);
  p.halt('AAA',true,open+1500);p.quote(quote('AAA',open+5000,4,4.01),open+5000);assert.equal(p.closed.length,0);
  p.halt('AAA',false,open+6000);p.quote(quote('AAA',open+6100,3.9,3.91),open+6100);assert.equal(p.closed.length,1);assert.equal(p.closed[0].reason,'time');
});
test('Cash proceeds wait until the explicit next exchange session',()=>{
  const p=portfolio({capital:500,maxGross:500,risk:100,maxHoldMs:1000});p.halt('AAA',false,open);p.reserve(order('AAA'),open);p.quote(quote('AAA',open+1000),open+1000);p.quote(quote('AAA',open+3100),open+3100);
  p.halt('BBB',false,open+3200);assert.equal(p.reserve(order('BBB'),open+3200),true);assert.equal(p.pending.get('BBB').qty,1);
  assert.ok(p.settling.length>0);p.session({date:'2026-09-25',nextDate:'2026-09-28'},open+86400000);assert.equal(p.settling.length,0);assert.ok(p.cash>490);
});
test('Daily bid-marked loss latch and external reservations limit new entries',()=>{
  const p=portfolio({dailyLoss:1});p.halt('AAA',false,open);p.halt('BBB',false,open);p.reserve(order('AAA'),open);p.quote(quote('AAA',open+1000),open+1000);p.quote(quote('AAA',open+1200,4.9,4.91),open+1200);
  assert.equal(p.lossHalt,true);assert.equal(p.reserve(order('BBB'),open+1300),false);
  const external=portfolio({reservedExternal:2999});external.halt('AAA',false,open);assert.equal(external.reserve(order('AAA'),open),false);
});
test('Original receipt order and explicit session are mandatory',()=>{
  const r=new MomentumResearch();assert.throws(()=>r.on({kind:'tick',now:open}));
  const r2=new MomentumResearch();r2.on(momentumFixture()[0]);assert.throws(()=>r2.on({kind:'tick',now:0}));
});
test('Latest invalid quote invalidates an older quote for entry',()=>{
  const events=momentumFixture(),signal=open+7*60000;
  events.push({kind:'quote',symbol:'TEST',now:signal-5,ts:signal-5,bid:4.45,ask:4.44,bidSize:10000,askSize:10000,eligible:true});events.sort((a,b)=>a.now-b.now);
  const r=new MomentumResearch();events.forEach(e=>r.on(e));assert.equal(r.signals[0].accepted,false);assert.equal(r.portfolio.closed.length,0);
});
test('Non-executable sessions may mark positions but cannot fill orders',()=>{
  const p=portfolio();p.halt('AAA',false,open);p.reserve(order('AAA'),open);p.quote(quote('AAA',open+1000),open+1000,false);assert.equal(p.positions.size,0);
});
test('Capacity is rechecked at arrival after another position appreciates',()=>{
  const p=portfolio({maxGross:600,risk:100});p.halt('AAA',false,open);p.halt('BBB',false,open);
  p.reserve(order('AAA'),open);p.quote(quote('AAA',open+1000),open+1000);p.reserve(order('BBB'),open+1100);
  p.quote(quote('AAA',open+1500,6,6.01),open+1500);p.quote(quote('BBB',open+2100),open+2100);
  assert.equal(p.positions.has('BBB'),false);
});
test('A new session does not inherit yesterday\'s tradable halt status',()=>{
  const p=portfolio();p.halt('AAA',false,open);p.session({date:'2026-09-25',nextDate:'2026-09-28'},open+86400000);
  assert.equal(p.reserve(order('AAA'),open+86400000),false);
});
