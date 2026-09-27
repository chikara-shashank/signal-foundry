import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, quote, testConfig } from './helpers.js';
import { requestFor } from '../src/jev.js';
import { JEV_RUBRIC } from '../src/jev-context.js';
import { RecordedResearch, validateReviewBundle } from '../src/recorded-research.js';
import { candidateReviewKey, researchEvidence, researchInputDigest, sealResearchRecord, RESEARCH_VERSION } from '../src/research-evidence.js';
import { compareResearch } from '../src/research-comparison.js';
import { hash, nyTimestamp } from '../src/util.js';
import { pyramidingTape } from './fixtures/pyramiding.js';

const bundle=(records=[],models=[],invalidations=[],charges=[],coverageTimeline=[{at:0,available:true}])=>{const b={schema:1,records,models,invalidations,charges,coverageTimeline};return {...b,digest:hash(b)};};
const dispose=async f=>{f.engine.stopped=true;clearTimeout(f.engine.streamReconcile);await f.engine.mutex.tail;f.store.close();};
function record(f,{at=f.now()-1000,pass=true,stage='thesis',criticPass=true,parentId=null}={}){
  const a={id:'a',digest:'digest',source:'news',headline:'Contract',summary:'Signed deal',symbols:['SPY'],publishedAt:at-2000,updatedAt:at-1000,observedAt:at};
  const evidence=researchEvidence(f.engine,'SPY',[a],at);
  return sealResearchRecord({version:RESEARCH_VERSION,symbol:'SPY',evidence,stage,model:f.cfg.jevModel,availableAt:at,expiresAt:evidence.expiresAt,costUsd:.01,parentId,
    thesis:{pass,verdict:pass?'supported':'unsupported',support:pass?['a']:[],contrary:[]},critic:stage==='critic'?{pass:criticPass,evidenceIds:[]}:null});
}
const model=(c,delay=2000,pass=true)=>({candidateKey:candidateReviewKey(c),requestedAt:c.ts,availableAt:c.ts+delay,pass,costUsd:.01,model:testConfig().jevModel,rubricVersion:JEV_RUBRIC,
  thresholds:{coherence:.8,quality:.65,excludedRegime:'disorderly'},inputDigest:researchInputDigest(requestFor(c,testConfig().jevModel,testConfig()))});

test('recorded Jev waits for its observed completion; current gates run again before submission',async()=>{
  const f=await fixture({STRATEGIES:'range_breakout'});try{
    const c=f.prepare(),reviews=new RecordedResearch(f.engine,bundle([], [model(c)]),'jev');await reviews.submit(c);
    assert.equal(f.store.orders().length,0);f.advance(1000);await reviews.advance(f.now());assert.equal(f.store.orders().length,0);
    f.engine.operatorPause=true;f.advance(1000);f.engine.onQuote(quote('SPY',f.now()));await reviews.advance(f.now());
    assert.equal(f.store.orders().length,0);assert.equal(f.store.getCandidate(c.id).reason,'entries_paused');
    assert.equal(reviews.report(c.ts,f.now()).modelCostUsd,.01);
  }finally{await dispose(f);}
});

test('recorded passing model can submit at its availability time, and late responses cannot revive an expired signal',async()=>{
  for(const late of [false,true]){
    const f=await fixture({STRATEGIES:'range_breakout'});try{
      const c=f.prepare(),reviews=new RecordedResearch(f.engine,bundle([],[model(c,late?15000:2000)]),'jev');await reviews.submit(c);
      f.advance(late?10000:2000);f.engine.onQuote(quote('SPY',f.now()));await reviews.advance(f.now());
      assert.equal(f.store.orders().length,late?0:1);
      if(late)assert.equal(f.store.getCandidate(c.id).reason,'recorded_review_expired');
      else assert.equal(f.store.orders()[0].ts,c.ts+2000);
    }finally{await dispose(f);}
  }
});

test('unseen future context and missing model decisions reject instead of silently approving',async()=>{
  const f=await fixture({STRATEGIES:'range_breakout'});try{
    const c=f.prepare(),future=record(f,{at:f.now()+1000}),reviews=new RecordedResearch(f.engine,bundle([future]),'context');
    await reviews.submit(c);assert.equal(reviews.counts.missing,1);assert.equal(f.store.orders().length,0);
    const missing=new RecordedResearch(f.engine,bundle(),'jev'),other={...c,id:'other'};f.store.candidate(other);await missing.submit(other);assert.equal(missing.counts.missing,1);
  }finally{await dispose(f);}
});

test('source invalidation prevents falling back to the older thesis after critic completion',async()=>{
  const f=await fixture();try{
    const parent=record(f),child=record(f,{stage:'critic',parentId:parent.id});
    const reviews=new RecordedResearch(f.engine,bundle([parent,child],[],[{recordId:child.id,at:f.now(),reason:'revised'}]),'context');
    assert.equal(reviews.context('SPY',f.now()),null);
    assert.ok(reviews.context('SPY',f.now()-1));
    assert.throws(()=>validateReviewBundle({...bundle([parent]),digest:'broken'}),/integrity/);
    assert.throws(()=>validateReviewBundle(bundle([child])),/parent/);
  }finally{await dispose(f);}
});

