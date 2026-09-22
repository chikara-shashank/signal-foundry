import { isCrypto, positive, terminal, validateQuote, nyDate } from './util.js';
import { intervalWidth } from './realtime.js';

export function performanceData(engine, scope = engine.cfg.accountPolicy === 'shared' ? 'agent' : 'account') {
  if (!['agent', 'account'].includes(scope)) throw new Error('Invalid performance scope');
  const agent = scope === 'agent';
  const now = engine.clock(), day = nyDate(now);
  const rows = engine.store.eventsOfType(agent ? 'agent_equity' : 'equity', now - 6 * 3600000, 5000)
    .filter(p => nyDate(p.ts) === day && Number.isFinite(p.dailyPnl));
  // Keep extrema in each time bucket as well as both endpoints.
  const points = [];
  const stride = Math.max(1, Math.ceil(rows.length / 150));
  for (let i = 0; i < rows.length; i += stride) {
    const group = rows.slice(i, i + stride);
    const selected = new Set([0, group.length - 1]);
    for (const field of ['dailyPnl', 'unrealized']) {
      let low = 0, high = 0;
      for (let j = 1; j < group.length; j++) { if (group[j][field] < group[low][field]) low = j; if (group[j][field] > group[high][field]) high = j; }
      selected.add(low); selected.add(high);
    }
    for (const j of [...selected].sort((a, b) => a - b)) {
      const p = group[j]; points.push({ ts: p.ts, dailyPnl: p.dailyPnl, unrealized: Number.isFinite(p.unrealized) ? p.unrealized : null });
    }
  }
  return { now, day, mode: engine.cfg.mode, scope, points, dailyLoss: (engine.cfg.accountPolicy === 'shared') === agent ? engine.dailyLossLimit : null, gapMs: engine.cfg.mode === 'demo' ? 120000 : 30000,
    latest: { dailyPnl: agent ? engine.portfolio.state.dailyPnl : engine.dailyPnl ?? null,
      unrealized: agent ? engine.portfolio.state.unrealized : engine.account ? engine.positions.reduce((sum, p) => sum + (Number.isFinite(p.unrealized) ? p.unrealized : 0), 0) : null,
      observedAt: engine.account?.ts ?? null },
    stale: (agent && !engine.portfolio.state.valid) || !engine.lastReconcile || Date.now() - engine.lastReconcile > 30000 || engine.issues.includes('broker_reconciliation_failed'),
    note: agent ? engine.portfolio.state.note + ' Open P/L is gross before exit fees. Latest six hours; missing observations remain gaps.' : `Account-wide marks, including external holdings. Daily change starts at the first equity observation on each New York date and includes cash transfers. Open P/L is unrealized P/L across all positions, not realized strategy profit. Latest six hours; gaps over ${engine.cfg.mode === 'demo' ? 'two simulation minutes' : '30 seconds'} are shown as breaks.` };
}

