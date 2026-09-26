// Alpaca's minute-bar condition matrix, checked 2026-09-24. This deliberately
// does not claim to implement every SIP daily-bar or last-sale convention.
export const CONDITION_VERSION='alpaca-minute-volume-v1-2026-09-24';
// Source specification: https://docs.alpaca.markets/us/docs/market-data-faq
const commonPrice='FKLOTX56',commonVolumeOnly='CHINPRUVZ47',excluded='MQ9';
export function tradeEligibility(tape,conditions){
  if(!['A','B','C'].includes(tape)||!Array.isArray(conditions)||!conditions.length||conditions.some(c=>typeof c!=='string'||c.length!==1))return {known:false,price:false,volume:false};
  const price=new Set(commonPrice+(tape==='C'?'@ABDY':' E'));
  const volumeOnly=new Set(commonVolumeOnly+(tape==='C'?'GW':'B'));
  let p=true,v=true;
  for(const c of conditions){
    if(price.has(c))continue;
    if(volumeOnly.has(c)){p=false;continue;}
    if(excluded.includes(c)){p=false;v=false;continue;}
    return {known:false,price:false,volume:false};
  }
  return {known:true,price:p,volume:v};
}
export function quoteEligibility(tape,conditions){
  // A deliberately narrow executable-quote policy: reject slow/manual/auction
  // and unfamiliar conditions rather than assuming every NBBO is accessible.
  return ['A','B','C'].includes(tape)&&Array.isArray(conditions)&&conditions.length>0&&conditions.every(c=>c==='R');
}
export function tradingHalt(tape,status){
  // Use status, never the reason's suggestion of a future resumption time.
  if(['A','B'].includes(tape)){if(status==='2')return true;if(status==='3')return false;}
  if(tape==='C'){if(['H','Q','P'].includes(status))return true;if(status==='T')return false;}
  return null;
}
export function providerTime(value){
  const match=/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(value??'');
  if(!match)throw new Error('Invalid provider timestamp');
  const base=Date.parse(match[1]+'Z');
  if(!Number.isFinite(base)||new Date(base).toISOString().slice(0,19)!==match[1])throw new Error('Invalid provider timestamp');
  const ns=BigInt(base)*1000000n+BigInt((match[2]??'').padEnd(9,'0'));
  return {ts:Number(ns/1000000n),timestampNs:ns.toString()};
}
