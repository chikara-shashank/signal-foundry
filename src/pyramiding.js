import { BREAKOUTS } from './breakout-exits.js';
import { campaignEntries, campaignMark, remainingQty } from './position-book.js';
import { idFor, isCrypto, positive, validateQuote, floorStep } from './util.js';

// Frozen forward experiment. Changing these creates a different manifest.
export const ADD_POLICY = Object.freeze({ version:1, fraction:.25, maxAdds:1, armR:1, consolidationBars:3,
  volumeMultiple:1.5, minNetRewardRisk:1.5, retainPeakFraction:.5, minDelayMs:180000 });
export const supportsAdditions = id => BREAKOUTS.includes(id);
export function additionPolicy(e,id) {
  return e.cfg.mode !== 'live' && e.cfg.breakoutProtection && supportsAdditions(id) && e.strategyControls.additionsEnabled(id) ? {...ADD_POLICY} : null;
}

// One distinct, completed consolidation breakout, all bars after the first fill.
// Failed-breakout entries also need this continuation setup before an addition.
export function additionSetup(e, root, f) {
  const p=root.addPolicy, b=f?.bar, now=e.clock();
  if (!p || !b || !positive(f.atr) || now-b.ts-60000>10000 || b.ts+60000>now ||
      f.regime==='shock' || !(f.ema9>f.ema21 && f.trend5>0 && f.trend15>=0) || f.trend15==null) return null;
  const bars=(e.features.history.get(root.symbol) ?? []).filter(x=>x.ts<b.ts).slice(-p.consolidationBars);
  if (bars.length!==p.consolidationBars || bars[0].ts<(root.filledAt ?? root.ts) ||
      bars.some((x,i)=>x.ts!==b.ts-(bars.length-i)*60000)) return null;
  const high=Math.max(...bars.map(x=>x.high)), low=Math.min(...bars.map(x=>x.low));
  const volume=bars.reduce((n,x)=>n+x.volume,0)/bars.length;
  if (!(high-low<=f.atr && low>root.fillPrice && b.close>high+.05*f.atr && b.close-high<=f.atr &&
      b.high>b.low && (b.close-b.low)/(b.high-b.low)>=.65 && b.volume>=volume*p.volumeMultiple &&
      f.relativeVolume>=p.volumeMultiple)) return null;
  return {high,low,barTs:b.ts};
}

export function additionCandidate(e,f) {
  const m=e.managed[f.symbol], root=m && e.store.getOrder(m.entryId);
  if (!root || !e.strategyControls.enabled(root.strategy) || !e.strategyControls.additionsEnabled(root.strategy)) return null;
  const setup=additionSetup(e,root,f); if(!setup)return null;
  return {id:idFor('a',[root.id,root.addPolicy.version,f.version]),campaignId:root.id,addition:true,
    strategy:root.strategy,symbol:root.symbol,ts:e.clock(),expires:e.clock()+10000,reference:f.bar.close,
    stop:Math.max(m.excursion?.floor ?? root.stop,setup.low-.15*f.atr),target:root.target,
    features:f,status:'discovered',strategyGeneration:e.strategyControls.generation(root.strategy)};
}