export function marketDiagnostics(engine) {
  const now = engine.clock(), { cfg } = engine;
  return {
    synthetic: cfg.mode === 'demo', execution: { demo: 'Local simulation', shadow: 'Local simulation on real prices', paper: 'Alpaca paper account', live: 'Alpaca real-money account' }[cfg.mode],
    dataSource: cfg.mode === 'demo' ? 'Synthetic accelerated prices' : `Alpaca ${cfg.feed.toUpperCase()} equities / ${cfg.cryptoLocation} crypto`,
    clock: engine.timebase?.status() ?? null,
    equitySession: engine.session ? { open: engine.session.open, nextClose: engine.session.close } : null,
    credentials: { alpaca: !!(cfg.key && cfg.secret), jev: !!cfg.jevKey },
    hint: cfg.mode === 'demo' ? 'MODE=demo ignores market-data keys. Set MODE=paper with paper-account keys, then recreate the container to use real prices and simulated money.' :
      cfg.mode === 'shadow' ? 'Real quotes, local simulated fills. Use paper mode to send simulated-money orders to Alpaca.' : 'Real quotes appear independently of strategy warmup. Trading still requires a qualifying setup and all risk checks.',
    symbols: cfg.symbols.map(symbol => {
      const quote = engine.quotes.get(symbol), context = engine.snapshots.get(symbol), count = engine.features.history.get(symbol)?.length ?? 0;
      const fresh = validateQuote(quote, now, cfg.maxQuoteAge), sessionOpen = isCrypto(symbol) || !!engine.session?.open;
      return { symbol, fresh, sessionOpen, quoteAgeMs: quote ? now - quote.ts : null,
        source: cfg.mode === 'demo' ? 'SYNTHETIC' : isCrypto(symbol) ? `Alpaca crypto / ${cfg.cryptoLocation}` : `Alpaca ${cfg.feed.toUpperCase()}`,
        providerTimestamp: quote?.ts ?? null,
        warm: !!context && context.trend5 != null && context.trend15 != null && now - context.bar.ts < 150000,
        bars: count, reason: !sessionOpen ? 'Equity session closed' : !quote ? 'Waiting for first quote' : !fresh ? 'Quote is stale' : !context || context.trend5 == null || context.trend15 == null ? `Warming strategy context (${count} contiguous bars)` : 'Scanning for setups' };
    }),
  };
}

export function aggregateDisplayBars(bars, minutes, now) {
  const groups = new Map(), width = minutes * 60000;
  for (const b of bars.filter(b => b.ts + 60000 <= now + 1000)) {
    const ts = Math.floor(b.ts / width) * width;
    let g = groups.get(ts);
    if (!g) { g = { ts, open: b.open, high: b.high, low: b.low, close: b.close, volume: 0, samples: 0 }; groups.set(ts, g); }
    g.high = Math.max(g.high, b.high); g.low = Math.min(g.low, b.low); g.close = b.close; g.volume += b.volume; g.samples++;
  }
  return [...groups.values()].map(b => ({ ...b, partial: b.samples < minutes || b.ts + width > now + 1000 }));
}

