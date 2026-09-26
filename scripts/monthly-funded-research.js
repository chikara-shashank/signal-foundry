import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {DailyHistory} from '../src/daily-history.js';
import {replayMonthlyFunded} from '../src/monthly-funded-replay.js';
import {hash,nyDate,nyTimestamp} from '../src/util.js';

const directory='data/research/monthly',symbols=['SPY','QQQ','IWM'];mkdirSync(directory,{recursive:true});
const source=new DailyHistory({key:process.env.ALPACA_KEY,secret:process.env.ALPACA_SECRET});
const daily=JSON.parse(readFileSync(`${directory}/all-2016-01-01-2026-09-25.json`,'utf8'));
const calendarFile=`${directory}/calendar-through-2026-11-14.json`;
if(!existsSync(calendarFile))writeFileSync(calendarFile,JSON.stringify(await source.get('https://paper-api.alpaca.markets','/v2/calendar',{start:'2016-01-01',end:'2026-11-14'})));
const calendar=JSON.parse(readFileSync(calendarFile,'utf8')).map(d=>({date:d.date,open:nyTimestamp(d.date,d.open),close:nyTimestamp(d.date,d.close)}));
const sessions=new Map(calendar.map(d=>[d.date,d])),bars=[],sources=[];
for(let year=2017;year<=2026;year++) {
  const file=`${directory}/raw-5min-${year}.json.gz`,start=year===2017?'2017-02-01':`${year}-01-01`,end=year===2026?'2026-09-25':`${year+1}-01-01`;
  if(!existsSync(file)) {
    let token;const rows=[],seenTokens=new Set();
    for(let page=0;page<120;page++) {
      const data=await source.get('https://data.alpaca.markets','/v2/stocks/bars',{symbols:symbols.join(','),timeframe:'5Min',feed:'sip',adjustment:'raw',start:new Date(nyTimestamp(start,'00:00')).toISOString(),end:new Date(nyTimestamp(end,'00:00')-1).toISOString(),limit:'10000',sort:'asc',...(token?{page_token:token}:{})});
      for(const[s,values]of Object.entries(data.bars??{}))for(const b of values){const ts=Date.parse(b.t),d=nyDate(ts),session=sessions.get(d);if(session&&ts>=session.open&&ts+300000<=session.close)rows.push([s,ts,b.o,b.h,b.l,b.c]);}
      token=data.next_page_token;if(!token)break;
      if(seenTokens.has(token))throw new Error('funded_history_pagination_cycle');seenTokens.add(token);
      if(page%20===19)console.log(JSON.stringify({year,page:page+1,regularBars:rows.length,lastReceived:Object.values(data.bars??{}).flat().at(-1)?.t}));
    }
    if(token)throw new Error('funded_history_truncated');writeFileSync(file,gzipSync(JSON.stringify(rows)));console.log(JSON.stringify({year,bars:rows.length}));
  }
  const data=readFileSync(file);sources.push({file,sha256:createHash('sha256').update(data).digest('hex')});
  bars.push(...JSON.parse(gunzipSync(data)).map(([symbol,ts,open,high,low,close])=>({symbol,ts,date:nyDate(ts),open,high,low,close})));
}
const keys=new Set();for(const b of bars){const key=b.symbol+':'+b.ts;if(keys.has(key)||![b.open,b.high,b.low,b.close].every(x=>Number.isFinite(x)&&x>0)||b.low>Math.min(b.open,b.close)||b.high<Math.max(b.open,b.close))throw new Error('funded_history_invalid');keys.add(key);}
const report={asOf:'2026-09-25',kind:'isolated_funded_monthly_sleeve_five_minute_approximation',liveEligible:false,protocol:'docs/RESEARCH-PROTOCOL-ROUND2.md',sources,bars:bars.length,
  codeHash:hash(['monthly-funded-research.js','../src/monthly-funded-replay.js','../src/monthly-trend.js','../src/util.js','../src/daily-history.js','../src/broker-budget.js'].map(n=>[n,readFileSync(new URL(n,import.meta.url),'utf8').replaceAll('\r\n','\n')])),
  limitations:['Trade-bar execution approximation, not historical bid/ask replay or actual broker fills. Gap stops may exceed the nominal $10 budget.',
    'Isolated sleeve assumes no external reservations or competing strategies. Fixed simultaneous symbol priority; real event order may differ.',
    'Five-minute ranges miss path ordering, quote spreads, fills, gaps in data and intrabar equity drawdown. Missing observations are counted, never interpolated.',
    'Raw-price replay excludes cash dividends, tax and financing; corporate-action reconciliation is not modeled. These three ETFs have no detected large split discontinuities in this window; inspect provider changes before reuse.',
    'No untouched holdout; all results remain retrospective and unqualified. End-of-study liquidations are explicitly identified.'],results:[]};
for(const[scenario,costBps,delayBars]of[['base',4,0],['cost_stress',12,0],['delay_stress',4,1]])for(const[window,from,to]of[['full','2017-02-01','2027'],['development','2017-02-01','2024'],['retrospective_validation','2024','2026'],['retrospective_final','2026','2027']]) {
  const {daily:curve,trades,...result}=replayMonthlyFunded({bars,daily:daily.bars,calendar,from,to,costBps,delayBars});
  report.results.push({window,scenario,costBps,delayBars,...result,bySymbol:Object.fromEntries(symbols.map(s=>[s,{closed:trades.filter(t=>t.symbol===s).length,netPnl:trades.filter(t=>t.symbol===s).reduce((n,t)=>n+t.netPnl,0)}])),exitReasons:trades.reduce((n,t)=>(n[t.reason]=(n[t.reason]??0)+1,n),{})});
  if(window==='full'&&scenario==='base')writeFileSync(`${directory}/funded-base-path.json`,JSON.stringify({curve,trades}));
}
writeFileSync('docs/research/monthly-funded-round2-2026-09-25.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report.results,null,2));
