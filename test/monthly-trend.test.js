import test from 'node:test';
import assert from 'node:assert/strict';
import { monthlyTrendContext, MonthlyTrend, MONTHLY_TREND } from '../src/monthly-trend.js';
import { DailyHistory } from '../src/daily-history.js';
import { replayMonthly } from '../src/monthly-replay.js';
import { carryGuard, overnightAllocation } from '../src/overnight-policy.js';
import { MarketSchedule } from '../src/market-schedule.js';
import { EquityUniverse } from '../src/equity-universe.js';
import { nyTimestamp } from '../src/util.js';
import { fixture, quote } from './helpers.js';

function history() {
  const rows=[];
  for(let i=0;i<13;i++) {const date=new Date(Date.UTC(2025,7+i,28)).toISOString().slice(0,10),price=100+i;rows.push({date,open:price,high:price+1,low:price-1,close:price,volume:1000});}
  return {daily:rows,calendar:rows.map(r=>r.date)};
}
const dispose=async f=>{f.engine.stopped=true;clearTimeout(f.engine.streamReconcile);await f.engine.mutex.tail;f.store.close();};

test('monthly kernels use only completed months and require every expected daily close',()=>{
  const {daily,calendar}=history(), base=monthlyTrendContext(daily,calendar,'2026-09-22');
  assert.equal(base.long,true);assert.equal(base.through,'2026-08-28');
  assert.ok(Math.abs(monthlyTrendContext(daily,calendar,'2026-09-22','momentum12').momentum-.12)<1e-12);
  assert.deepEqual(monthlyTrendContext([...daily,{date:'2026-09-01',close:1},{date:'2026-10-01',close:1e9}],calendar,'2026-09-22'),base);
  assert.equal(monthlyTrendContext(daily.slice(0,-1),calendar,'2026-09-22').reason,'daily_session_gap');
  assert.ok(monthlyTrendContext([...daily,daily.at(-1)],calendar,'2026-09-22').reason);
  assert.ok(monthlyTrendContext(daily,calendar.slice(0,-1),'2026-09-22').reason);
});
test('monthly replay charges costs, executes next available open and does not round missing lots up',()=>{
  const {daily,calendar}=history(), trade={date:'2026-09-01',open:200,high:221,low:199,close:220,volume:1000};
  const args={adjusted:[...daily,trade],raw:[{...trade,open:750}],calendar:[...calendar,trade.date],from:trade.date,to:'2026-10',model:'sma10'};
  const r=replayMonthly(args);assert.ok(r.netReturnPct>9&&r.netReturnPct<10);assert.equal(r.roundTrips,1);assert.equal(r.lotFeasibilityOnly.noWholeShare,1);
  assert.ok(replayMonthly({...args,costBps:12}).netReturnPct<r.netReturnPct);
  assert.equal(replayMonthly({...args,delaySessions:1}).netReturnPct,0);
});
test('daily loader fails closed on gaps and blocks endpoints capable of receiving credentials elsewhere',async()=>{
  const calls=[],fetchFn=async(url,opts)=>{calls.push({url,opts});return {ok:true,json:async()=>url.includes('calendar')?[{date:'2026-08-27'},{date:'2026-08-28'}]:{bars:{SPY:[{t:'2026-08-28T04:00:00Z',o:100,h:101,l:99,c:100,v:1000}]}}};};
  const data=new DailyHistory({key:'test',secret:'test'},fetchFn);
  await assert.rejects(data.load(['SPY'],'2026-08-27','2026-09-01'),/session_gap/);
  assert.ok(calls.every(c=>c.opts.method==='GET'&&c.opts.redirect==='error'));
  await assert.rejects(data.get('https://example.com','/v2/calendar',{}),/read_only/);
  await assert.rejects(data.get('https://paper-api.alpaca.markets','/v2/orders',{}),/read_only/);
  data.canRead=()=>false;await assert.rejects(data.load(['SPY'],'2026-08-27','2026-09-01'),/scheduled_off/);
});

