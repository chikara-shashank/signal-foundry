import { $ } from './dashboard-format.js';
const money = n => n === null ? 'Unavailable' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export class OptionsLabView {
  constructor(api) {
    this.api = api; this.rows = new Map(); this.epoch = 0; this.last = 0; this.data = null; this.saving = false; this.loading = false;
    $('options-restart').addEventListener('click', () => void this.restart());
    $('options-rows').addEventListener('change', event => { if (event.target.dataset.strategy) void this.save(event.target.dataset.strategy, event.target.checked); });
  }
  clear() { this.epoch++; this.last = 0; this.data = null; this.saving = false; this.loading = false; this.rows.clear(); $('options-rows').replaceChildren(); $('options-message').textContent = ''; $('options-restart').hidden = true; }
  lock() { for (const row of this.rows.values()) row.input.disabled = true; $('options-restart').disabled = true; }
  async refresh() {
    if (this.loading || this.saving || Date.now() - this.last < 10000) return;
    this.loading = true; const epoch = this.epoch;
    try {
      const data = await this.api('/api/options');
      if (epoch !== this.epoch || this.saving) return;
      this.data = data; this.last = Date.now(); this.render();
    } catch (error) { if (epoch === this.epoch) { $('options-message').textContent = error.message; this.lock(); } }
    finally { if (epoch === this.epoch) this.loading = false; }
  }
  async save(strategy, enabled) {
    if (!this.data || this.saving) return;
    this.saving = true; this.loading = false; const epoch = ++this.epoch; this.lock();
    $('options-message').textContent = 'Saving shadow strategy selection…';
    try {
      const data = await this.api('/api/options-settings', { strategy, enabled, expectedRevision: this.data.revision });
      if (epoch !== this.epoch) return;
      this.data = data; $('options-message').textContent = enabled ? 'Enabled for hypothetical entries. No orders are sent to Alpaca.' : 'New hypothetical entries disabled. Existing shadow positions retain exit management.';
    } catch (error) {
      if (epoch !== this.epoch) return;
      $('options-message').textContent = error.message;
      try { const data = await this.api('/api/options'); if (epoch === this.epoch) this.data = data; }
      catch { if (epoch === this.epoch) { this.data = null; $('options-message').textContent += ' Save outcome unknown; reconnect to verify.'; } }
    } finally { if (epoch === this.epoch) { this.saving = false; this.last = 0; if (this.data) this.render(); else this.lock(); } }
  }
  async restart() {
    if (!this.data?.migration?.restartable || this.saving) return;
    this.saving = true; const epoch = ++this.epoch; this.lock(); $('options-restart').disabled = true;
    try {
      const data = await this.api('/api/options-experiment', { action: 'archive_flat_and_restart', expectedStateHash: this.data.migration.expectedStateHash });
      if (epoch === this.epoch) { this.data = data; $('options-message').textContent = 'Previous ledger archived. New experiment ready with all strategies off.'; }
    } catch (error) { if (epoch === this.epoch) $('options-message').textContent = error.message; }
    finally { if (epoch === this.epoch) { this.saving = false; this.last = 0; this.render(); } }
  }
  render() {
    const d = this.data;
    $('options-restart').hidden = !d.migration?.restartable;
    $('options-restart').disabled = this.saving;
    $('options-status').textContent = d.error ?? d.unavailableReason ?? (d.lastAt ? `Last observation ${new Date(d.lastAt).toLocaleTimeString()} · ${d.lastScan?.entryGate.replaceAll('_', ' ')}` : 'Ready · all strategies initially off');
    $('options-note').textContent = d.note;
    $('options-validation').textContent = `${d.validation.verdict} · ${d.validation.holdoutTrades}/${d.validation.minimumTrades} closed holdout trades · ${d.validation.observedHoldoutSessions}/${d.validation.minimumSessions} observed sessions · forward test begins ${d.validation.holdoutStart}. Broker execution is not connected.`;
    if (d.qualityIssues.length) $('options-validation').textContent += ' Entry block: ' + d.qualityIssues.join(', ').replaceAll('_', ' ') + '.';
    $('options-limits').textContent = `Simulated capital ${money(d.policy.capital)} · maximum risk ${money(d.policy.maxRisk)}/spread, ${money(d.policy.maxPortfolioRisk)} total · daily loss gate ${money(d.policy.dailyLoss)} · assumed fee ${money(d.policy.feePerContractSide)}/contract/side plus adverse bid–ask fills and slippage.`;
    const rejection = Object.entries(d.lastScan?.rejected ?? {}).map(([key, n]) => `${key.replaceAll('_', ' ')}: ${n}`).join(' · ');
    $('options-rejections').textContent = rejection || 'No scanner observations yet.';
    for (const s of d.strategies) {
      let row = this.rows.get(s.id);
      if (!row) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td><label class="strategy-switch"><input type="checkbox" role="switch"><span class="strategy-switch-track" aria-hidden="true"></span><span data-field="selection"></span></label></td><td class="strategy-description"><strong data-field="name"></strong><small data-field="description"></small></td><td><strong data-field="net"></strong><small data-field="stress"></small></td><td><strong data-field="win"></strong><small data-field="closed"></small></td><td><strong data-field="open"></strong><small data-field="positions"></small></td>';
        row = { tr, input: tr.querySelector('input'), fields: Object.fromEntries([...tr.querySelectorAll('[data-field]')].map(el => [el.dataset.field, el])) };
        row.input.dataset.strategy = s.id; row.input.setAttribute('aria-label', 'Enable shadow ' + s.name);
        this.rows.set(s.id, row); $('options-rows').append(tr);
      }
      row.input.checked = s.enabled; row.input.disabled = this.saving || (!s.enabled && !!d.unavailableReason);
      const f = row.fields;
      f.selection.textContent = s.enabled ? 'On' : 'Off'; f.name.textContent = s.name; f.description.textContent = s.description;
      f.net.textContent = money(s.netPnl); f.stress.textContent = `Net at stress costs: ${money(s.stressNetPnl)}`;
      f.win.textContent = s.winRate === null ? '—' : (s.winRate * 100).toFixed(1) + '%'; f.closed.textContent = `${s.closed} closed spreads`;
      f.open.textContent = money(s.openNet); f.positions.textContent = `${s.openPositions} open · ${s.pending} awaiting later quotes`;
    }
  }
}
