import { escape as esc, money, label } from './dashboard-format.js';
const time = t => t ? new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }) : 'not yet';
export function alternativesHtml(s) {
  const latest = s.recent ?? [], pairs = s.pairs ?? [];
  return `<div class="session-cards">
    <article><h3>Compare before execution</h3><strong>${s.enabled ? 'Shadow observations on' : 'Disabled'}</strong><p>SPY &amp; QQQ · independent bullish, bearish and options hypotheses. This comparison ledger sends no orders. <a href="#paper-routes-panel">Broker paper executions →</a></p></article>
    <article><h3>Evidence collected</h3><strong>${Number(s.totalCohorts)} decision groups</strong><p>Last capture: ${esc(time(s.lastAt))}<br>Counts cover this experiment; the latest ${Number(s.policy.maxCohorts)} groups are retained in this view. No validated winner yet.</p></article>
    <article><h3>Frozen research limits</h3><strong>${money(s.policy.risk)} per alternative</strong><p>Stock notional ≤ ${money(s.policy.maxNotional)} · maximum 30-minute horizon, plus observed exit latency. Stock stops can lose more in a gap; option expiry loss and stock stop risk are different measures.</p></article>
    </div><p class="session-warning" role="status">${esc(label(s.error ?? ''))}</p>
    <p class="muted">Long-volatility trades need a forecast of future movement versus the option premium. They remain unavailable. Jev approval is specific to a direction and structure; a long approval never approves a short or option spread.</p>
    ${latest.map(c => `<details${c === latest[0] ? ' open' : ''}><summary>${esc(c.symbol)} · ${esc(time(c.at))} · same observation, separate alternatives</summary>
      <div class="table-wrap" tabindex="0" role="region" aria-label="Trade alternatives for ${esc(c.symbol)}"><table><thead><tr><th>ALTERNATIVE</th><th>STATE / REASON</th><th>SIZE / RISK</th><th>ENTRY / EXIT</th><th>NET AFTER COSTS</th></tr></thead><tbody>${c.routes.map(r => `<tr><td>${esc(label(r.id))}</td><td>${esc(label(r.state))}${r.reason ? `<br><small>${esc(label(r.reason))}</small>` : ''}</td><td>${r.quantity == null ? '—' : `${Number(r.quantity)} ${r.kind === 'stock' ? 'shares' : 'per leg'}<br>${money(r.risk)}`}</td><td>${money(r.entry)} / ${money(r.exit)}</td><td class="${r.net < 0 ? 'negative' : ''}">${money(r.net)}</td></tr>`).join('')}</tbody></table></div></details>`).join('') || '<p class="muted">Waiting for a complete regular-session observation. No trade is forced.</p>'}
    <details><summary>Matched outcomes and missing observations</summary>
      <p class="muted">Only alternatives closed within the same decision group are paired. These are sampled hypothetical outcomes, not account returns. At least ${Number(s.policy.minimumPairs)} matched outcomes across ${Number(s.policy.minimumSessions)} sessions are required before a separate validation review; reaching these counts does not approve execution.</p>
      <div class="table-wrap" tabindex="0" role="region" aria-label="Matched alternative outcomes"><table><thead><tr><th>COMPARISON (A − B)</th><th>MATCHES / SESSIONS</th><th>NET DIFFERENCE</th></tr></thead><tbody>${pairs.map(p => `<tr><td>${esc(label(p.a))} − ${esc(label(p.b))}</td><td>${Number(p.count)} / ${Number(p.sessions)}</td><td>${money(p.netDifference)}</td></tr>`).join('') || '<tr><td colspan="3">No completed matched outcomes yet.</td></tr>'}</tbody></table></div>
      <div class="table-wrap" tabindex="0" role="region" aria-label="Alternative observation coverage"><table><thead><tr><th>ALTERNATIVE</th><th>ELIGIBLE</th><th>CLOSED</th><th>ACTIVE</th><th>UNFILLED</th><th>INCOMPLETE</th></tr></thead><tbody>${s.rows.map(r => `<tr><td>${esc(label(r.id))}</td><td>${Number(r.eligible)}</td><td>${Number(r.closed)}</td><td>${Number(r.active)}</td><td>${Number(r.unfilled)}</td><td>${Number(r.incomplete)}</td></tr>`).join('')}</tbody></table></div></details>
    <p class="muted">${esc(s.note)} Crossing bid/ask, fees and adverse slippage are included. Credit spreads here use a 30-minute horizon; their separate multi-day Options Lab results do not transfer to this experiment.</p>`;
}
export class TradeAlternativesView {
  constructor(api) {
    this.api = api; this.last = 0; this.sequence = 0;
    this.section = document.createElement('section'); this.section.className = 'panel session-research';
    this.section.id = 'trade-alternatives-panel';
    this.section.innerHTML = '<div class="panel-title"><div><span class="eyebrow">DIRECTION &amp; INSTRUMENT RESEARCH</span><h2>Trade alternatives</h2></div><span class="pill" data-alternatives-state>CONNECTING</span></div><div data-alternatives-content></div>';
    document.getElementById('session-research-panel').before(this.section);
  }
  async refresh() {
    if (Date.now() - this.last < 10000) return;
    this.last = Date.now(); const sequence = ++this.sequence;
    try { const s = await this.api('/api/trade-alternatives'); if (sequence !== this.sequence) return;
      this.section.querySelector('[data-alternatives-state]').textContent = !s.enabled ? 'OFF' : s.error ? 'OBSERVATION BLOCKED' : Date.now() - s.lastAt > 90000 ? 'WAITING FOR DATA' : 'SHADOW ONLY';
      this.section.querySelector('[data-alternatives-content]').innerHTML = alternativesHtml(s);
    } catch { if (sequence === this.sequence) this.disconnect(); }
  }
  disconnect() { this.sequence++; this.last = 0; this.section.querySelector('[data-alternatives-state]').textContent = 'STALE · DISCONNECTED'; }
  clear() { this.disconnect(); this.section.querySelector('[data-alternatives-content]').replaceChildren(); }
}
