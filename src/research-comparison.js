import { replayEngine } from './engine-replay.js';
import { REVIEW_POLICIES, validateReviewBundle } from './recorded-research.js';
import { hash, terminal } from './util.js';

export async function compareResearch(tape,calendar,bundle,settings={},execution={}) {
  validateReviewBundle(bundle);
  const reports={};
  for(const policy of REVIEW_POLICIES)reports[policy]=await replayEngine(tape,calendar,settings,{...execution,review:{policy,bundle}});
  const base=reports.rules,keys=new Map(base.review.candidates.map(c=>[c.candidateId,c.candidateKey]));
  const baseTrades=base.trades.filter(t=>t.fullyClosed).map(t=>({...t,key:keys.get(base.orders.find(o=>o.id===t.entryId)?.candidateId)}));
  const rows=REVIEW_POLICIES.map(policy=>{
    const r=reports[policy],entered=new Set(r.review.candidates.filter(c=>c.orderId).map(c=>c.candidateKey)),skipped=baseTrades.filter(t=>t.key&&!entered.has(t.key));
    const closed=r.trades.filter(t=>t.fullyClosed),closedNet=closed.reduce((s,t)=>s+t.estimatedNetPnl,0);
    return {policy,candidates:r.candidateCount,closedTrades:r.closedTradeCount,winRate:r.winRate,
      realizedNetBeforeModels:r.estimatedNetPnl,recordedModelCosts:r.review.totalCostUsd,realizedNetAfterModels:r.netAfterRecordedModelCosts,
      closedTradeExpectancyBeforeModels:closed.length?closedNet/closed.length:null,
      realizedDailyDrawdownBeforeModels:r.recordedDailyDrawdownUsd,coverage:r.review.counts,
      skippedBaselineWinners:skipped.filter(t=>t.estimatedNetPnl>0).length,skippedBaselineLosers:skipped.filter(t=>t.estimatedNetPnl<0).length,
      skippedBaselineNet:skipped.reduce((s,t)=>s+t.estimatedNetPnl,0),openPositions:r.openPositions.length,pendingReviews:r.review.pending,
      pendingOrders:r.orders.filter(o=>!terminal(o.status)).length,accountingValid:r.pnlAvailable&&r.finalState.portfolio.valid,
      totalMarkedNetAfterModels:r.finalState.portfolio.valid?r.finalState.portfolio.totalPnl-r.review.totalCostUsd:null};
  });
  const missing=rows.some(r=>r.coverage.missing>0),unresolved=rows.some(r=>r.openPositions||r.pendingReviews||r.pendingOrders||!r.accountingValid);
  return {schema:1,experimentId:hash({tape:hash(tape),calendar:hash(calendar),bundle:bundle.digest,settings,execution,source:base.replay.sourceSha256}),
    inputHashes:{tape:hash(tape),calendar:hash(calendar),bundle:bundle.digest,source:base.replay.sourceSha256},rows,reports,
    evidence:tape.source==='synthetic'?'synthetic_functional_check':'unvalidated_recorded_sample',
    qualification:{liveEligible:false,state:'unvalidated',missingCoverage:missing,unresolvedExposure:unresolved,
      reasons:['Frozen unseen-date and forward validation required',...(missing?['Missing recorded decisions can create selection bias']:[]),...(unresolved?['Open exposure or unfinished reviews remain']:[])]},
    limitations:['Equity worker strategies only. Model scores are semantic judgments, not return probabilities.',
      'Realized figures exclude open P/L and infrastructure costs; drawdown is the existing within-day observation metric before model charges.',
      'Skipped baseline trades are diagnostics, not independently executable profits under an alternative portfolio.',
      'Pinned source snapshots prevent feed look-ahead, but historical inference with a newer model can still contain training-data leakage. Prefer prospective recording.',
      'No automatic promotion, parameter fitting, or live strategy changes.']};
}
