// Artificial observations for execution invariants only; never market evidence.
export function momentumFixture(){
  const open=Date.parse('2026-09-24T13:30:00Z'),start=open-330*60000;
  const fact=(value,time=start)=>({value,effectiveAt:time,availableAt:time});
  const facts={listing:fact('US_LISTED_COMMON'),tradable:fact(true),float:fact(1000000),previousClose:fact(3.5,start-86400000),volumeBaseline:{...fact(100000,start-86400000),sessions:30,lastSession:'2026-09-23'},news:{...fact(null),classification:'issuer_or_sec_material',sourceUrl:'https://example.invalid/synthetic-fixture'},splitBasisVerified:true,tickSize:fact(.01)};
  const events=[{kind:'session',now:start,date:'2026-09-24',nextDate:'2026-09-25',open,close:open+390*60000,coverageFrom:start,coverageComplete:true,completeUniverse:true,source:'synthetic'},
    {kind:'metadata',symbol:'TEST',now:start,facts:structuredClone(facts)},{kind:'halt',symbol:'TEST',now:start,active:false}];
  let id=0;const trade=(ts,price,size)=>events.push({kind:'trade',symbol:'TEST',now:ts,ts,price,size,id:String(++id),eligible:true});
  trade(start,3.9,600000);
  const bars=[[4,4.1,4,4.05],[4.05,4.1,4.02,4.06],[4.06,4.12,4.02,4.08],[4.08,4.12,4.04,4.1],[4.1,4.15,4.05,4.1],[4.1,4.5,4.1,4.48],[4.4,4.4,4.3,4.38]];
  bars.forEach((b,i)=>{
    const t=open+i*60000;events.push({kind:'metadata',symbol:'TEST',now:t,facts:{tradable:fact(true,t)}});
    b.forEach((price,j)=>trade(t+[0,15000,30000,59000][j],price,i===5?10000:100));
  });
  const signal=open+7*60000;
  events.push({kind:'metadata',symbol:'TEST',now:signal-20,facts:{tradable:fact(true,signal-20)}});
  const q=(ts,bid,ask)=>events.push({kind:'quote',symbol:'TEST',now:ts,ts,bid,ask,bidSize:10000,askSize:10000,eligible:true});
  q(signal-10,4.44,4.45);trade(signal,4.45,500);q(signal+1000,4.44,4.45);q(signal+2000,4.8,4.81);q(signal+3000,4.78,4.79);
  events.push({kind:'tick',now:signal+10000});
  return events.sort((a,b)=>a.now-b.now);
}
