// Every fill remains a separate broker lot. A campaign joins only explicitly
// linked entries; unrelated holdings in the same ticker never become ours.
export const campaignId = entry => entry.campaignId ?? entry.id;
export const campaignEntries = (orders, rootId) => orders.filter(o => o.kind === 'entry' && campaignId(o) === rootId);
export const lotExits = (orders, entry) => [...new Map([
  ...orders.filter(o => o.kind === 'exit' && o.entryId === entry.id), ...(entry.legs ?? [])
].map(o => [o.brokerId ?? o.id, o])).values()];
export const remainingQty = (orders, entry) => (entry.filledQty ?? 0) - lotExits(orders, entry).reduce((n,o) => n + (o.filledQty ?? 0), 0);
export const campaignQty = (orders, rootId) => campaignEntries(orders, rootId).reduce((n,o) => n + remainingQty(orders,o), 0);
export const fillFee = entry => Number.isFinite(entry.fee) ? entry.fee : (entry.filledQty ?? 0) * (entry.fillPrice ?? 0) * (entry.feeRateBps ?? 0) / 10000;

export function campaignMark(orders, rootId, bid, slippageBps = 0) {
  let qty = 0, cost = 0, realized = 0, fees = 0, proceeds = 0;
  for (const entry of campaignEntries(orders, rootId)) {
    const held = remainingQty(orders,entry);
    qty += held; cost += held * (entry.fillPrice ?? 0); fees += fillFee(entry);
    for (const exit of lotExits(orders,entry)) {
      realized += (exit.filledQty ?? 0) * ((exit.fillPrice ?? 0) - (entry.fillPrice ?? 0));
      fees += Number.isFinite(exit.fee) ? exit.fee : (exit.filledQty ?? 0) * (exit.fillPrice ?? 0) * (entry.feeRateBps ?? 0) / 10000;
    }
    proceeds += held * bid * (1-slippageBps/10000) * (1-(entry.feeRateBps ?? 0)/10000);
  }
  return { qty, cost, averagePrice:qty > 0 ? cost/qty : null, net:realized+proceeds-cost-fees };
}
