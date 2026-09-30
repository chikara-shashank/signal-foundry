import { readFileSync } from 'node:fs';
import { hash } from './util.js';
import { ALTERNATIVES_POLICY as A, ALTERNATIVE_ROUTES } from './trade-alternatives-policy.js';
import { OPTIONS_POLICY as P } from './options-policy.js';
import { scanOptions } from './options-strategies.js';
import { spreadEconomics } from './options-pricing.js';
import { optionLegs } from './options-structure.js';

export const ALTERNATIVES_HASH = hash(['trade-alternatives', 'trade-alternatives-policy', 'options-policy', 'options-context',
  'options-strategies', 'options-condor', 'options-pricing', 'options-structure', 'options-data'].map(name =>
  readFileSync(new URL(`./${name}.js`, import.meta.url), 'utf8')));
const active = r => ['pending', 'open', 'exiting'].includes(r.state);
const finite = Number.isFinite;
const unavailable = (id, reason) => ({ id, state: 'unavailable', reason, net: null });
export const freshAlternatives = () => ({ fingerprint: ALTERNATIVES_HASH, lastAt: 0, seen: {}, cohorts: [],
  totalCohorts: 0, pairs: {}, totals: Object.fromEntries(ALTERNATIVE_ROUTES.map(id => [id, { eligible: 0, closed: 0, incomplete: 0, unfilled: 0, net: 0 }])) });
const event = (events, type, data, ts) => events.push({ type: `trade_alternatives_${type}`, data: structuredClone(data), ts });

