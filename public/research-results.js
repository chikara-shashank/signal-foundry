import { $, money, time, escape, label, empty } from './dashboard-format.js';
export class ResearchResultsView {
  constructor(api) { this.api = api; this.lastResearch = 0; this.sequence = 0; }
  clear() { this.sequence++; this.lastResearch = 0; }
  async refresh() {
    if (Date.now() - this.lastResearch < 10000) return;
    const sequence = ++this.sequence;
    try {
      const r = await this.api('/api/research'); if (sequence !== this.sequence) return; this.lastResearch = Date.now();
      $('research-state').textContent = `${r.mode.toUpperCase()} · ${new Date(r.now).toLocaleTimeString()}`;
      $('strategy-results').innerHTML = r.strategies.map(g => `<tr><td>${escape(label(g.strategy))}<small>${escape(g.asset)}</small></td><td>${g.closed} / ${g.partial}</td><td>${g.winRate == null ? '—' : (g.winRate*100).toFixed(1)+'%'}</td><td>${money(g.grossPnl)}</td><td>${money(g.estimatedFees)}</td><td class="${g.netPnl >= 0 ? 'positive' : 'negative'}">${money(g.netPnl)}</td><td>${g.meanNetPerClosedTrade == null ? '—' : money(g.meanNetPerClosedTrade)}</td><td>${escape(label(g.evidence))}</td></tr>`).join('') || empty(8, 'No closed or partially exited agent trades yet.');
      $('strategy-results-note').textContent = r.note;
      $('crypto-profile').textContent = `${r.mode === 'demo' ? 'Synthetic demo; provider context inactive' : 'Crypto: provider 5m context'} · ${r.crypto.state} · ${r.crypto.feePerSideBps} bps fee per side · up to ${r.crypto.maximumHoldingMs/60000}m holding horizon. Fresh quotes, spread, cost and allocation gates still apply. OFI scalping is restricted to equities.`;
      $('crypto-readiness').innerHTML = r.crypto.symbols.map(s => {
        const c = s.latestDecision, x = c?.preflight?.economics;
        return `<tr><td>${escape(s.symbol)}</td><td>${s.bars} observed 5m bars${s.coverage == null ? '' : '<small>'+(s.coverage*100).toFixed(1)+'% coverage</small>'}</td><td>${s.contextAt ? time(s.contextAt + 300000) : 'Warming up'}</td><td>${c ? escape(label(c.reason ?? c.status)) + '<small>'+time(c.ts)+'</small>' : 'No candidate yet'}</td><td>${x ? x.targetDistanceBps.toFixed(1)+' / '+x.roundTripCostBps.toFixed(1)+' bps' : 'Awaiting costed candidate'}</td><td>${x ? (x.breakEvenWinRate*100).toFixed(1)+'%' : '—'}</td></tr>`;
      }).join('') || empty(6, 'Crypto universe is empty.');
      $('jev-outcomes').innerHTML = r.outcomes.rows.map(g => `<tr><td>${escape(g.symbol)}<small>${escape(label(g.strategy))}</small></td><td>${g.modelPass ? 'Passed' : 'Declined / expired'}</td><td>${g.count} / ${g.missing}</td><td class="${g.meanNetBps >= 0 ? 'positive' : 'negative'}">${g.meanNetBps == null ? '—' : g.meanNetBps.toFixed(2)+' bps'}</td><td>${escape(g.fingerprint.slice(0,8))}</td></tr>`).join('') || empty(5, `Collecting forward observations · ${r.outcomes.pending} pending. No historical outcomes have been invented.`);
      $('jev-outcomes-note').textContent = r.outcomes.note;
    } catch { if (sequence === this.sequence) $('research-state').textContent = 'RESEARCH DATA UNAVAILABLE'; }
  }
}
