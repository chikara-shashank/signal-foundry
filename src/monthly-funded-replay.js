import { monthlyTrendContext, MONTHLY_TREND as P } from './monthly-trend.js';
import { nyDate, nyTimestamp } from './util.js';

// Isolated sleeve, five-minute OHLC approximation of the installed bracketed
// strategy. No hidden leverage, fractional lots or ex-post best-symbol selection.
export function replayMonthlyFunded({ bars, daily, calendar, from, to, costBps=4, delayBars=0 }) {
  const dates=calendar.map(d=>d.date), sessions=new Map(calendar.map((d,index)=>[d.date,{...d,index,entryAt:nyTimestamp(d.date,'15:30')+delayBars*300000,fullSession:d.close>=nyTimestamp(d.date,'16:00')}]));
  const timeline=new Map();
  for(const b of bars)if(b.date>=from&&b.date<to){if(!timeline.has(b.ts))timeline.set(b.ts,new Map());timeline.get(b.ts).set(b.symbol,b);}
  const held=new Map(), marks=new Map(), used=new Set(), contexts=new Map(), history=[], trades=[];
  let cash=10000,peak=10000,drawdown=0,missingBars=0,blockedLots=0,entries=0,maxExposure=0,capBreaches=0;
  const cost=costBps/10000, value=()=>cash+[...held].reduce((n,[s,p])=>n+p.qty*marks.get(s),0);
  const allocationValue=(s,p)=>p.qty*Math.max(marks.get(s),p.fill);
  const close=(symbol,price,at,reason)=>{const p=held.get(symbol),proceeds=p.qty*price*(1-cost);cash+=proceeds;trades.push({symbol,openedAt:p.openedAt,closedAt:at,qty:p.qty,netPnl:proceeds-p.cost,reason});held.delete(symbol);};
  for(const[ts,frame]of [...timeline].sort((a,b)=>a[0]-b[0])) {
    const date=frame.values().next().value.date,month=date.slice(0,7),session=sessions.get(date),index=session?.index,entryAt=session?.entryAt;
    if(!session||ts<session.open||ts>=session.close)throw new Error('monthly_funded_session');
    // Missing bars are counted, never synthesized. Their unknown intrabar path
    // prevents a validation claim even though observed-price diagnostics continue.
    for(const symbol of P.symbols)if(!frame.has(symbol))missingBars++;
    for(const[s,b]of frame)marks.set(s,b.open);
    if(!contexts.has(month))contexts.set(month,new Map(P.symbols.map(s=>[s,monthlyTrendContext(daily[s],dates,date)])));
    const signals=contexts.get(month);
    for(const[s,p]of [...held]) {
      const b=frame.get(s);if(!b)continue;
      if(ts>=p.deadline)close(s,b.open,ts,'holding_deadline');
      else if(ts>=entryAt&&signals.get(s)?.long===false)close(s,b.open,ts,'monthly_trend_reversed');
      else if(b.low<=p.stop)close(s,Math.min(b.open,p.stop),ts,'stop');
      else if(b.high>=p.target)close(s,p.target,ts,'target');
    }
    // Enforce the same aggregate allocation response: liquidate largest owned
    // carry positions first if appreciation pushes marked exposure over the cap.
    let base=Math.max(0,Math.min(10000,value())),gross=[...held].reduce((n,[s,p])=>n+allocationValue(s,p),0);
    if(gross>base*.095+1e-8) {
      capBreaches++;
      for(const[s,p]of [...held].sort((a,b)=>allocationValue(b[0],b[1])-allocationValue(a[0],a[1]))) {
        const b=frame.get(s);if(!b)continue;const reserved=allocationValue(s,p);close(s,b.open,ts,'overnight_allocation_limit');gross-=reserved;if(gross<=base*.095)break;
      }
    }
    const fullSession=session.fullSession;
    if(fullSession&&ts>=entryAt&&ts<session.close-5*60000&&frame.size===P.symbols.length)for(const symbol of P.symbols) {
      const key=symbol+':'+month,b=frame.get(symbol),signal=signals.get(symbol),deadline=calendar[index+P.sessions]?.close-5*60000;
      if(!signal||signal.reason||!signal.long||held.has(symbol)||used.has(key)||!deadline)continue;
      base=Math.max(0,Math.min(10000,value()));gross=[...held].reduce((n,[s,p])=>n+allocationValue(s,p),0);
      const entry=b.open*(1+cost),stop=Math.floor(b.open*(1-P.stopFraction)*100)/100,target=Math.floor(b.open*(1+P.targetFraction)*100)/100;
      const qty=Math.floor(Math.min(500,base*.035,base*.095-gross,cash)/entry);
      const riskQty=Math.floor(10/(entry-stop+b.open*cost)),size=Math.min(qty,riskQty);
      if(size<1){if(ts===entryAt)blockedLots++;continue;}
      const p={qty:size,cost:size*entry,fill:entry,openedAt:ts,stop,target,deadline};cash-=p.cost;held.set(symbol,p);used.add(key);entries++;
      if(b.low<=stop)close(symbol,Math.min(b.open,stop),ts,'stop');else if(b.high>=target)close(symbol,target,ts,'target');
    }
    for(const[s,b]of frame)marks.set(s,b.close);
    const equity=value();peak=Math.max(peak,equity);drawdown=Math.max(drawdown,peak-equity);maxExposure=Math.max(maxExposure,[...held].reduce((n,[s,p])=>n+p.qty*marks.get(s),0));
    if(history.at(-1)?.date===date)history[history.length-1]={date,equity};else history.push({date,equity});
  }
  const last=[...timeline.keys()].sort((a,b)=>a-b).at(-1);
  if (!Number.isFinite(last)) throw new Error('monthly_funded_empty');
  const expected=calendar.filter(d=>d.date>=from&&d.date<to&&d.date<=nyDate(last)).reduce((n,d)=>n+(d.close-d.open)/300000*P.symbols.length,0);
  missingBars=Math.max(missingBars,expected-[...timeline.values()].reduce((n,f)=>n+f.size,0));
  for(const[s]of [...held])close(s,marks.get(s),last+300000,'study_end_liquidation');
  const gains=trades.filter(t=>t.netPnl>0).reduce((n,t)=>n+t.netPnl,0),losses=-trades.filter(t=>t.netPnl<0).reduce((n,t)=>n+t.netPnl,0);
  drawdown=Math.max(drawdown,peak-cash);
  return {netPnl:cash-10000,netReturnPct:(cash/10000-1)*100,closedTrades:trades.length,entries,winRate:trades.length?trades.filter(t=>t.netPnl>0).length/trades.length:null,
    profitFactor:losses?gains/losses:null,sampledMaxDrawdownUsd:drawdown,maxObservedExposureUsd:maxExposure,capBreachResponses:capBreaches,blockedLots,missingFiveMinuteBars:missingBars,
    daily:history,trades};
}