function frameProblem(f) {
  if (f.source !== 'alpaca_opra' || f.stockFeed !== 'sip') return 'opra_and_sip_required';
  if (!finite(f.now) || !finite(f.clockUncertaintyMs) || f.clockUncertaintyMs < 0 || f.clockUncertaintyMs > 1000) return 'clock_uncertain';
  if (!f.marketOpen || !finite(f.session?.open) || !finite(f.session?.close) || f.now < f.session.open || f.now >= f.session.close) return 'session_closed';
  return null;
}
function stockQuote(q, now) {
  if (!q || ![q.bid, q.ask, q.bidSize, q.askSize, q.ts].every(finite) || q.bid <= 0 || q.ask < q.bid ||
      q.bidSize <= 0 || q.askSize <= 0 || q.ts > now || now - q.ts > P.quoteAgeMs) return null;
  return q;
}
function stockPrices(q, sign) {
  return { entry: sign === 1 ? q.ask * (1 + A.stockSlippageBps / 10000) : q.bid * (1 - A.stockSlippageBps / 10000),
    exit: sign === 1 ? q.bid * (1 - A.stockSlippageBps / 10000) : q.ask * (1 + A.stockSlippageBps / 10000) };
}
function assetProblem(asset, now, short) {
  if (!asset || !finite(asset.at) || asset.at > now || now - asset.at > A.assetAgeMs || asset.status !== 'active' || asset.tradable !== true) return 'asset_eligibility_unavailable';
  if (short && (asset.shortable !== true || asset.easyToBorrow !== true)) return 'easy_to_borrow_short_required';
  return null;
}
function stockCandidate(id, symbol, f) {
  const sign = id === 'stock_long' ? 1 : -1, c = f.contexts?.[symbol], q = stockQuote(f.spots?.[symbol], f.now);
  if (!c?.intradayReady || ![c.barEnd, c.close, c.rangeHigh, c.rangeLow, c.vwap].every(finite) ||
      c.barEnd > f.now || f.now - c.barEnd > 360000 || c.rangeHigh <= c.rangeLow) return unavailable(id, 'completed_context_unavailable');
  if (!(sign === 1 ? c.close > c.rangeHigh && c.close > c.vwap : c.close < c.rangeLow && c.close < c.vwap)) return unavailable(id, 'directional_thesis_not_confirmed');
  const problem = assetProblem(f.assets?.[symbol], f.now, sign === -1);
  if (problem) return unavailable(id, problem);
  if (!q || (q.ask - q.bid) / ((q.ask + q.bid) / 2) * 10000 > A.stockMaxSpreadBps) return unavailable(id, 'stock_quote_unavailable_or_wide');
  const mid = (q.ask + q.bid) / 2;
  if (!(sign === 1 ? mid > c.rangeHigh && mid > c.vwap : mid < c.rangeLow && mid < c.vwap)) return unavailable(id, 'directional_thesis_invalidated');
  const { entry } = stockPrices(q, sign), stop = sign === 1 ? c.rangeLow : c.rangeHigh;
  const distance = sign * (entry - stop), fee = A.stockFeeBps / 10000;
  if (!(distance > 0)) return unavailable(id, 'entry_beyond_invalidation');
  const unitRisk = distance + stop * A.stockSlippageBps / 10000 + (entry + stop) * fee;
  const quantity = Math.floor(Math.min(A.risk / unitRisk, A.maxNotional / entry, q.bidSize, q.askSize));
  if (quantity < 1) return unavailable(id, 'risk_or_size_limit');
  return { id, kind: 'stock', state: 'pending', sign, quantity, limit: entry, stop, target: entry + sign * 2 * distance,
    risk: quantity * unitRisk, riskKind: 'planned_stop_loss_not_guaranteed', net: null,
    decisionQuote: structuredClone(q), review: 'independent_direction_review_required' };
}
export function routesFor(symbol, f) {
  const only = { ...f, universe: [symbol] }, routes = [stockCandidate('stock_long', symbol, f), stockCandidate('stock_short', symbol, f)];
  for (const id of ALTERNATIVE_ROUTES.slice(2, 7)) {
    const scan = scanOptions(only, [id]), candidate = scan.candidates.find(c => c.underlying === symbol);
    if (!candidate) { routes.push({ ...unavailable(id, 'no_eligible_structure'), rejectionCounts: scan.rejected }); continue; }
    // Entry evidence must have existed by the decision timestamp, including every leg.
    if (optionLegs(candidate).some(l => f.quotes[l.contract.symbol].ts > f.now)) { routes.push(unavailable(id, 'future_leg_quote')); continue; }
    routes.push({ id, kind: 'option', state: 'pending', candidate, quantity: 1, limit: candidate.entryCost,
      risk: candidate.maxLoss, riskKind: 'bounded_expiry_payoff_plus_fees', net: null,
      decisionQuotes: Object.fromEntries(optionLegs(candidate).map(l => [l.contract.symbol, f.quotes[l.contract.symbol]])),
      review: 'independent_structure_review_required' });
  }
  routes.push(unavailable('long_volatility', 'forward_volatility_forecast_unavailable'));
  routes.push({ id: 'no_trade', state: 'baseline', net: 0, risk: 0 });
  return routes;
}
function finish(r, state, reason, cohort, f, events, extra = {}) {
  Object.assign(r, { state, reason, endedAt: f.now, ...extra });
  event(events, 'outcome', { cohort: cohort.id, route: r }, f.now);
}
function summarizeEvents(state, events) {
  for (const e of events) {
    if (e.type === 'trade_alternatives_decision') {
      state.totalCohorts++;
      for (const r of e.data.routes) if (r.kind) state.totals[r.id].eligible++;
    } else if (e.type === 'trade_alternatives_outcome') {
      const r = e.data.route, total = state.totals[r.id];
      total[r.state]++;
      if (r.state === 'closed') total.net += r.net;
    }
  }
  for (const c of state.cohorts) {
    if (c.finalized || c.routes.some(active)) continue;
    const closed = c.routes.filter(r => ['closed', 'baseline'].includes(r.state));
    for (let i = 0; i < closed.length; i++) for (const b of closed.slice(i + 1)) {
      const a = closed[i], key = `${a.id}:${b.id}`;
      const p = state.pairs[key] ??= { a: a.id, b: b.id, count: 0, dates: [], netDifference: 0 };
      p.count++; p.netDifference += a.net - b.net;
      if (!p.dates.includes(c.session)) p.dates.push(c.session);
    }
    c.finalized = true;
  }
}
function advanceRoute(r, c, f, events) {
  if (!active(r)) return;
  if (r.state === 'pending' && f.now - c.at > P.pendingTtlMs) return finish(r, 'unfilled', 'entry_limit_expired', c, f, events);
  const stock = r.kind === 'stock', q = stock ? stockQuote(f.spots?.[c.symbol], f.now) : null;
  const x = stock ? q && stockPrices(q, r.sign) : spreadEconomics(r.candidate, f.quotes, f.now, P, r.state === 'pending');
  const times = stock ? q ? [q.ts] : [] : optionLegs(r.candidate).map(l => f.quotes?.[l.contract.symbol]?.ts);
  const valid = x && !x.reason && times.length && times.every(t => finite(t) && t <= f.now);
  if (r.state === 'pending') {
    if (!valid || times.some(t => t < c.at + P.latencyMs)) return;
    const mid = stock ? (q.ask + q.bid) / 2 : null;
    if (stock && !(r.sign === 1 ? mid > c.context.rangeHigh && mid > c.context.vwap : mid < c.context.rangeLow && mid < c.context.vwap))
      return finish(r, 'unfilled', 'directional_thesis_invalidated', c, f, events);
    if (stock && (assetProblem(f.assets?.[c.symbol], f.now, r.sign === -1) || q.bidSize < r.quantity || q.askSize < r.quantity ||
        (q.ask - q.bid) / ((q.ask + q.bid) / 2) * 10000 > A.stockMaxSpreadBps)) return;
    const entry = stock ? x.entry : x.entryCost;
    if (stock ? r.sign * (entry - r.limit) > 1e-9 || r.sign * (entry - r.stop) <= 0 : entry > r.limit + 1e-9 || x.maxLoss > A.risk || x.maxLoss <= 0) return;
    Object.assign(r, { state: 'open', entry, filledAt: f.now, lastQuoteAt: f.now, entryEvidence: stock ? q : Object.fromEntries(optionLegs(r.candidate).map(l => [l.contract.symbol, f.quotes[l.contract.symbol]])) });
    event(events, 'fill', { cohort: c.id, route: r }, f.now); return;
  }
  if (f.now - r.lastQuoteAt > P.maxGapMs) return finish(r, 'incomplete', 'quote_coverage_gap', c, f, events);
  if (!valid || times.some(t => t <= r.filledAt) || (stock && (q.bidSize < r.quantity || q.askSize < r.quantity))) return;
  r.lastQuoteAt = f.now;
  if (r.state === 'open') {
    const stopHit = stock && r.sign * (x.exit - r.stop) <= 0, targetHit = stock && r.sign * (x.exit - r.target) >= 0;
    if (f.now >= c.until || stopHit || targetHit) {
      Object.assign(r, { state: 'exiting', exitAt: f.now, exitReason: stopHit ? 'stop' : targetHit ? 'target' : 'horizon' });
      event(events, 'exit_requested', { cohort: c.id, id: r.id, reason: r.exitReason }, f.now);
    }
    return;
  }
  if (times.some(t => t < r.exitAt + P.latencyMs)) return;
  const exit = stock ? x.exit : x.exitValue;
  const fees = stock ? (r.entry + exit) * r.quantity * A.stockFeeBps / 10000 : x.roundTripFees;
  const net = stock ? r.sign * (exit - r.entry) * r.quantity - fees : (exit - r.entry) * 100 - fees;
  finish(r, 'closed', r.exitReason, c, f, events, { exit, fees, net,
    exitEvidence: stock ? q : Object.fromEntries(optionLegs(r.candidate).map(l => [l.contract.symbol, f.quotes[l.contract.symbol]])) });
}

