import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { DailyHistory } from '../src/daily-history.js';
import { replayMonthly } from '../src/monthly-replay.js';
import { hash } from '../src/util.js';

const symbols=['SPY','QQQ','IWM'], start='2016-01-01', end='2026-09-25', directory='data/research/monthly';
mkdirSync(directory,{recursive:true});
const source=new DailyHistory({key:process.env.ALPACA_KEY,secret:process.env.ALPACA_SECRET});
const datasets={};
for(const adjustment of ['all','raw']) {
  const file=`${directory}/${adjustment}-${start}-${end}.json`;
  if(!existsSync(file)) {
    if(!process.env.ALPACA_KEY||!process.env.ALPACA_SECRET)throw new Error('Alpaca credentials required for initial read-only download');
    writeFileSync(file,JSON.stringify(await source.load(symbols,start,end,adjustment)));
  }
  datasets[adjustment]=JSON.parse(readFileSync(file,'utf8'));
}
if(hash(datasets.all.calendar)!==hash(datasets.raw.calendar))throw new Error('Daily datasets have different sessions');
const report={asOf:'2026-09-25',protocol:'docs/RESEARCH-PROTOCOL-ROUND2.md',kind:'normalized_monthly_signal_research',liveEligible:false,
  sourceHashes:Object.fromEntries(Object.entries(datasets).map(([k,v])=>[k,hash(v)])),codeHash:hash(['monthly-research.js','../src/monthly-replay.js','../src/monthly-trend.js','../src/daily-history.js','../src/util.js','../src/broker-budget.js'].map(n=>[n,readFileSync(new URL(n,import.meta.url),'utf8').replaceAll('\r\n','\n')])),
  observations:Object.fromEntries(symbols.map(s=>[s,datasets.all.bars[s].length])),results:[],
  limitations:['Alpaca adjusted daily returns are a total-return proxy, not a corporate-action cash ledger. Cash earns zero; taxes and financing excluded.',
    'Next-open execution differs from the published same-close rule and the installed 15:30–15:55 paper handler.',
    'Normalized fractional units do not apply lot, stop, target, overnight allocation, ownership or portfolio risk constraints. Lot feasibility is not a funded strategy backtest.',
    'The $950 initial-sleeve illustration is arithmetic scaling, not a rebalanced or cap-compliant portfolio; gains may increase exposure above its initial fraction.',
    'All periods are retrospective; there is no untouched historical holdout. Three fixed surviving ETFs do not establish a whole-stock-universe effect.',
    'The installed paper adaptation adds 2% stop, 6% target, 20-session deadline and once-per-month entries. Its P/L is not established by this report.']};
for(const symbol of symbols)for(const model of ['sma10','momentum12','buy_hold'])for(const [scenario,costBps,delaySessions]of[['base',4,0],['cost_stress',12,0],['delay_stress',4,1]])for(const[window,from,to]of[['full','2017-02-01','2027'],['development','2017-02-01','2024'],['retrospective_validation','2024','2026'],['retrospective_final','2026','2027']]) {
  const {equity,...result}=replayMonthly({adjusted:datasets.all.bars[symbol],raw:datasets.raw.bars[symbol],calendar:datasets.all.calendar,from,to,model,costBps,delaySessions});
  report.results.push({symbol,model,scenario,costBps,delaySessions,window,...result});
  if(window==='full'&&scenario==='base')writeFileSync(`${directory}/${symbol}-${model}-equity.json`,JSON.stringify(equity));
}
writeFileSync('docs/research/monthly-round2-2026-09-25.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report.results.filter(r=>r.scenario==='base'&&['full','retrospective_final'].includes(r.window)).map(({symbol,model,window,netReturnPct,cagrPct,dailyCloseMaxDrawdownPct,roundTrips,lotFeasibilityOnly})=>({symbol,model,window,netReturnPct,cagrPct,dailyCloseMaxDrawdownPct,roundTrips,lotFeasibilityOnly})),null,2));
