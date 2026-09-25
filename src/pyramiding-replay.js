import { replayEngine } from './engine-replay.js';
import { ADD_POLICY } from './pyramiding.js';
import { terminal } from './util.js';

// Both arms see the same receipt-ordered quotes, calendar and portfolio limits.
// Eligibility decisions and fills use the production engine, not hindsight peaks.
export async function comparePyramiding(tape,calendar,settings={},execution={}) {
  const additions=execution.addToWinners ?? ['range_breakout','failed_breakout'].filter(s=>(settings.STRATEGIES ?? 'range_breakout,failed_breakout').split(',').includes(s));
  const summarize=report=>({estimatedNetPnl:report.estimatedNetPnl,totalMarkedNet:report.finalState.portfolio.totalPnl,
    dailyDrawdown:report.recordedDailyDrawdownUsd,closedPositions:report.closedTradeCount,winRate:report.winRate,
    additionFills:report.orders.filter(o=>o.addition && o.filledQty>0).length,
    addedShareNet:report.trades.reduce((n,t)=>n+(t.additionNetPnl ?? 0),0),
    openPositions:report.openPositions.length,pendingOrders:report.orders.filter(o=>!terminal(o.status)).length,
    exceptions:report.exceptions.length,accountingValid:report.finalState.portfolio.valid,
    reconciliationFailed:report.finalState.issues?.includes('broker_reconciliation_failed') ?? false,rejections:report.rejectionCounts,replay:report.replay});
  const baseline=summarize(await replayEngine(tape,calendar,settings,{...execution,addToWinners:[]}));
  const scaled=summarize(await replayEngine(tape,calendar,settings,{...execution,addToWinners:additions}));
  const complete=!baseline.openPositions&&!scaled.openPositions&&!baseline.pendingOrders&&!scaled.pendingOrders&&!baseline.exceptions&&!scaled.exceptions&&baseline.accountingValid&&scaled.accountingValid&&!baseline.reconciliationFailed&&!scaled.reconciliationFailed;
  const comparable=complete&&baseline.estimatedNetPnl!==null&&scaled.estimatedNetPnl!==null;
  return {schema:1,policy:ADD_POLICY,baseline,scaled,complete,
    incrementalNet:comparable?scaled.estimatedNetPnl-baseline.estimatedNetPnl:null,
    extraDailyDrawdown:scaled.dailyDrawdown-baseline.dailyDrawdown,liveEligible:false,
    evidence:tape.source==='synthetic'?'synthetic_functional_check':'unvalidated_recorded_sample',
    note:'Added-share P/L differs from the causal change in portfolio P/L. Freeze parameters, use unseen dates, repeat with stressed latency/slippage, and resolve open exposure before interpreting results. No automatic enablement.'};
}