test('monthly handler is off by default, obeys session window, retains disabled exits and verifies its thesis',async()=>{
  const f=await fixture();try{
    const e=f.engine,{daily,calendar}=history();let reads=0,submissions=0;
    e.cfg.mode='paper';e.cfg.overnight.enabled=true;
    e.schedule={state:()=>({carryWindow:false}),holdingDeadline:()=>f.now()+30*86400000};
    const m=new MonthlyTrend(e,{load:async()=>{reads++;return {calendar,bars:Object.fromEntries(MONTHLY_TREND.symbols.map(s=>[s,daily]))};}});e.monthlyTrend=m;
    e.submitCandidate=async c=>{submissions++;assert.equal(m.verifiedCandidate(c,f.now()),true);};
    const b={symbol:'SPY',ts:f.now()-60000};await m.onBar(b);assert.equal(reads,0);assert.equal(e.strategyControls.enabled('monthly_trend'),false);
    e.strategyControls.state.strategies.monthly_trend.enabled=true;await m.onBar(b);assert.equal(reads,0);
    e.schedule.state=()=>({carryWindow:true});e.quotes.set('SPY',quote('SPY',f.now()));
    await m.onBar(b);assert.equal(submissions,1);await m.onBar(b);assert.equal(submissions,1);
    assert.equal(m.verifiedCandidate({strategy:'monthly_trend',symbol:'SPY',features:{trendFingerprint:'forged'}},f.now()),false);
    e.strategyControls.state.strategies.monthly_trend.enabled=false;e.managed.SPY={strategy:'monthly_trend'};m.contexts.get('SPY').long=false;
    e.scheduleReconcile=()=>{};await m.onBar(b);assert.equal(e.managed.SPY.exitReason,'monthly_trend_reversed');
  }finally{await dispose(f);}
});
test('monthly carry shares allocation, requires its own verifier and cannot borrow the news strategy verifier',async()=>{
  const f=await fixture();try{
    const e=f.engine;e.cfg.mode='paper';e.cfg.overnight.enabled=true;e.schedule={state:()=>({carryWindow:true})};e.session.open=true;
    e.desk={verifiedCandidate:()=>true};e.monthlyTrend={verifiedCandidate:()=>false};
    const c={strategy:'monthly_trend',symbol:'SPY',holdingPolicy:{type:'carry',exitBy:f.now()+86400000}};
    assert.equal(carryGuard(e,c),'carry_thesis_stale');e.monthlyTrend.verifiedCandidate=()=>true;assert.equal(carryGuard(e,c),null);
    e.store.order({id:'carry-reservation',kind:'entry',strategy:'monthly_trend',symbol:'SPY',status:'reserved',qty:10,filledQty:0,limit:100,ts:f.now(),holdingPolicy:c.holdingPolicy});
    assert.ok(overnightAllocation(e).exposure>=1000);assert.equal(carryGuard(e,c),'carry_allocation_limit');
    e.cfg.mode='live';assert.equal(carryGuard(e,c),'carry_paper_or_shadow_only');
  }finally{await dispose(f);}
});
test('calendar fetch covers twenty future sessions; eligible trend ETFs are pinned only when enabled',async()=>{
  const f=await fixture();try{
    let requested;const e=f.engine,s=new MarketSchedule(e,{calendar:async(start,end)=>{requested=end;return [{date:'2026-09-22',open:nyTimestamp('2026-09-22','09:30'),close:nyTimestamp('2026-09-22','16:00')}];}});
    await s.poll();assert.ok(Date.parse(requested)-f.now()>49*86400000);
    const u=new EquityUniverse(e);e.assets.set('IWM',{tradable:true});assert.ok(!u.pins().includes('IWM'));
    e.strategyControls.state.strategies.monthly_trend.enabled=true;assert.ok(u.pins().includes('IWM'));
  }finally{await dispose(f);}
});
