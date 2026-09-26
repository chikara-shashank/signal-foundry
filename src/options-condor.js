import { contractProblem, spreadEconomics } from './options-pricing.js';
import { daysToExpiry } from './options-policy.js';

export function scanCondor(frame, symbol, definition, policy, reject) {
  const spot=frame.spots[symbol].price, rv=frame.contexts[symbol].rv20;
  if (!(rv>0)) { reject('iron_condor:regime'); return null; }
  const wings={put:[],call:[]};
  for(const type of ['put','call']) {
    const contracts=Object.values(frame.contracts).filter(c=>c.underlying===symbol&&!contractProblem(c,frame,{...definition,type},policy));
    for(const short of contracts) {
      const q=frame.quotes[short.symbol], delta=Math.abs(q?.delta);
      if(!Number.isFinite(delta)||delta<.15||delta>.25||!(q.iv>=1.25*rv)||(type==='put'?q.delta>=0||short.strike>=spot:q.delta<=0||short.strike<=spot))continue;
      for(const long of contracts) {
        const width=type==='put'?short.strike-long.strike:long.strike-short.strike;
        if(long.expiry!==short.expiry||width<1||width>policy.maxWidth)continue;
        const economics=spreadEconomics({long,short,underlying:symbol,expiry:short.expiry,credit:true,quantity:1},frame.quotes,frame.now,policy);
        if(economics.reason)continue;
        wings[type].push({long,short,delta});
      }
    }
  }
  let best=null;
  for(const put of wings.put)for(const call of wings.call) {
    if(put.short.expiry!==call.short.expiry)continue;
    const c={strategy:definition.id,underlying:symbol,credit:true,expiry:put.short.expiry,quantity:1,decisionAt:frame.now,
      legs:[{side:'long',contract:put.long},{side:'short',contract:put.short},{side:'short',contract:call.short},{side:'long',contract:call.long}]};
    const x=spreadEconomics(c,frame.quotes,frame.now,policy);
    if(x.reason){reject(x.reason);continue;}
    if(x.entryCost>=0||-x.entryCost<x.width*.20||-x.entryCost>=x.width){reject('premium_to_width');continue;}
    if(!(x.maxLoss>0&&x.maxLoss<=policy.maxRisk&&x.maxProfit>x.immediateRoundTripLoss*2)){reject('risk_or_cost');continue;}
    const rank=Math.abs(daysToExpiry(c.expiry,frame.now)-definition.targetDte)+10*(Math.abs(put.delta-.20)+Math.abs(call.delta-.20))+x.immediateRoundTripLoss/100;
    if(!best||rank<best.rank)best={...c,...x,rank};
  }
  return best;
}
