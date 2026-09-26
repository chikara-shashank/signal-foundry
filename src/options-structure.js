export function optionLegs(position) {
  return position.legs ?? [{ side: 'long', contract: position.long }, { side: 'short', contract: position.short }];
}
export const optionStructureKey = p => optionLegs(p).map(l => `${l.side}:${l.contract.symbol}`).sort().join('|');

// One standard contract per leg, same underlying/expiry. Reject malformed tapes
// before they can turn an uncovered short into a bounded-risk position.
export function optionGeometry(p) {
  const legs = optionLegs(p), contracts = legs.map(l => l.contract);
  if (p.quantity !== 1 || ![2,4].includes(legs.length) || new Set(contracts.map(c => c?.symbol)).size !== legs.length ||
      legs.some(l => !['long','short'].includes(l.side)) || contracts.some(c => !c || c.underlying !== p.underlying || c.expiry !== p.expiry || c.multiplier !== 100 || !(c.strike > 0))) return null;
  const pair = type => {
    const own = legs.filter(l => l.contract.type === type), long = own.find(l=>l.side==='long')?.contract, short = own.find(l=>l.side==='short')?.contract;
    return own.length === 2 && long && short ? { long, short, creditWidth:type==='put'?short.strike-long.strike:long.strike-short.strike } : null;
  };
  if (legs.length === 2) {
    const x = pair(contracts[0].type);
    if (!x || (p.credit ? x.creditWidth <= 0 : x.creditWidth >= 0)) return null;
    return { width:Math.abs(x.creditWidth), count:2 };
  }
  const put=pair('put'), call=pair('call');
  if (!p.credit || !put || !call || put.creditWidth <= 0 || call.creditWidth <= 0 || put.short.strike >= call.short.strike) return null;
  return { width:Math.max(put.creditWidth,call.creditWidth), count:4 };
}
