import test from 'node:test';
import assert from 'node:assert/strict';
import { replayMonthlyFunded } from '../src/monthly-funded-replay.js';
import { nyTimestamp } from '../src/util.js';

function data() {
  const symbols=['SPY','QQQ','IWM'],daily=Object.fromEntries(symbols.map(s=>[s,[]])),calendar=[];
  for(let m=0;m<13;m++){const date=new Date(Date.UTC(2025,7+m,28)).toISOString().slice(0,10);calendar.push({date,open:nyTimestamp(date,'09:30'),close:nyTimestamp(date,'16:00')});for(const s of symbols)daily[s].push({date,close:80+m});}
  for(let d=1;d<=28;d++){const date=`2026-09-${String(d).padStart(2,'0')}`;calendar.push({date,open:nyTimestamp(date,'09:30'),close:nyTimestamp(date,'16:00')});}
  const bars=[];
  for(const date of ['2026-09-01','2026-09-02'])for(let i=0;i<78;i++)for(const symbol of symbols)bars.push({symbol,date,ts:nyTimestamp(date,'09:30')+i*300000,open:100,high:100.1,low:99.9,close:100});
  return {daily,calendar,bars,from:'2026-09-01',to:'2026-09-03'};
}
test('funded replay caps actual integer positions, stops first on ambiguous bars, and avoids repeated monthly entries',()=>{
  const args=data();for(const b of args.bars.filter(b=>b.ts===nyTimestamp('2026-09-01','15:30'))){b.low=97;b.high=107;}
  const r=replayMonthlyFunded(args);assert.equal(r.entries,3);assert.equal(r.closedTrades,3);assert.ok(r.netPnl<0);assert.ok(r.trades.every(t=>t.qty===3&&t.reason==='stop'));
  assert.equal(r.missingFiveMinuteBars,0);assert.ok(r.maxObservedExposureUsd<=950);
  assert.ok(replayMonthlyFunded({...args,costBps:12}).netPnl<r.netPnl);
});
test('gap stop can lose more than nominal risk and missing whole timestamps cannot disappear from quality diagnostics',()=>{
  const args=data();for(const b of args.bars.filter(b=>b.date==='2026-09-02')){b.open=80;b.high=80.1;b.low=79.9;b.close=80;}
  const r=replayMonthlyFunded(args);assert.equal(r.entries,3);assert.ok(r.trades.every(t=>t.netPnl < -10));assert.ok(r.maxObservedExposureUsd<=950);
  const missing=nyTimestamp('2026-09-01','10:00');args.bars=args.bars.filter(b=>b.ts!==missing);assert.equal(replayMonthlyFunded(args).missingFiveMinuteBars,3);
});
test('new entries wait until the closing window and a full-session calendar is required',()=>{
  const args=data();const r=replayMonthlyFunded({...args,delayBars:1});assert.ok(r.trades.every(t=>t.openedAt>=nyTimestamp('2026-09-01','15:35')));
  args.calendar=args.calendar.map(d=>({...d,close:nyTimestamp(d.date,'13:00')}));args.bars=args.bars.filter(b=>b.ts<nyTimestamp(b.date,'13:00'));
  assert.equal(replayMonthlyFunded(args).entries,0);
});
