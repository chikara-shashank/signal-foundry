import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Published index history is contextual evidence, never a backtest of our verticals.
const directory = 'data/research/benchmarks'; mkdirSync(directory, { recursive: true });
const output = { asOf: '2026-09-25', kind: 'published_options_index_history_analysis', liveEligible: false, sources: [], results: [],
  limitations: ['PUT/BXM/CNDR are SPX collateralized benchmark indexes, not our SPY/QQQ American ETF spreads. CNDR uses 5-delta hedges and Treasury collateral; our narrower wings and earlier exits differ.',
    'Index-level history does not establish investor fills, net brokerage costs, taxes, capital feasibility or assignment handling.',
    'No extra trading fee or cash-interest adjustment is imposed on the published index levels; Sharpe uses zero risk-free rate.',
    'These descriptive windows were chosen after reviewing literature and are not a frozen strategy validation.'] };
for (const symbol of ['PUT','BXM','CNDR']) {
  const file = `${directory}/${symbol}.csv`, url = `https://cdn-api.cboe.com/api/global/us_indices/daily_prices/${symbol}_History.csv`;
  if (!existsSync(file)) {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Cboe index download failed: ' + response.status);
    writeFileSync(file, await response.text());
  }
  const text = readFileSync(file, 'utf8');
  if (!text.startsWith('DATE,' + symbol)) throw new Error('Unexpected index CSV schema');
  const rows = text.trim().split(/\r?\n/).slice(1).map(line => {
    const [date, price] = line.split(','), [month, day, year] = date.split('/');
    return { date: `${year}-${month.padStart(2,'0')}-${day.padStart(2,'0')}`, price: Number(price) };
  }).filter(x => x.date >= '2016-01-01' && x.date <= output.asOf).sort((a,b)=>a.date.localeCompare(b.date));
  if (rows.some((x,i)=>!Number.isFinite(x.price)||x.price<=0||(i&&x.date===rows[i-1].date))) throw new Error('Invalid index history');
  output.sources.push({ symbol, url, sha256: createHash('sha256').update(text).digest('hex'), observations: rows.length });
  for (const [window, from, to] of [['full','2016','2027'],['development','2016','2024'],['retrospective_validation','2024','2026'],['final_2026','2026','2027']]) {
    const own = rows.filter(r=>r.date>=from&&r.date<to), returns = own.slice(1).map((x,i)=>x.price/own[i].price-1);
    const mean = returns.reduce((a,x)=>a+x,0)/returns.length;
    const sd = Math.sqrt(returns.reduce((a,x)=>a+(x-mean)**2,0)/(returns.length-1));
    let peak=own[0].price, drawdown=0; for (const r of own) {peak=Math.max(peak,r.price);drawdown=Math.max(drawdown,1-r.price/peak);}
    const years=(Date.parse(own.at(-1).date)-Date.parse(own[0].date))/86400000/365.25;
    output.results.push({symbol,window,first:own[0].date,last:own.at(-1).date,observations:own.length,
      totalReturnPct:100*(own.at(-1).price/own[0].price-1),annualizedReturnPct:100*((own.at(-1).price/own[0].price)**(1/years)-1),
      volatilityPct:100*sd*Math.sqrt(252),zeroRateSharpe:mean/sd*Math.sqrt(252),dailyCloseMaxDrawdownPct:100*drawdown,
      gapsOverSevenCalendarDays:own.slice(1).filter((x,i)=>Date.parse(x.date)-Date.parse(own[i].date)>7*86400000).length});
  }
}
writeFileSync('docs/research/options-benchmarks-round2-2026-09-25.json', JSON.stringify(output,null,2));
console.log(JSON.stringify(output.results.filter(r=>r.window==='full'||r.window==='final_2026'),null,2));
