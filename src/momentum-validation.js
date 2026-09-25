import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
export function momentumCodeHash(){
  const names=['src/momentum-scanner.js','src/momentum-fees.js','src/momentum-pullback.js','src/momentum-portfolio.js','src/momentum-research.js','src/momentum-validation.js','src/momentum-conditions.js','src/momentum-normalize.js','src/momentum-recorder.js','src/momentum-data.js','scripts/momentum-data.js','scripts/momentum-research.js','docs/momentum-experiment-v0.json'];
  const h=createHash('sha256');for(const name of names)h.update(name+'\n').update(readFileSync(new URL('../'+name,import.meta.url)));return h.digest('hex');
}
export function freezeExperiment(input,now=Date.now()){
  if(Object.hasOwn(input,'sha256'))throw new Error('Registration input must not contain a prior digest');
  const dates=input.sessionDates;
  if(!Array.isArray(dates)||dates.length!==120||dates.some((d,i)=>!/^\d{4}-\d\d-\d\d$/.test(d)||(i&&d<=dates[i-1])))throw new Error('Exactly 120 chronological exchange-calendar dates are required');
  if(dates[0]<=new Date(now).toISOString().slice(0,10))throw new Error('Holdout must begin on an unseen future date');
  if(!Number.isFinite(input.operatingCostPerSession)||input.operatingCostPerSession<0)throw new Error('Explicit operating cost budget required');
  if(!Array.isArray(input.pilotDates)||input.pilotDates.length!==10||input.pilotDates.some((d,i)=>d>=dates[0]||(i&&d<=input.pilotDates[i-1]))||input.pilotDates.at(-1)>new Date(now).toISOString().slice(0,10))throw new Error('Ten completed chronological pilot sessions required');
  for(const key of ['pilotReportSha256','dataContractSha256','calendarSha256'])if(!/^[a-f0-9]{64}$/.test(input[key]??''))throw new Error(`Missing ${key}`);
  if(!input.floatSource||!input.newsClassificationVersion||!input.feeVersion||input.operationalSignoff!==true)throw new Error('Data sources, fee convention and operational signoff required');
  const registration={...input,version:1,frozenAt:new Date(now).toISOString(),codeSha256:momentumCodeHash(),status:'registered_not_validated'};
  registration.sha256=createHash('sha256').update(JSON.stringify(registration)).digest('hex');return registration;
}
export function assessExperiment(primary,stress,registration){
  const {sha256,...body}=registration;
  if(createHash('sha256').update(JSON.stringify(body)).digest('hex')!==sha256)throw new Error('Registration integrity mismatch');
  const reasons=[];
  if(primary.replay?.codeSha256!==registration.codeSha256||stress.replay?.codeSha256!==registration.codeSha256)reasons.push('code_changed_since_registration');
  if(primary.replay?.inputSha256!==stress.replay?.inputSha256)reasons.push('different_input_tapes');
  if(primary.replay?.scenario!=='primary_1000ms'||stress.replay?.scenario!=='stress_3500ms_one_tick')reasons.push('incorrect_scenarios');
  for(const [name,r] of [['primary',primary],['stress',stress]]){
    if(r.dataContractSha256!==registration.dataContractSha256)reasons.push(`${name}_data_contract_changed`);
    if(r.source!=='recorded'||!r.coverageComplete||r.dataErrors.length||!r.portfolio.completeLiquidation)reasons.push(`${name}_incomplete_or_synthetic`);
    if(JSON.stringify(r.portfolio.days.map(d=>d.date))!==JSON.stringify(registration.sessionDates))reasons.push(`${name}_wrong_holdout_dates`);
  }
  if(primary.portfolio.closedTrades.length<200)reasons.push('fewer_than_200_closed_trades');
  const days=primary.portfolio.days.map(d=>d.netUsd-registration.operatingCostPerSession);
  if(!days.length||days.some(x=>!Number.isFinite(x)))throw new Error('Invalid daily P/L');
  const netUsd=days.reduce((a,b)=>a+b,0),stressNetUsd=stress.portfolio.days.reduce((s,d)=>s+d.netUsd-registration.operatingCostPerSession,0);
  let state=239724;const random=()=>{state=(Math.imul(1664525,state)+1013904223)>>>0;return state/4294967296;};const samples=[];
  for(let k=0;k<5000;k++){let total=0,n=0;while(n<days.length){const start=Math.floor(random()*Math.max(1,days.length-4));for(let j=0;j<5&&n<days.length;j++,n++)total+=days[(start+j)%days.length];}samples.push(total/days.length);}
  samples.sort((a,b)=>a-b);const meanDailyCI95=[samples[125],samples[4875]];
  if(meanDailyCI95[0]<=0)reasons.push('lower_net_confidence_bound_not_positive');
  if(stressNetUsd<=0)reasons.push('stress_not_profitable');
  return {status:reasons.length?'not_validated':'eligible_for_execution_calibration_review',automaticDeployment:false,reasons,netUsd,stressNetUsd,meanDailyCI95,registrationSha256:sha256,note:'A passing simulation only permits review of a separately authorized execution calibration; it is not proof of future returns.'};
}