export function interruptAlternatives(state, reason, now, events = []) {
  for (const c of state.cohorts) for (const r of c.routes) if (active(r)) finish(r, 'incomplete', reason, c, { now }, events);
  return events;
}
export function advanceAlternatives(state, f, allowNew = true, interrupted = false) {
  const events = [], problem = frameProblem(f);
  if (interrupted) interruptAlternatives(state, 'process_restarted', f.now, events);
  if (problem || f.now < state.lastAt || (state.lastAt && f.now - state.lastAt > P.maxGapMs))
    interruptAlternatives(state, problem ?? (f.now < state.lastAt ? 'clock_reversed' : 'capture_gap'), finite(f.now) ? f.now : state.lastAt, events);
  if (problem || f.now < state.lastAt) { summarizeEvents(state, events); return events; }
  for (const c of state.cohorts) for (const r of c.routes) {
    if (!allowNew && r.state === 'pending') finish(r, 'unfilled', 'new_observations_paused', c, f, events);
    else advanceRoute(r, c, f, events);
  }
  if (allowNew && f.now >= f.session.open + 35 * 60000 && f.now + A.horizonMs + P.pendingTtlMs + P.maxGapMs < f.session.close - A.closeBufferMs) {
    for (const symbol of f.universe.filter(s => ['SPY', 'QQQ'].includes(s))) {
      const bar = f.contexts?.[symbol]?.barEnd;
      if (!finite(bar) || bar > f.now || f.now - bar > 360000 || state.seen[symbol] >= bar || state.cohorts.some(c => c.symbol === symbol && c.routes.some(active))) continue;
      state.seen[symbol] = bar;
      const c = { id: hash([state.fingerprint, symbol, f.session.date, bar]), symbol, session: f.session.date,
        at: f.now, until: f.now + A.horizonMs, context: structuredClone(f.contexts[symbol]), asset: f.assets?.[symbol] ?? null,
        routes: routesFor(symbol, f) };
      state.cohorts.push(c); event(events, 'decision', c, f.now);
    }
  }
  state.lastAt = f.now;
  summarizeEvents(state, events);
  state.cohorts = state.cohorts.slice(-A.maxCohorts);
  return events;
}

