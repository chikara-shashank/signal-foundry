import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { testConfig } from './helpers.js';
import { ReplayBroker, replayEngine } from '../src/engine-replay.js';
import { nyTimestamp } from '../src/util.js';

const day='2026-11-27',open=nyTimestamp(day,'09:30'),close=nyTimestamp(day,'13:00');
const calendar={coverageFrom:day,coverageTo:day,observedAt:open-86400000,sessions:[{date:day,open,close}]};
test('replay uses actual early close and rejects future bars or unknown calendar coverage',async()=>{
  const tape={schema:1,source:'synthetic',quoteSizeUnits:'shares',events:[{kind:'quote',symbol:'SPY',now:close+1,ts:close+1,bid:99.99,ask:100.01,bidSize:100,askSize:100}]};
  const report=await replayEngine(tape,calendar,{STRATEGIES:'range_breakout'});
  assert.equal(report.replay.calendarAware,true);assert.equal(report.replay.liveEligible,false);assert.equal(report.finalState.entryReady,false);assert.equal(report.orderCount,0);
  const store=new Store(),broker=new ReplayBroker(testConfig(),store,calendar,()=>close);
  try{assert.equal((await broker.clock(close-1)).open,true);assert.equal((await broker.clock(close)).open,false);}finally{store.close();}
  const bad=structuredClone(tape);bad.events[0]={kind:'bar',symbol:'SPY',now:open,ts:open,open:100,high:101,low:99,close:100,volume:1};
  await assert.rejects(replayEngine(bad,calendar,{STRATEGIES:'range_breakout'}),/Unfinished bar/);
  await assert.rejects(replayEngine(tape,{...calendar,coverageTo:'2026-11-26'},{STRATEGIES:'range_breakout'}),/uncovered/);
});
test('replay fills only later executable quotes, clips to displayed size and keeps partial exposure',async()=>{
  let now=open;const store=new Store(),cfg=testConfig({EQUITY_FEE_BPS:'0',SLIPPAGE_BPS:'0'}),broker=new ReplayBroker(cfg,store,calendar,()=>now);
  try{
    await broker.submit({id:'entry',kind:'entry',symbol:'SPY',ts:open,qty:10,limit:101});
    const quote={symbol:'SPY',ts:open+500,bid:99.99,ask:100,askSize:20,bidSize:20};now=quote.ts;broker.onQuote(quote);assert.equal((await broker.find('entry')).filledQty,0);
    now=open+1000;broker.onQuote({...quote,ts:now});assert.equal((await broker.find('entry')).filledQty,2);assert.equal((await broker.find('entry')).status,'partially_filled');
    now=open+2000;broker.onQuote({...quote,ts:now,askSize:undefined});assert.equal((await broker.find('entry')).filledQty,2);
    assert.equal((await broker.positions())[0].qty,2);await broker.cancel({id:'entry'});assert.equal((await broker.positions())[0].qty,2);
  }finally{store.close();}
});
