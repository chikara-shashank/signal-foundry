import test from 'node:test';
import assert from 'node:assert/strict';
import {freezeExperiment,assessExperiment} from '../src/momentum-validation.js';
import {MomentumData} from '../src/momentum-data.js';
const dates=Array.from({length:120},(_,i)=>new Date(Date.UTC(2026,9,1+i)).toISOString().slice(0,10));
const spec=()=>({sessionDates:dates,pilotDates:Array.from({length:10},(_,i)=>`2026-09-${String(i+1).padStart(2,'0')}`),operatingCostPerSession:1,pilotReportSha256:'1'.repeat(64),dataContractSha256:'2'.repeat(64),calendarSha256:'3'.repeat(64),floatSource:'synthetic test evidence',newsClassificationVersion:'unit-test',feeVersion:'unit-test',operationalSignoff:true});
const now=Date.parse('2026-09-24T12:00:00Z');
test('Registration refuses past holdouts, unknown costs and incomplete pilots',()=>{
  assert.throws(()=>freezeExperiment({...spec(),operatingCostPerSession:null},now));
  assert.throws(()=>freezeExperiment({...spec(),pilotDates:[]},now));
  assert.throws(()=>freezeExperiment(spec(),Date.parse('2027-01-01')));
});
test('Assessment rejects synthetic results, code drift and integrity changes',()=>{
  const r=freezeExperiment(spec(),now);
  const report={source:'synthetic',coverageComplete:true,dataErrors:[],replay:{codeSha256:r.codeSha256,inputSha256:'4'.repeat(64),scenario:'primary_1000ms'},portfolio:{completeLiquidation:true,days:dates.map(date=>({date,netUsd:2})),closedTrades:Array(200).fill({})}};
  const stress=structuredClone(report);stress.replay.scenario='stress_3500ms_one_tick';
  assert.ok(assessExperiment(report,stress,r).reasons.includes('primary_incomplete_or_synthetic'));
  report.replay.codeSha256='changed';assert.ok(assessExperiment(report,stress,r).reasons.includes('code_changed_since_registration'));
  r.operatingCostPerSession=0;assert.throws(()=>assessExperiment(report,stress,r));
});
test('Data client permits only GET requests to fixed provider hosts',async()=>{
  const calls=[];const d=new MomentumData({key:'fixture-key',secret:'fixture-secret',fetchFn:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({})};}});
  await assert.rejects(d.get('https://example.invalid','/v2/clock'));
  await d.get('https://data.alpaca.markets','/v2/stocks/snapshots?symbols=TEST');
  assert.equal(calls.length,1);assert.equal(calls[0].options.method,'GET');assert.equal(calls[0].options.redirect,'error');
});
test('Provider errors never expose response bodies or credentials',async()=>{
  const d=new MomentumData({key:'fixture-key',secret:'fixture-secret',fetchFn:async()=>({ok:false,status:403,json:async()=>({secret:'do not log'})})});
  await assert.rejects(d.get('https://data.alpaca.markets','/v2/stocks/snapshots'),{message:'market_data_http_403'});
});
