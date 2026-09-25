import { $, money, time } from './dashboard-format.js';
import { PnlChart } from './chart.js';
export class AccountPerformanceView {
  constructor(api) {
    this.api = api; this.chart = new PnlChart($('pnl-chart'), $('pnl-tooltip')); this.clear();
    $('performance-scope').addEventListener('change', () => { this.sequence++; this.last = 0; this.chart.clear(); void this.refresh(); });
  }
  clear() { this.sequence = (this.sequence ?? 0) + 1; this.last = 0; this.scopeSet = false; this.chart.clear(); }
  setStatus(status) {
    this.status = status;
    if (!this.scopeSet) { $('performance-scope').value = status.accountPolicy === 'shared' ? 'agent' : 'account'; this.scopeSet = true; this.last = 0; }
  }
  async refresh() {
    if (Date.now() - this.last < 5000) return;
    const sequence = ++this.sequence, scope = $('performance-scope').value;
    try {
      const p = await this.api(`/api/performance?scope=${scope}`); if (sequence !== this.sequence) return;
      this.last = Date.now(); this.chart.update(p);
      $('performance-daily').textContent = p.latest.dailyPnl == null ? '—' : money(p.latest.dailyPnl);
      $('performance-open').textContent = p.latest.unrealized == null ? '—' : money(p.latest.unrealized);
      $('performance-daily').className = p.latest.dailyPnl >= 0 ? 'positive' : 'negative';
      $('performance-open').className = p.latest.unrealized >= 0 ? 'positive' : 'negative';
      $('performance-limit').textContent = p.dailyLoss == null ? 'Applies to other scope' : money(p.dailyLoss);
      $('performance-scope-label').textContent = p.scope === 'agent' ? 'AGENT PERFORMANCE · ESTIMATED' : 'ENTIRE ACCOUNT PERFORMANCE';
      $('performance-daily-label').textContent = p.scope === 'agent' ? '● Agent daily P/L' : '● Daily equity change';
      $('performance-open-label').textContent = p.scope === 'agent' ? '● Agent open P/L · before fees' : '● Open P/L · all holdings';
      $('performance-limit-label').textContent = `Daily loss ceiling · ${this.status?.limits.scope ?? 'account'} scope`;
      $('pnl-chart').setAttribute('aria-label', `${p.scope} daily change and open profit and loss over time`);
      $('performance-status').textContent = p.stale ? 'STALE ACCOUNT DATA' : p.mode === 'demo' ? 'SYNTHETIC ACCOUNT' : p.mode === 'shadow' ? 'LOCAL SIMULATED ACCOUNT' : `${p.scope === 'agent' ? 'AGENT MARK' : 'BROKER MARK'} · ${p.latest.observedAt ? time(p.latest.observedAt) : 'pending'}`;
      $('performance-status').className = `pill ${p.stale ? 'amber' : ''}`;
      $('performance-note').textContent = `${p.note} Broker reconciliation runs about every 5 seconds plus request time; this panel refreshes every 5 seconds.`;
    } catch (e) { if (sequence === this.sequence) { $('performance-status').textContent = 'DISCONNECTED'; $('performance-note').textContent = e.message; } }
  }
}
