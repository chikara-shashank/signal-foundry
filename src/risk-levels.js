import { scorecardReport } from './scorecard.js';
import { codeHash } from './strategy-manifest.js';

// EVIDENCE-GATED RISK LEVELS (docs/RISK-LEVELS.md). A strategy trades at the
// limits in .env (Level 1) until its own closed trades on the running code earn
// more; it loses the level again the moment the evidence stops holding. A
// drawdown brake over the engine's own P/L halves trade size and then stops new
// entries. RISK_LEVELS=off (the default) changes nothing anywhere.

export const RISK_LEVEL_EVALUATION_MS = 30000;

// The level a strategy's closed trades have earned. `missing` says what stands
// between it and the next one, in words the dashboard shows as they are.
export function earnedLevel(stats, policy) {
  const closed = stats?.closed ?? 0, net = stats?.net ?? 0;
  if (stats?.exceptions) return { level: 1, next: 2, missing: ['execution exceptions are unresolved'] };
  const toTwo = [];
  if (closed < policy.level2Trades) toTwo.push(`${closed}/${policy.level2Trades} closed trades`);
  if (!(net > 0)) toTwo.push('net P/L after costs is not positive');
  if (!stats?.halves?.every(x => x > 0)) toTwo.push('not profitable in both halves');
  if (toTwo.length) return { level: 1, next: 2, missing: toTwo };
  const toThree = [];
  if (closed < policy.level3Trades) toThree.push(`${closed}/${policy.level3Trades} closed trades`);
  if (!stats.thirds?.every(x => x > 0)) toThree.push('not profitable in all three thirds');
  if (!(stats.maxDrawdown <= net)) toThree.push('worst drawdown is larger than net profit');
  if (toThree.length) return { level: 2, next: 3, missing: toThree };
  return { level: 3, next: null, missing: [] };
}

export class RiskLevels {
  constructor(engine) {
    this.engine = engine; this.policy = engine.cfg.riskLevels;
    const saved = engine.store.get('riskLevels', {});
    this.state = { levels: saved.levels ?? {}, peak: saved.peak ?? null, pnl: saved.pnl ?? null, drawdownPct: saved.drawdownPct ?? 0,
      brake: saved.brake ?? 'normal', haltedAt: saved.haltedAt ?? null, resetAt: saved.resetAt ?? null };
    this.evidence = {}; this.evaluatedAt = 0;
  }
  get active() { return this.policy?.mode === 'auto'; }
  multiplier(level) { return level >= 3 ? this.policy.level3Multiplier : level === 2 ? this.policy.level2Multiplier : 1; }
  // Earned, then capped by RISK_LEVEL_MAX: the operator sets the ceiling, the evidence the rest.
  level(strategy) { return this.active ? Math.min(this.state.levels[strategy] ?? 1, this.policy.max) : 1; }
  // Portfolio caps follow the highest level in use, so a promoted strategy has room to size up.
  portfolioMultiplier() {
    if (!this.active) return 1;
    return Math.max(1, ...this.engine.strategyControls.enabledIds().map(id => this.multiplier(this.level(id))));
  }
  brakeFactor() { return !this.active || this.state.brake === 'normal' ? 1 : this.state.brake === 'halved' ? .5 : 0; }
  halted() { return this.active && this.state.brake === 'halted'; }
  // What a drawdown is measured against: the capital budget currently in force.
  budget() { return this.engine.cfg.capital * this.portfolioMultiplier(); }

  // Limits for one entry. Trade size follows the strategy's own level and the
  // brake; no single trade may risk more than RISK_MAX_ACCOUNT_RISK_PCT of equity.
  limits(strategy, account) {
    const c = this.engine.cfg;
    if (!this.active) return { risk: c.risk, maxPosition: c.maxPosition, maxGross: c.maxGross, maxGroup: c.maxGroup, capital: c.capital, level: 1, multiplier: 1, brake: 'off' };
    const level = this.level(strategy), trade = this.multiplier(level) * this.brakeFactor(), portfolio = this.portfolioMultiplier();
    const cap = account?.equity > 0 ? account.equity * this.policy.maxAccountRiskPct / 100 : Infinity;
    return { risk: Math.min(c.risk * trade, cap), maxPosition: c.maxPosition * trade, maxGross: c.maxGross * portfolio, maxGroup: c.maxGroup * portfolio,
      capital: c.capital * portfolio, level, multiplier: trade, brake: this.state.brake };
  }

