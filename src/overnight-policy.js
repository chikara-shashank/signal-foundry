import { isCrypto, positive, validateQuote } from './util.js';
import { campaignId, remainingQty } from './position-book.js';

export const CARRY_STRATEGY='close_strength_carry';
export function overnightAllocation(engine) {
  const e=engine, book=e.portfolio.state;
  const available=book.valid&&Number.isFinite(book.totalPnl)&&positive(e.account?.equity);
  const base=available?Math.max(0,Math.min(e.cfg.capital,e.cfg.capital+book.totalPnl,e.account.equity)):0;
  const orders=e.store.orders(), roots=new Set(orders.filter(o=>o.holdingPolicy?.type==='carry').map(o=>campaignId(o)));
  let held=0,reserved=0;
  const positions=[];
  for(const o of orders.filter(o=>o.kind==='entry'&&roots.has(campaignId(o)))) {
    const qty=Math.max(0,remainingQty(orders,o)), p=e.positions.find(p=>p.symbol===o.symbol), q=e.quotes.get(o.symbol);
    const mark=Math.max(o.fillPrice??0,Math.abs(p?.marketValue??0)/Math.max(Math.abs(p?.qty??0),1e-12),validateQuote(q,e.clock(),e.cfg.maxQuoteAge)?q.ask:0);
    const value=qty*mark;held+=value;
    if(!['filled','canceled','expired','rejected','aborted'].includes(o.status))reserved+=Math.max(0,o.qty-(o.filledQty??0))*o.limit*(1+(o.feeRateBps??e.cfg.equityFee)/10000);
    if(qty>0)positions.push({symbol:o.symbol,entryId:campaignId(o),value});
  }
  const cap=base*e.cfg.overnight.capFraction, exposure=held+reserved;
  return {basis:'engine_allocated_equity',available,base,cap,held,reserved,exposure,fraction:base>0?exposure/base:null,headroom:Math.max(0,cap-exposure),breached:available&&exposure>cap+1e-7,positions,capFraction:e.cfg.overnight.capFraction};
}

// A price hypothesis, not a prediction: sustained closing strength and participation
// must accompany favorable, relevant news. Thresholds are frozen in experiment IDs.
export function closingPattern(bars, session, now) {
  if(!session)return null;
  const end=Math.min(Math.floor(now/60000)*60000,session.close), start=Math.max(session.open,end-60*60000);
  const rows=[...new Map(bars.filter(b=>b.ts>=start&&b.ts+60000<=end).map(b=>[b.ts,b])).values()].sort((a,b)=>a.ts-b.ts);
  if(rows.length<50||rows.at(-1).ts+60000!==end||rows.some((b,i)=>i&&b.ts-rows[i-1].ts!==60000))return null;
  const last=rows.at(-1), first=rows[0], half=Math.floor(rows.length/2), volume=rows.reduce((n,b)=>n+b.volume,0), prior=rows.slice(0,half), recent=rows.slice(half);
  if(!positive(volume)||rows.some(b=>![b.open,b.close,b.high,b.low].every(positive)||!Number.isFinite(b.volume)||b.volume<0))return null;
  const high=Math.max(...rows.map(b=>b.high)), low=Math.min(...rows.map(b=>b.low)), vwap=rows.reduce((n,b)=>n+(b.vwap??(b.high+b.low+b.close)/3)*b.volume,0)/volume;
  const rv=(recent.reduce((n,b)=>n+b.volume,0)/recent.length)/(prior.reduce((n,b)=>n+b.volume,0)/prior.length);
  const atr=rows.slice(1).reduce((n,b,i)=>n+Math.max(b.high-b.low,Math.abs(b.high-rows[i].close),Math.abs(b.low-rows[i].close)),0)/(rows.length-1);
  const location=(last.close-low)/Math.max(high-low,.0001), change=last.close/first.open-1;
  const matched=Number.isFinite(rv)&&positive(atr)&&location>=.8&&last.close>vwap&&change>=.003&&change<=.04&&rv>=1.2&&last.close>=Math.max(...rows.slice(-21,-1).map(b=>b.close));
  return {matched,at:end,price:last.close,vwap,location,change,relativeVolume:rv,atr,low,high,minuteBars:rows.length,dollarVolume:volume*last.close,
    score:location*40+Math.min(rv,4)*10+Math.min(change*100,4)*5,version:'closing-strength-1'};
}
export function favorableNews(view, now) {
  return !!view&&!view.reason&&now>=view.at&&now-view.at<=24*3600000&&view.latestPublishedAt<=now&&now-view.latestPublishedAt<=36*3600000&&view.relevance>=.8&&view.direction==='positive'&&view.confidence>=.8&&view.materiality>=.75&&view.materialityConfidence>=.75&&view.hazard==='none_identified'&&view.hazardConfidence>=.8;
}
export function carryGuard(engine, candidate) {
  const e=engine, now=e.clock(), state=e.schedule?.state(now);
  if(!e.cfg.overnight.enabled||!['paper','shadow'].includes(e.cfg.mode))return 'carry_paper_or_shadow_only';
  if(candidate.addition||candidate.sizing)return 'carry_policy_invalid';
  if(isCrypto(candidate.symbol)||!state?.carryWindow||!e.session?.open)return 'carry_entry_window_closed';
  if(!candidate.holdingPolicy||candidate.holdingPolicy.type!=='carry'||!positive(candidate.holdingPolicy.exitBy)||candidate.holdingPolicy.exitBy<=now)return 'carry_policy_invalid';
  if(!e.desk?.verifiedCandidate(candidate,now))return 'carry_thesis_stale';
  if(overnightAllocation(e).headroom<=0)return 'carry_allocation_limit';
  return null;
}
export function adverseNews(view,now) {
  return !!view&&!view.reason&&now>=view.at&&now-view.at<86400000&&view.relevance>=.8&&view.confidence>=.8&&(view.direction==='negative'||view.hazardConfidence>=.8&&['financing_or_dilution','binary_event'].includes(view.hazard));
}
