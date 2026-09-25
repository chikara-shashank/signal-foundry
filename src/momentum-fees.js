import { readFileSync } from 'node:fs';
import { hash } from './util.js';
export const FEE_SCHEDULE = JSON.parse(readFileSync(new URL('./fee-schedules.json', import.meta.url), 'utf8'));
export const FEE_SCHEDULE_HASH = hash(FEE_SCHEDULE);
// Effective-dated research costs, with table identity kept separate from signal code.
export function robinhoodEquityFee({side,qty,price,date,orderTotalShares=qty,orderTotalNotional=qty*price}, table=FEE_SCHEDULE) {
  if(!['buy','sell'].includes(side)||!Number.isInteger(qty)||qty<1||!(price>0)||!Number.isFinite(price)) throw new Error('Invalid execution');
  if(!/^\d{4}-\d\d-\d\d$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date) throw new Error('Invalid execution date');
  const applicable=table.schedules.filter(s=>date>=s.effectiveFrom&&(!s.effectiveTo||date<s.effectiveTo));
  if(applicable.length!==1)throw new Error('Missing or ambiguous effective fee schedule');
  const schedule=applicable[0];
  if(!Number.isInteger(orderTotalShares)||orderTotalShares<qty||!Number.isFinite(orderTotalNotional)||orderTotalNotional+1e-8<qty*price) throw new Error('Invalid order totals');
  const shares=BigInt(qty), micros=BigInt(Math.round(qty*price*1e6));
  const ceil=(n,d)=>(n+d-1n)/d;
  const rounded=(n,d)=>n<d?0n:(n+d/2n)/d;
  const sec=side==='sell'&&orderTotalNotional>schedule.secWaiverNotional ? ceil(micros*BigInt(schedule.secNumerator),BigInt(schedule.secDenominator)):0n;
  const tafRaw=rounded(shares*BigInt(schedule.tafNumerator),BigInt(schedule.tafDenominator)),cap=BigInt(schedule.tafCapCents);
  const taf=side==='sell'&&orderTotalShares>schedule.tafWaiverShares ? (tafRaw>cap?cap:tafRaw):0n;
  const cat=rounded(shares*BigInt(schedule.catNumerator),BigInt(schedule.catDenominator));
  return {commission:0,sec:Number(sec)/100,taf:Number(taf)/100,cat:Number(cat)/100,total:Number(sec+taf+cat)/100,scheduleVersion:table.version,scheduleHash:hash(table),costAssumption:date>table.reviewedAt};
}
