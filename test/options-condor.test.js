import test from 'node:test';
import assert from 'node:assert/strict';
import { scanOptions, spreadEconomics, OPTIONS_POLICY as P } from '../src/options-strategies.js';
import { optionLegs, optionGeometry } from '../src/options-structure.js';
import { freshOptionsState, advanceOptions, optionsRecord, replayOptions, replayOptionsStress } from '../src/options-lab.js';
import { nyTimestamp } from '../src/util.js';

function frame() {
  const now=nyTimestamp('2026-09-28','11:00'), f={schema:1,source:'alpaca_opra',stockFeed:'sip',clockUncertaintyMs:50,now,marketOpen:true,universe:['SPY'],
    session:{date:'2026-09-28',open:nyTimestamp('2026-09-28','09:30'),close:nyTimestamp('2026-09-28','16:00')},
    contexts:{SPY:{through:Date.parse('2026-09-25T04:00Z'),rv20:.15}},spots:{SPY:{price:100,ts:now}},contracts:{},quotes:{}};
  for(const[type,strike,bid,delta]of[['put',94,.7,-.15],['put',95,1,-.20],['call',105,1,.20],['call',106,.7,.15]]) {
    const symbol=`SPY261026${type==='put'?'P':'C'}${String(strike*1000).padStart(8,'0')}`;
    f.contracts[symbol]={symbol,type,strike,underlying:'SPY',root:'SPY',expiry:'2026-10-26',style:'american',status:'active',tradable:true,multiplier:100,size:100,openInterest:1000,oiDate:'2026-09-25',deliverables:[{type:'equity',symbol:'SPY',amount:'100',allocation_percentage:'100',delayed_settlement:false}]};
    f.quotes[symbol]={bid,ask:bid+.02,bidSize:100,askSize:100,condition:' ',ts:now,iv:.25,delta};
  }return f;
}
function later(f,seconds=30){const x=structuredClone(f);x.now+=seconds*1000;for(const q of Object.values(x.quotes))q.ts=x.now;x.spots.SPY.ts=x.now;return x;}
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
test('condor reserves wider wing loss less net credit and charges all eight contract sides',()=>{
  const f=frame(),c=scanOptions(f,['iron_condor']).candidates[0];assert.ok(c);assert.equal(optionLegs(c).length,4);
  near(c.entryCost,-.52);near(c.maxLoss,48.8);near(c.maxProfit,51.2);near(c.roundTripFees,.8);near(c.immediateRoundTripLoss,16.8);
  const asymmetric=structuredClone(c);asymmetric.legs[0].contract.strike=93;near(spreadEconomics(asymmetric,f.quotes,f.now).maxLoss,148.8);
  assert.equal(scanOptions(f,['iron_condor'],{...P,maxRisk:40}).candidates.length,0);
  assert.equal(freshOptionsState().enabled.iron_condor,false);
});
test('condor rejects stale wing, mixed expiry, overlapping strikes, missing hedge and insufficient premium',()=>{
  const f=frame(),c=scanOptions(f,['iron_condor']).candidates[0];
  const broken=structuredClone(c);broken.legs.pop();assert.equal(optionGeometry(broken),null);
  broken.legs=structuredClone(c.legs);broken.legs[0].contract.expiry='2026-11-01';assert.equal(optionGeometry(broken),null);
  broken.legs=structuredClone(c.legs);broken.legs[2].contract.strike=94;assert.equal(optionGeometry(broken),null);
  f.quotes[c.legs[0].contract.symbol].ts-=6000;assert.equal(scanOptions(f,['iron_condor']).candidates.length,0);
  const cheap=frame();for(const l of optionLegs(c).filter(l=>l.side==='short'))cheap.quotes[l.contract.symbol].iv=.1;
  assert.equal(scanOptions(cheap,['iron_condor']).candidates.length,0);
});
test('four-leg fills wait for every later quote; disable keeps exits; replay and cost stress account for all legs',()=>{
  const f=frame(),s=freshOptionsState();s.enabled.iron_condor=true;
  const records=[optionsRecord(s,f,true,true)];advanceOptions(s,f);assert.equal(s.pending.length,1);
  let next=later(f,2);const stale=optionLegs(s.pending[0])[3].contract.symbol;next.quotes[stale].ts=f.now;
  records.push(optionsRecord(s,next));advanceOptions(s,next);assert.equal(s.positions.length,0);
  next=later(f);records.push(optionsRecord(s,next));advanceOptions(s,next);assert.equal(s.positions.length,1);
  s.enabled.iron_condor=false;next=later(next);
  for(const l of optionLegs(s.positions[0]).filter(l=>l.side==='short')){next.quotes[l.contract.symbol].bid=.77;next.quotes[l.contract.symbol].ask=.79;}
  records.push(optionsRecord(s,next));advanceOptions(s,next);assert.equal(s.positions[0].exitReason,'profit_target');
  next=later(next);records.push(optionsRecord(s,next));advanceOptions(s,next);assert.equal(s.positions.length,0);assert.equal(s.trades.length,1);
  near(s.trades[0].fees,.8);near(s.trades[0].netPnl,29.2);near(s.trades[0].stressNetPnl,8.8);
  near(replayOptions(records).netPnl,29.2);assert.equal(replayOptionsStress(records).liveEligible,false);
});
test('missing one held leg makes the whole mark unavailable and blocks new entries',()=>{
  const f=frame(),s=freshOptionsState();s.enabled.iron_condor=true;advanceOptions(s,f);advanceOptions(s,later(f));
  const n=later(f,60);delete n.quotes[optionLegs(s.positions[0])[0].contract.symbol];advanceOptions(s,n);
  assert.equal(s.positions[0].markNet,null);assert.equal(s.lastScan.entryGate,'unavailable_position_mark');
});
