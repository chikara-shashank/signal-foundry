// Listed US equities only. Research model, not a broker statement reconciler.
// Snapshot checked 2026-09-24. One execution per order by default.
// Partial executions must supply aggregate sell-order totals for waiver eligibility.
export function robinhoodEquityFee({side,qty,price,date,orderTotalShares=qty,orderTotalNotional=qty*price}) {
  if(!['buy','sell'].includes(side)||!Number.isInteger(qty)||qty<1||!(price>0)||!Number.isFinite(price)) throw new Error('Invalid execution');
  if(!/^2026-\d\d-\d\d$/.test(date)||date<'2026-04-04'||date>'2026-09-24') throw new Error('Fee snapshot only covers 2026-04-04 through 2026-09-24; refresh before future use');
  if(!Number.isInteger(orderTotalShares)||orderTotalShares<qty||orderTotalNotional+1e-8<qty*price) throw new Error('Invalid order totals');
  const shares=BigInt(qty), micros=BigInt(Math.round(qty*price*1e6));
  const ceil=(n,d)=>(n+d-1n)/d;
  const rounded=(n,d)=>n<d?0n:(n+d/2n)/d;
  const sec=side==='sell'&&orderTotalNotional>500 ? ceil(micros*206n,100000000000n):0n;
  const tafRaw=rounded(shares*195n,10000n);
  const taf=side==='sell'&&orderTotalShares>50 ? (tafRaw>979n?979n:tafRaw):0n;
  const cat=rounded(shares*3n,10000n);
  return {commission:0,sec:Number(sec)/100,taf:Number(taf)/100,cat:Number(cat)/100,total:Number(sec+taf+cat)/100};
}
