// Deliberately synthetic, deterministic market paths for functional verification.
// These prices must never be presented as evidence of a trading edge.
export function pyramidingTape(outcome='continuation') {
  const day='2026-09-22',open=Date.parse(day+'T13:30:00Z'),events=[];
  const calendar={coverageFrom:day,coverageTo:day,observedAt:open-86400000,sessions:[{date:day,open,close:open+23400000}]};
  const bar=(i,close,{high=close+1,low=close-1,volume=1000,warmup=false}={})=>{
    const ts=open+i*60000,now=ts+60000;
    events.push({kind:'quote',symbol:'SPY',now,ts:now,bid:close-.01,ask:close+.01,bidSize:10000,askSize:10000});
    events.push({kind:'bar',symbol:'SPY',ts,now:now+100,open:Math.min(close,high-.01),high,low,close,volume,warmup});
    if(!warmup)events.push({kind:'quote',symbol:'SPY',ts:now+1200,now:now+1200,bid:close-.01,ask:close+.01,bidSize:10000,askSize:10000});
  };
  for(let i=0;i<120;i++)bar(i,100+i*.01,{warmup:true});
  bar(120,102.3,{high:102.32,low:101.3,volume:2500});
  bar(121,105.5,{high:105.65,low:102.3});
  for(let i=122;i<125;i++)bar(i,105.6,{high:105.7,low:105.45,volume:700});
  bar(125,105.92,{high:105.94,low:105.6,volume:2500});
  const start=open+126*60000+2000,price=outcome==='continuation'?110:103.4;
  for(let i=0;i<6;i++)events.push({kind:'quote',symbol:'SPY',now:start+i*2000,ts:start+i*2000,bid:price-.01,ask:price+.01,bidSize:10000,askSize:10000});
  return {tape:{schema:1,source:'synthetic',quoteSizeUnits:'shares',events},calendar,
    settings:{STRATEGIES:'range_breakout',MAX_POSITION_USD:'2000',MAX_GROUP_USD:'5000',MAX_GROSS_USD:'6000',RISK_PER_TRADE_USD:'20',SYMBOL_COOLDOWN_SECONDS:'0'}};
}