export function checkAddition(e,c) {
  const deny=reason=>({ok:false,reason});
  const m=e.managed[c.symbol], root=m && e.store.getOrder(m.entryId), now=e.clock(), q=e.quotes.get(c.symbol);
  if (e.cfg.mode==='live' || isCrypto(c.symbol) || !supportsAdditions(c.strategy))return deny('additions_paper_equities_only');
  if (!e.strategyControls.additionsEnabled(c.strategy))return deny('additions_disabled');
  if (!root?.addPolicy || c.campaignId!==root.id || root.strategy!==c.strategy)return deny('addition_campaign_not_eligible');
  const p=root.addPolicy, orders=e.store.orders();
  if (campaignEntries(orders,root.id).length>p.maxAdds)return deny('addition_limit');
  if (!root.exitPolicy || m.exitReason || root.status!=='filled' || !root.settledAt ||
      root.filledQty!==root.qty || remainingQty(orders,root)!==root.filledQty || e.externalSymbols.has(c.symbol) ||
      e.pending().some(o=>o.symbol===c.symbol))return deny('addition_position_not_settled');
  if (now-m.openedAt<p.minDelayMs || now-m.openedAt>=m.maxHold)return deny('addition_timing');
  if (!validateQuote(q,now,e.cfg.maxQuoteAge) || q.bid<root.fillPrice+p.armR*(root.fillPrice-root.stop) ||
      !positive(m.excursion?.floor))return deny('addition_profit_not_protected');
  const setup=additionSetup(e,root,c.features);
  if(!setup)return deny('addition_needs_new_consolidation');
  const stop=floorStep(Math.max(m.excursion.floor,setup.low-.15*c.features.atr),.01);
  const marked=campaignMark(orders,root.id,q.bid,e.cfg.slippage);
  if(!(marked.net>0) || !(q.bid>stop+.01))return deny('addition_profit_not_protected');
  const limit=floorStep(q.ask*(1+e.cfg.slippage/10000)+.01,.01), fee=e.cfg.equityFee/10000;
  const exitNet=stop*(1-e.cfg.slippage/10000)*(1-fee), perShareLoss=limit*(1+fee)-exitNet;
  const retained=Math.max(marked.net,m.campaignExcursion?.peakNet ?? marked.net)*p.retainPeakFraction;
  const atStop=campaignMark(orders,root.id,stop,e.cfg.slippage).net;
  const riskBudget=Math.min(e.cfg.risk,root.riskAtStop ?? e.cfg.risk);
  const maxQty=Math.floor(Math.min(root.filledQty*p.fraction,(atStop-retained)/perShareLoss,(atStop+riskBudget)/perShareLoss));
  if(!(maxQty>=1))return deny('addition_risk_or_giveback_budget');
  // Adding cannot consume the remaining daily ceiling through all open stops.
  let openRisk=0;
  for(const position of e.portfolio.positions) {
    const managed=e.managed[position.symbol], quote=e.quotes.get(position.symbol);
    if(!managed || !validateQuote(quote,now,e.cfg.maxQuoteAge))return deny('addition_portfolio_marks_stale');
    const floor=position.symbol===c.symbol?stop:Math.max(managed.stop,managed.excursion?.floor ?? 0,managed.addFloor ?? 0);
    openRisk+=position.qty*Math.max(0,quote.bid-floor*(1-e.cfg.slippage/10000)) + position.qty*quote.bid*fee;
  }
  const dailyPnl=e.cfg.accountPolicy==='shared'?e.portfolio.state.dailyPnl:e.dailyPnl;
  if(!Number.isFinite(dailyPnl))return deny('addition_daily_risk_unavailable');
  const dailyQty=Math.floor((e.dailyLossLimit+Math.min(0,dailyPnl)-openRisk)/perShareLoss);
  if(dailyQty<1)return deny('addition_daily_risk_budget');
  return {ok:true,rootId:root.id,stop,target:root.target,maxQty:Math.min(maxQty,dailyQty),riskBudget,retained,setup,
    existingValue:marked.qty*q.ask,minNetRewardRisk:p.minNetRewardRisk};
}

export function observeCampaign(e,m,root,q) {
  if(!root.addPolicy)return;
  const orders=e.campaignBooks.get(root.id) ?? [root], entries=campaignEntries(orders,root.id);
  if(entries.some(o=>o.filledQty>0 && q.ts<(o.lastFillObservedAt ?? o.filledAt ?? o.ts)))return;
  const mark=campaignMark(orders,root.id,q.bid,e.cfg.slippage);
  const prior=m.campaignExcursion ?? {};
  m.campaignExcursion={...prior,lastNet:mark.net,peakNet:Math.max(prior.peakNet ?? mark.net,mark.net),observedAt:q.ts};
  if(!entries.some(o=>o.addition && o.filledQty>0))return;
  // Preserve peak dollars across additional fills. A cost-basis change must
  // never relax the campaign floor or restart the holding clock.
  const retained=m.campaignExcursion.peakNet*root.addPolicy.retainPeakFraction;
  const zero=campaignMark(orders,root.id,0,e.cfg.slippage).net;
  const one=campaignMark(orders,root.id,1,e.cfg.slippage).net-zero;
  if(one>0)m.addFloor=Math.max(m.addFloor ?? root.stop,(retained-zero)/one,m.excursion?.floor ?? root.stop);
  if(positive(m.addFloor) && q.bid<=m.addFloor)e.latchExit(root.symbol,root.id,'addition_profit_protection',{bid:q.bid,floor:m.addFloor});
}
