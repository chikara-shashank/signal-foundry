import { escape as esc, money, label } from './dashboard-format.js';
export function paperRoutesHtml(s) {
  return `<div class="session-cards"><article><h3>Broker paper orders</h3><strong>${s.enabled ? 'Enabled' : 'New entries off'}</strong><p>SPY / QQQ stock shorts and call / put debit spreads. One active route at a time.</p></article>
    <article><h3>Small initial allocation</h3><strong>${money(s.policy.maxRisk)} planned risk</strong><p>Short stock ≤ ${money(s.policy.shortNotional)} notional. Options: one contract per leg. Stops can lose more in a gap.</p></article>
    <article><h3>Route P/L today</h3><strong>${money(s.stats.dailyPnl)}</strong><p>Route loss ceiling ${money(s.policy.dailyLoss)}; shared portfolio limits also apply. Fees are estimated until broker activities reconcile.</p></article></div>
    <p class="session-warning" role="status">${s.stats.valid ? 'Positions reconciled' : 'Entries blocked: order or position reconciliation required'}${s.stats.conflicts.length ? ' · ' + esc(s.stats.conflicts.join(', ')) : ''}</p>
    <p>Latest decision: ${esc(label(s.entryGate ?? s.lastDecision?.reason ?? 'awaiting capture'))}${s.lastDecision?.symbol ? ' · ' + esc(s.lastDecision.symbol) : ''}</p>
    <div class="table-wrap" tabindex="0" role="region" aria-label="Paper short and spread executions"><table><thead><tr><th>UNDERLYING / ROUTE</th><th>STATE</th><th>SIZE / RISK</th><th>NET P/L</th><th>ORDERS / REASON</th></tr></thead><tbody>${s.trades.map(t => `<tr><td>${esc(t.symbol)}<br>${esc(label(t.route))}</td><td>${t.closedAt ? 'Closed' : t.exitReason ? 'Exit requested' : 'Open / pending'}</td><td>${Number(t.qty)} ${t.candidate ? 'per leg' : 'shares'}<br>${money(t.risk)}</td><td>${money(t.net)}</td><td>${t.orders.map(o => `${esc(label(o.kind))}: ${esc(label(o.status))}`).join('<br>')}<br>${esc(label(t.incident ?? t.exitReason ?? ''))}</td></tr>`).join('') || '<tr><td colspan="5">Waiting for a qualifying directional setup, fresh quotes and available allocation.</td></tr>'}</tbody></table></div>
    <p class="muted">${esc(s.note)} Entries expire after 20 seconds. Maximum holding time: 30 minutes; exits begin at least 10 minutes before the close. Global Pause cancels pending entries; Flatten requests closes for owned route positions after reconciliation.</p>`;
}
export class PaperRoutesView {
  constructor(api) {
    this.api = api; this.last = 0; this.sequence = 0; this.data = null; this.saving = false;
    this.section = document.createElement('section'); this.section.id = 'paper-routes-panel'; this.section.className = 'panel session-research';
    this.section.innerHTML = '<div class="panel-title"><div><span class="eyebrow">PAPER EXECUTION</span><h2>Shorts &amp; debit spreads</h2></div><button type="button" data-route-toggle disabled>Connecting</button></div><p data-route-message role="status"></p><div data-route-content></div>';
    document.getElementById('strategy-controls-panel').before(this.section);
    this.section.querySelector('[data-route-toggle]').addEventListener('click', () => void this.toggle());
  }
  render(s) {
    this.data = s; const button = this.section.querySelector('[data-route-toggle]');
    button.textContent = s.enabled ? 'Disable new paper entries' : 'Enable paper shorts & spreads'; button.disabled = this.saving || !s.available;
    this.section.querySelector('[data-route-content]').innerHTML = paperRoutesHtml(s);
  }
  async refresh() {
    if (Date.now() - this.last < 10000 || this.saving) return; this.last = Date.now(); const sequence = ++this.sequence;
    try { const data = await this.api('/api/paper-routes'); if (sequence === this.sequence) this.render(data); }
    catch { if (sequence === this.sequence) this.disconnect(); }
  }
  async toggle() {
    if (!this.data || this.saving) return; this.saving = true; const sequence = ++this.sequence; this.render(this.data);
    try { const data = await this.api('/api/paper-routes', { enabled: !this.data.enabled, expectedRevision: this.data.revision });
      if (sequence === this.sequence) { this.render(data); this.section.querySelector('[data-route-message]').textContent = data.enabled ? 'Paper entries enabled. All entry checks still apply.' : 'New entries disabled; owned exits remain managed.'; }
    } catch (e) { if (sequence === this.sequence) this.section.querySelector('[data-route-message]').textContent = e.message; }
    finally { this.saving = false; if (sequence === this.sequence && this.data) this.render(this.data); }
  }
  disconnect() { this.sequence++; this.last = 0; this.data = null; this.section.querySelector('[data-route-toggle]').disabled = true; this.section.querySelector('[data-route-message]').textContent = 'Disconnected; displayed execution data may be stale.'; }
  clear() { this.disconnect(); this.section.querySelector('[data-route-content]').replaceChildren(); }
}