  // Called from reconciliation; does its work at most every 30 seconds.
  tick(now, { unrealized, additionalRealized = 0 } = {}) {
    if (!this.active || now - this.evaluatedAt < RISK_LEVEL_EVALUATION_MS) return;
    this.evaluatedAt = now;
    const e = this.engine, report = scorecardReport(e.store.orders(), e.cfg, { codeHash, now }), levels = {}, evidence = {};
    for (const s of report.strategies) {
      const earned = earnedLevel(s, this.policy); levels[s.strategy] = earned.level;
      evidence[s.strategy] = { closed: s.closed, net: s.net, ci95: s.ci95, halves: s.halves, thirds: s.thirds, maxDrawdown: s.maxDrawdown, ...earned };
    }
    for (const id of new Set([...Object.keys(levels), ...Object.keys(this.state.levels)])) {
      const from = Math.min(this.state.levels[id] ?? 1, this.policy.max), to = Math.min(levels[id] ?? 1, this.policy.max);
      if (from !== to) e.store.event('risk_level_changed', { strategy: id, from, to, earned: levels[id] ?? 1, closed: evidence[id]?.closed ?? 0,
        net: evidence[id]?.net ?? 0, missing: evidence[id]?.missing ?? [], codeHash }, now);
    }
    this.state.levels = levels; this.evidence = evidence;
    if (Number.isFinite(unrealized) && Number.isFinite(report.realizedNetAll) && Number.isFinite(additionalRealized)) this.updateBrake(report.realizedNetAll + unrealized + additionalRealized, now);
    this.save();
  }

  // The engine's P/L (realized after fees plus open) against its own high-water mark.
  updateBrake(pnl, now) {
    const s = this.state, budget = this.budget();
    s.peak = s.peak === null ? pnl : Math.max(s.peak, pnl); s.pnl = pnl;
    s.drawdownPct = budget > 0 ? (s.peak - pnl) / budget * 100 : 0;
    // A stop holds until an operator resets it; halving lifts once the drawdown recovers.
    const next = s.brake === 'halted' || s.drawdownPct >= this.policy.haltPct ? 'halted' : s.drawdownPct >= this.policy.halvePct ? 'halved' : 'normal';
    if (next !== s.brake) {
      if (next === 'halted') s.haltedAt = now;
      this.engine.store.event('drawdown_brake', { from: s.brake, to: next, drawdownPct: s.drawdownPct, peak: s.peak, pnl, budget }, now);
      s.brake = next;
    }
  }

  // Operator reset after a stop: today's P/L becomes the new high-water mark.
  reset(now) {
    const s = this.state, from = s.brake;
    s.brake = 'normal'; s.haltedAt = null; s.resetAt = now; s.peak = s.pnl; s.drawdownPct = 0;
    this.engine.store.event('drawdown_brake_reset', { from, pnl: s.pnl }, now);
    this.evaluatedAt = 0; this.save();
  }

  save() { this.engine.store.set('riskLevels', this.state); }

  strategy(id) {
    const evidence = this.evidence[id], level = this.level(id);
    return { level, multiplier: this.multiplier(level), earned: evidence?.level ?? 1, next: level < this.policy.max ? (evidence?.next ?? level + 1) : null,
      missing: level < this.policy.max ? (evidence?.missing ?? [`0/${this.policy.level2Trades} closed trades`]) : [], closed: evidence?.closed ?? 0, net: evidence?.net ?? 0, ci95: evidence?.ci95 ?? null };
  }

  snapshot() {
    const p = this.policy ?? {}, s = this.state;
    return { mode: this.active ? 'auto' : 'off', max: p.max ?? 1, multipliers: { 1: 1, 2: p.level2Multiplier, 3: p.level3Multiplier },
      gates: { level2Trades: p.level2Trades, level3Trades: p.level3Trades }, maxAccountRiskPct: p.maxAccountRiskPct, codeHash,
      portfolioMultiplier: this.portfolioMultiplier(), evaluatedAt: this.evaluatedAt || null,
      brake: { state: this.active ? s.brake : 'off', drawdownPct: s.drawdownPct, halvePct: p.halvePct, haltPct: p.haltPct, peak: s.peak, pnl: s.pnl,
        budget: this.budget(), haltedAt: s.haltedAt, resetAt: s.resetAt },
      strategies: this.active ? Object.fromEntries(this.engine.strategyControls.enabledIds().map(id => [id, this.strategy(id)])) : {} };
  }
}