export function chartData(engine, symbol, interval = 1) {
  const intervalMs = intervalWidth(interval), short = intervalMs < 60000;
  if (!engine.cfg.symbols.includes(symbol) || !intervalMs) throw new Error('Invalid chart selection');
  const now = engine.clock(), raw = short ? [] : engine.store.bars(symbol, 240 * interval + interval);
  const bars = short ? engine.realtime.trades.bars(symbol, intervalMs / 1000, now) : aggregateDisplayBars(raw, interval, now).slice(-240), since = bars[0]?.ts ?? now - 14400000;
  const orders = engine.store.ordersForSymbol(symbol, 500), candidates = engine.store.candidatesForSymbol(symbol, since, 300);
  const timeline = [], markers = [];
  for (const c of candidates) {
    const item = { id: c.id, type: 'signal', ts: c.ts, price: c.reference, strategy: c.strategy, status: c.status,
      reason: c.reason ?? (c.orderId ? 'Passed allocation checks' : 'Evaluation pending'), orderId: c.orderId,
      model: c.model ? { mode: c.model.mode, pass: c.model.pass, quality: c.model.quality, coherence: c.model.coherence, regime: c.model.regime, error: c.model.error, latencyMs: c.model.latencyMs } : null };
    timeline.push(item); if (positive(item.price)) markers.push(item);
  }
  const addOrder = (o, parent) => {
    const ts = o.ts ?? o.submittedAt ?? parent?.ts;
    if (ts >= since) timeline.push({ id: `${o.id}:order`, orderId: o.id, type: 'order', ts, price: o.limit ?? null, strategy: o.strategy ?? parent?.strategy,
      side: o.side ?? (o.kind === 'entry' ? 'buy' : 'sell'), qty: o.qty, filledQty: o.filledQty, status: o.status, reason: o.reason ?? (parent ? 'Native protective order' : 'Order submitted') });
    if (o.filledQty > 0 && positive(o.fillPrice)) {
      const fillTime = o.filledAt ?? o.lastFillObservedAt ?? null;
      const item = { id: `${o.id}:fill`, orderId: o.id, type: 'fill', ts: fillTime, price: o.fillPrice,
        side: o.side ?? (o.kind === 'entry' ? 'buy' : 'sell'), qty: o.filledQty, status: o.status, strategy: o.strategy ?? parent?.strategy,
        reason: o.reason ?? (o.kind === 'entry' ? 'Entry execution' : 'Native protective execution'),
        ...(parent && positive(parent.fillPrice) ? { grossPnl: (o.fillPrice - parent.fillPrice) * o.filledQty } : {}),
        note: 'Cumulative average fill; not an individual execution print', timeSource: o.filledAt ? 'broker_or_simulator' : o.lastFillObservedAt ? 'first_reconciliation_observation' : 'unavailable' };
      if (fillTime === null || fillTime >= since) timeline.push(item);
      if (fillTime !== null && fillTime >= since) markers.push(item);
    }
  };
  const parents = new Map(orders.filter(o => o.kind === 'entry').map(o => [o.id, o]));
  for (const o of orders) { addOrder(o, parents.get(o.entryId)); for (const leg of o.legs ?? []) addOrder(leg, o); }
  const position = engine.positions.find(p => p.symbol === symbol) ?? null;
  const management = engine.externalSymbols.has(symbol) ? null : engine.managed[symbol];
  const quote = engine.quotes.get(symbol), fresh = validateQuote(quote, now, engine.cfg.maxQuoteAge);
  const positionPnl = position ? { value: fresh ? (quote.bid - position.entryPrice) * position.qty : position.unrealized,
    basis: fresh ? 'bid mark, before exit fees' : 'last broker mark', fresh,
    qty: position.qty, entryPrice: position.entryPrice, external: engine.externalSymbols.has(symbol) } : null;
  const trades = [];
  for (const entry of orders.filter(o => o.kind === 'entry' && o.filledQty > 0 && positive(o.fillPrice))) {
    const entryTs = entry.filledAt ?? entry.lastFillObservedAt;
    const exits = [...orders.filter(o => o.kind === 'exit' && o.entryId === entry.id), ...(entry.legs ?? [])];
    for (const exit of exits) {
      const exitTs = exit.filledAt ?? exit.lastFillObservedAt;
      if (entryTs && exitTs && exitTs >= entryTs && exit.filledQty > 0 && positive(exit.fillPrice)) trades.push({
        entryTs, entryPrice: entry.fillPrice, exitTs, exitPrice: exit.fillPrice, qty: exit.filledQty,
        pnl: (exit.fillPrice - entry.fillPrice) * exit.filledQty, note: 'Gross matched-fill P/L before fees' });
    }
  }
  const active = orders.filter(o => o.kind === 'entry' && !terminal(o.status));
  return { symbol, interval, intervalMs, serverMono: performance.now(), now, mode: engine.cfg.mode, bars, quote: quote ?? null,
    quoteFresh: fresh, quoteSeries: engine.quoteHistory.get(symbol) ?? [], positionPnl, trades,
    markers: markers.sort((a, b) => a.ts - b.ts).slice(-400), timeline: timeline.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0)).slice(0, 100),
    levels: [...(position ? [{ label: 'Average entry', price: position.entryPrice, kind: 'entry' }] : []),
      ...(management ? [{ label: 'Stop', price: management.stop, kind: 'stop' }, { label: 'Target', price: management.target, kind: 'target' }] : []),
      ...active.map(o => ({ label: 'Pending buy limit', price: o.limit, kind: 'pending' }))].filter(x => positive(x.price)),
    position, context: engine.snapshots.get(symbol) ?? null,
    note: short ? 'Trade-print candles from received trades, including reported sale conditions; not official Alpaca bars. Empty intervals are omitted. Forming candles are outlined. Retained in memory for at most one hour, subject to a trade-count cap; reset on reconnect or an unresolvable correction. Strategies still use provider minute bars.'
      : 'Candles use recorded completed provider minute bars. Alpaca crypto bars can include quote midpoints. Incomplete 5m/15m groups are outlined. Bid/ask lines update between closes. Fill markers show cumulative average execution prices.' };
}
