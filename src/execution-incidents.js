import { hash, terminal } from './util.js';
import { campaignEntries, remainingQty } from './position-book.js';

export function executionExceptions(orders) {
  const rows = [];
  for (const entry of orders.filter(o => o.kind === 'entry')) {
    const exits = [...new Map([...orders.filter(o => o.kind === 'exit' && o.entryId === entry.id), ...(entry.legs ?? [])].map(o => [o.brokerId ?? o.id, o])).values()];
    const exited = exits.reduce((s, o) => s + (o.filledQty ?? 0), 0);
    const reason = entry.replacedBy || exits.some(o => o.replacedBy) ? 'broker_order_replaced' : exited > (entry.filledQty ?? 0) + 1e-8 ? 'native_exit_overfill' : null;
    if (reason) rows.push({ reason, entryId: entry.id, symbol: entry.symbol, strategy: entry.strategy,
      filledQty: entry.filledQty, exitedQty: exited, expectedSignedQty: (entry.filledQty ?? 0) - exited,
      knownCashFlow: exits.reduce((s, o) => s + (o.filledQty ?? 0) * (o.fillPrice ?? 0), 0) - (entry.filledQty ?? 0) * (entry.fillPrice ?? 0),
      pnl: null, state: 'unresolved', note: 'Cash flow is not profit. Reconcile signed exposure and all broker activities before recovery.' });
  }
  return rows;
}

export function updateIncidents(engine, book, orders, positions, now) {
  const saved = engine.store.get('executionIncidents', {}), active = executionExceptions(orders);
  for (const symbol of book.conflicts) if (!active.some(x => x.symbol === symbol)) active.push({ reason: 'managed_quantity_mismatch', symbol,
    entryId: engine.managed[symbol]?.entryId, strategy: engine.managed[symbol]?.strategy, pnl: null, state: 'unresolved' });
  const seen = new Set();
  for (const incident of active) {
    const id = hash([incident.reason, incident.entryId, incident.symbol]); seen.add(id);
    const before = saved[id];
    saved[id] = { ...before, ...incident, id, firstSeen: before?.firstSeen ?? now, lastSeen: now, resolvedAt: null,
      brokerSignedQty: positions.find(p => p.symbol === incident.symbol)?.qty ?? 0,
      recovery: 'Pause new entries; verify broker fills, activities and signed quantity; cancel remaining owned orders; resolve with a documented ownership review. Ordinary flatten excludes conflicted positions.' };
    if (!before || before.resolvedAt) engine.store.event('execution_incident', saved[id], now);
  }
  for (const [id, incident] of Object.entries(saved)) if (!seen.has(id) && !incident.resolvedAt) {
    incident.resolvedAt = now; incident.state = 'cleared_by_reconciliation'; engine.store.event('execution_incident_cleared', { id, symbol: incident.symbol }, now);
  }
  engine.store.set('executionIncidents', saved);
  return Object.values(saved).sort((a,b) => b.lastSeen - a.lastSeen);
}

export function protectionHealth(engine) {
  const now = Date.now(), stale = !engine.protection.observedAt || now - engine.protection.observedAt > 30000;
  const orders = new Map(engine.store.orders().map(o => [o.id,o]));
  const positions = Object.entries(engine.managed).map(([symbol, m]) => {
    const lots=campaignEntries([...orders.values()],m.entryId).filter(o=>remainingQty([...orders.values()],o)>1e-8);
    const native = lots.length>0 && lots.every(o=>o.legs?.some(l => ['stop','stop_limit'].includes(l.type) && !terminal(l.status) && !['held','pending_new'].includes(l.status)));
    return { symbol, entryId: m.entryId, exitReason: m.exitReason ?? null,
      protection: engine.externalSymbols.has(symbol) ? 'ownership_incident' : native ? 'broker_stop' : 'software_only' };
  });
  const incidents = Object.values(engine.store.get('executionIncidents', {})).filter(x => !x.resolvedAt);
  return { ...engine.protection, stale, healthy: !stale && engine.protection.state === 'reconciled' && !incidents.length,
    positions, incidents, alertConfigured: !!engine.cfg.heartbeatUrl };
}