export function alternativesSummary(state) {
  const rows = ALTERNATIVE_ROUTES.map(id => {
    const total = state.totals[id];
    return { id, ...total, active: state.cohorts.filter(c => c.routes.some(r => r.id === id && active(r))).length,
      net: total.closed || id === 'no_trade' ? total.net : null };
  });
  const pairs = Object.values(state.pairs).map(({ dates, ...p }) => ({ ...p, sessions: dates.length }));
  return { rows, pairs, totalCohorts: state.totalCohorts, retainedCohorts: state.cohorts.length, recent: state.cohorts.slice(-8).reverse() };
}

// This observer has no reference to a broker or order-submission method.
export class TradeAlternatives {
  constructor(cfg, store) {
    this.store = store; this.active = cfg.tradeAlternatives === 'shadow' && ['paper', 'shadow'].includes(cfg.mode);
    this.key = `tradeAlternatives:${ALTERNATIVES_HASH}`;
    this.state = store.get(this.key, freshAlternatives()); this.error = null;
    this.restartPending = this.state.cohorts.some(c => c.routes.some(active));
  }
  watched() { return this.state.cohorts.flatMap(c => c.routes.filter(r => active(r) && r.kind === 'option').flatMap(r => optionLegs(r.candidate).map(l => l.contract))); }
  observe(frame, allowNew = true) {
    if (!this.active) return;
    const next = structuredClone(this.state), events = advanceAlternatives(next, frame, allowNew, this.restartPending);
    this.store.transaction(() => {
      this.store.set(this.key, next);
      // Keep durable cohort evidence outside the rolling dashboard and prunable event feed.
      const changed = new Set(events.map(e => e.data.cohort ?? e.data.id));
      for (const c of next.cohorts) if (changed.has(c.id)) this.store.set(`${this.key}:cohort:${c.id}`, c);
      for (const e of events) this.store.event(e.type, { fingerprint: ALTERNATIVES_HASH, ...e.data }, e.ts);
    });
    this.state = next; this.restartPending = false; this.error = frameProblem(frame);
  }
  snapshot() {
    return { enabled: this.active, mode: 'shadow', fingerprint: ALTERNATIVES_HASH, executionEnabled: false,
      validatedWinner: null, error: this.restartPending ? 'process_restarted_results_pending_invalidation' : this.error,
      lastAt: this.state.lastAt, policy: A, ...alternativesSummary(this.state),
      note: 'Prospective, sampled comparisons; no automatic promotion. Route totals use different samples: compare matched cohorts only. Stock stop risk can be exceeded by gaps. Options marks do not establish atomic fills or assignment protection. Jev approval is not reused across directions or instruments.' };
  }
}