test('critic rejects a supported thesis with a material objection; failed research charges are counted once',async()=>{
  const f=await fixture({STRATEGIES:'range_breakout'});try{
    const c=f.prepare(),parent=record(f),child=record(f,{stage:'critic',parentId:parent.id,criticPass:false});
    const charges=[{id:'first',at:c.ts,stage:'thesis',costUsd:.02},{id:'failed',at:c.ts,stage:'critic',costUsd:.03}];
    const reviews=new RecordedResearch(f.engine,bundle([parent,child],[],[],charges),'critic');await reviews.submit(c);
    assert.equal(f.store.orders().length,0);assert.equal(reviews.counts.declined,1);assert.equal(reviews.report(c.ts,c.ts).totalCostUsd,.05);
    assert.equal(new RecordedResearch(f.engine,bundle([parent,child],[],[],charges),'context').report(c.ts,c.ts).totalCostUsd,.02);
  }finally{await dispose(f);}
});

test('four-policy portfolio comparison runs offline, labels unresolved evidence and refuses session strategies',async()=>{
  const day='2026-09-22',open=nyTimestamp(day,'09:30'),close=nyTimestamp(day,'16:00');
  const tape={schema:1,source:'synthetic',quoteSizeUnits:'shares',events:[{kind:'quote',symbol:'SPY',now:open+1000,ts:open+1000,bid:99.99,ask:100.01,bidSize:100,askSize:100}]};
  const calendar={coverageFrom:day,coverageTo:day,observedAt:open-86400000,sessions:[{date:day,open,close}]};
  const result=await compareResearch(tape,calendar,bundle(),{STRATEGIES:'range_breakout'});
  assert.deepEqual(result.rows.map(r=>r.policy),['rules','jev','context','critic']);assert.equal(result.qualification.liveEligible,false);assert.equal(result.experimentId.length,64);
  assert.equal(result.rows.every(r=>r.closedTrades===0&&r.winRate===null),true);
  await assert.rejects(compareResearch(tape,calendar,bundle(),{STRATEGIES:'vwap_trend'}),/worker strategies/);
});

test('portfolio comparison preserves a winning baseline trade and exposes the opportunity rejected by the critic',async()=>{
  const f=await fixture();try{
    const {tape,calendar,settings}=pyramidingTape(),parent=record(f),child=record(f,{stage:'critic',parentId:parent.id,criticPass:false});
    const charges=[{id:'thesis-cost',at:parent.availableAt,stage:'thesis',costUsd:.01},{id:'critic-cost',at:child.availableAt,stage:'critic',costUsd:.01}];
    const result=await compareResearch(tape,calendar,bundle([parent,child],[],[],charges),settings);
    const rows=Object.fromEntries(result.rows.map(r=>[r.policy,r]));
    assert.equal(rows.rules.closedTrades,1);assert.ok(rows.rules.realizedNetBeforeModels>0);
    assert.equal(rows.context.closedTrades,1);assert.equal(rows.context.realizedNetBeforeModels,rows.rules.realizedNetBeforeModels);
    assert.equal(rows.context.recordedModelCosts,.01);assert.equal(rows.critic.recordedModelCosts,.02);
    assert.equal(rows.critic.closedTrades,0);assert.equal(rows.critic.skippedBaselineWinners,1);
    assert.ok(rows.jev.coverage.missing>0);assert.equal(result.qualification.missingCoverage,true);
    assert.equal(result.evidence,'synthetic_functional_check');assert.equal(result.qualification.liveEligible,false);
  }finally{await dispose(f);}
});

test('model input or threshold drift is reported as missing coverage, never silently reused',async()=>{
  const f=await fixture();try{
    const c=f.prepare(),m=model(c);m.thresholds.quality=.2;
    const reviews=new RecordedResearch(f.engine,bundle([],[m]),'jev');await reviews.submit(c);
    assert.equal(f.store.getCandidate(c.id).reason,'recorded_model_policy_mismatch');assert.equal(reviews.counts.missing,1);
    assert.equal(f.store.orders().length,0);
  }finally{await dispose(f);}
});

test('replay suspends context during a news coverage gap and only restores it after observed recovery',async()=>{
  const f=await fixture();try{
    const r=record(f),at=f.now(),timeline=[{at:at-1000,available:true},{at,available:false},{at:at+1000,available:true}];
    const reviews=new RecordedResearch(f.engine,bundle([r],[],[],[],timeline),'context');
    assert.ok(reviews.context('SPY',at-1));assert.equal(reviews.context('SPY',at),null);assert.equal(reviews.context('SPY',at+999),null);
    assert.ok(reviews.context('SPY',at+1000));
    assert.equal(new RecordedResearch(f.engine,bundle([r],[],[],[],[]),'context').context('SPY',at),null);
  }finally{await dispose(f);}
});
