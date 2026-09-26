import { noiseSignal, vwapSignal } from './session-signals.js';
import { validBar } from './util.js';

export const SESSION_REPLAY_POLICY = Object.freeze({ capital: 10000, maxPosition: 500, maxGross: 3000, riskPerTrade: 10, dailyLoss: 2000,
  stopBps: 150, targetBps: 500, cooldownMinutes: 5, endBufferMinutes: 5, entryBufferMinutes: 10 });

export function completeSession(day, bars) {
  const length = (day.close - day.open) / 60000;
  return Array.isArray(bars) && bars.length === length && bars.every((b, i) => validBar(b) && b.ts === day.open + i * 60000);
}

// Standalone strategy study: one long per symbol, all decisions use completed bars.
// Records zero-lot signals separately so a $500 limit cannot masquerade as no signal.
export function replaySession(day, bars, prior, strategy, { slipBps = 3, feeBps = 1, halfSpreadBps = .14, delayMinutes = 0, ...overrides } = {}) {
  if (!['noise_legacy', 'noise_area', 'vwap_trend'].includes(strategy)) throw new Error('session_replay_strategy');
  if (!completeSession(day, bars)) return { trades: [], reason: 'incomplete_session' };
  const policy = { ...SESSION_REPLAY_POLICY, ...overrides }, trades = [];
  if (strategy !== 'vwap_trend' && (prior.length !== 14 || !prior.at(-1)?.length)) return { trades, reason: 'prior_history_unavailable' };
  const friction = (slipBps + halfSpreadBps) / 10000, fee = feeBps / 10000;
  let position = null, intent = null, pv = 0, volume = 0, lastEntry = -Infinity, cash = policy.capital;
  const finish = (reference, minute, reason) => {
    const exit = reference * (1 - friction), p = position;
    const netPerShare = exit - p.entry - fee * (p.entry + exit);
    trades.push({ date: day.date, symbol: bars[0].symbol, strategy, decisionMinute: p.decisionMinute, entryMinute: p.minute, exitMinute: minute,
      entry: p.entry, exit, quantity: p.quantity, netPnl: p.quantity * netPerShare, netBps: netPerShare / p.entry * 10000,
      grossBps: (reference / p.reference - 1) * 10000, reason });
    cash += p.quantity * netPerShare;
    position = null; intent = null;
  };
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], cutoff = bars.length - policy.endBufferMinutes;
    // Scheduled session exit takes precedence over stale pending entries.
    if (i >= cutoff) { if (position) finish(b.open, i, 'session_end'); break; }
    if (intent && i >= intent.at) {
      if (intent.action === 'exit_long' && position) finish(b.open, i, 'signal');
      else if (intent.action === 'enter_long' && !position) {
        const entry = b.open * (1 + friction), stop = intent.reference * (1 - policy.stopBps / 10000), target = intent.reference * (1 + policy.targetBps / 10000);
        // Apply entry geometry before treating a gap as a fill, as the engine does.
        if (entry > stop && entry < target && Math.abs(entry / intent.reference - 1) <= .005 && cash > 0 && policy.capital - cash < policy.dailyLoss) {
          const capacity = Math.min(policy.maxPosition, policy.maxGross, Math.max(0, cash));
          const estimatedCosts = 2 * entry * (friction + fee);
          position = { reference: b.open, entry, quantity: Math.floor(Math.min(capacity / (entry * (1 + fee)), policy.riskPerTrade / (entry - stop + estimatedCosts))),
            stop, target, minute: i, decisionMinute: intent.decisionMinute };
          lastEntry = i;
        }
      }
      intent = null;
    }
    if (position) {
      if (b.low <= position.stop) finish(Math.min(b.open, position.stop), i, 'stop');
      else if (b.high >= position.target) finish(position.target, i, 'target');
    }
    pv += (b.high + b.low + b.close) / 3 * b.volume; volume += b.volume;
    const mark = i + 1;
    if (!volume || intent || mark >= cutoff || (strategy !== 'vwap_trend' && (mark % 30 || mark > bars.length - 30))) continue;
    const context = { price: b.close, vwap: pv / volume };
    let action;
    if (strategy === 'vwap_trend') action = vwapSignal(context, !!position);
    else {
      const moves = prior.filter(p => p?.[mark - 1]).map(p => Math.abs(p[mark - 1].close / p[0].open - 1));
      if (moves.length < 10) continue;
      const signal = noiseSignal({ ...context, dayOpen: bars[0].open, prevClose: prior.at(-1).at(-1).close, sigma: moves.reduce((a, x) => a + x, 0) / moves.length }, !!position);
      action = strategy === 'noise_legacy' && !position ? context.price > signal.ub ? 'enter_long' : 'hold_flat' : signal.action;
    }
    if (action === 'enter_long' && (mark >= bars.length - policy.entryBufferMinutes || mark - lastEntry < policy.cooldownMinutes)) continue;
    if (['enter_long','exit_long'].includes(action)) intent = { action, at: mark + delayMinutes, reference: b.close, decisionMinute: mark };
  }
  return { trades, reason: null };
}

export function sessionStatistics(trades, dates) {
  const sum = rows => rows.reduce((a, x) => a + x, 0), actual = trades.filter(t => t.quantity > 0);
  const daily = new Map(dates.map(d => [d, 0]));
  for (const t of actual) daily.set(t.date, (daily.get(t.date) ?? 0) + t.netPnl);
  const values = [...daily.values()], average = sum(values) / (values.length || 1);
  const sd = Math.sqrt(sum(values.map(x => (x - average) ** 2)) / Math.max(1, values.length - 1));
  let equity = 0, peak = 0, drawdown = 0;
  for (const n of values) { equity += n; peak = Math.max(peak, equity); drawdown = Math.max(drawdown, peak - equity); }
  // Circular moving-block bootstrap (5 sessions); preserves short clusters and
  // combines all intraday trades within the same sampled session.
  let seed = 20260925;
  const random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; };
  const bootstrap = [];
  if (values.length) for (let sample = 0; sample < 1000; sample++) {
    let total = 0, n = 0;
    while (n < values.length) { const start = Math.floor(random() * values.length); for (let k = 0; k < 5 && n < values.length; k++, n++) total += values[(start + k) % values.length]; }
    bootstrap.push(total / values.length);
  }
  bootstrap.sort((a, b) => a - b);
  const round = n => Number(n.toFixed(4));
  return { sessions: dates.length, signals: trades.length, trades: actual.length, zeroLotSignals: trades.length - actual.length,
    netPnl: round(sum(actual.map(t => t.netPnl))), winRate: actual.length ? round(actual.filter(t => t.netPnl > 0).length / actual.length) : null,
    dailyCloseDrawdown: round(drawdown), dailySharpe: sd ? round(average / sd * Math.sqrt(252)) : null,
    dailyMean95CI: bootstrap.length ? [round(bootstrap[25]), round(bootstrap[974])] : null,
    diagnosticAllSignalMeanNetBps: trades.length ? round(sum(trades.map(t => t.netBps)) / trades.length) : null,
    diagnosticAllSignalMeanGrossBps: trades.length ? round(sum(trades.map(t => t.grossBps)) / trades.length) : null };
}
