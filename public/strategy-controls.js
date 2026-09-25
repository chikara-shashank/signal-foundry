const $ = id => document.getElementById(id);
const money = n => n === null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const escape = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class StrategyControlsView {
  constructor(api) {
    this.api = api; this.rows = new Map(); this.data = null; this.last = 0; this.epoch = 0; this.saving = false; this.loading = false;
    const filters=document.createElement('form'); filters.className='strategy-filters';
    filters.innerHTML='<label>Experiment <select id="strategy-experiment"><option value="">All versions</option></select></label><label>Entry from (UTC) <input type="date" id="strategy-from"></label><label>Entry before (UTC) <input type="date" id="strategy-to"></label><button type="submit">Apply results filter</button>';
    $('strategy-control-message').before(filters);
    filters.addEventListener('submit',event=>{event.preventDefault();if(this.saving)return;this.filter={experimentId:$('strategy-experiment').value,from:$('strategy-from').value,to:$('strategy-to').value};this.epoch++;this.loading=false;this.last=0;void this.refresh({});});
    this.filter={};
    $('strategy-control-rows').addEventListener('change', event => {
      const id = event.target.dataset.strategy;
      if (id) void this.save(id, event.target.checked);
    });
  }
  endpoint() { return '/api/strategies?'+new URLSearchParams(Object.entries(this.filter).filter(([,v])=>v)); }
  clear() {
    this.epoch++; this.data = null; this.rows.clear(); this.last = 0; this.saving = false; this.loading = false;
    $('strategy-control-rows').replaceChildren(); $('strategy-control-message').textContent = '';
  }
  async refresh(status) {
    if (this.loading || this.saving || (Date.now() - this.last < 5000 && this.data?.revision === status.strategyRevision)) return;
    this.loading = true; const epoch = this.epoch;
    try {
      const data = await this.api(this.endpoint());
      if (epoch !== this.epoch || this.saving) return;
      this.data = data; this.last = Date.now(); this.render();
    } catch (error) {
      if (epoch === this.epoch) { $('strategy-control-summary').textContent = 'Strategy controls disconnected'; $('strategy-control-message').textContent = error.message; this.lock(); }
    } finally { if (epoch === this.epoch) this.loading = false; }
  }
  lock() { for (const { input } of this.rows.values()) input.disabled = true; }
  async save(id, enabled) {
    if (this.saving || !this.data) return;
    this.saving = true; const epoch = ++this.epoch; this.loading = false;
    this.render(); this.lock(); $('strategy-control-message').textContent = 'Saving strategy selection…';
    try {
      await this.api('/api/strategy-settings', { strategy: id, enabled, expectedRevision: this.data.revision });
      const data = await this.api(this.endpoint());
      if (epoch !== this.epoch) return;
      this.data = data;
      const strategy = data.strategies.find(s => s.id === id);
      $('strategy-control-message').textContent = `${strategy.name} ${enabled ? 'enabled for new setups' : 'switched off for new entries'}. Saved across restarts.${strategy.pendingCancellations ? ' Entry cancellation is pending broker confirmation.' : ''}${!enabled && strategy.openPositions ? ' Existing positions remain under exit management.' : ''}`;
    } catch (error) {
      if (epoch !== this.epoch) return;
      $('strategy-control-message').textContent = error.message + ' Checking the saved selection…';
      try {
        const data = await this.api(this.endpoint());
        if (epoch !== this.epoch) return;
        this.data = data; $('strategy-control-message').textContent = error.message + ' Current saved selection shown below.';
      } catch {
        if (epoch !== this.epoch) return;
        this.data = null; $('strategy-control-message').textContent = 'Connection lost. Save outcome is unknown; controls will recover on reconnect.';
      }
    } finally {
      if (epoch === this.epoch) { this.saving = false; this.last = 0; if (this.data) this.render(); else this.lock(); }
    }
  }
  render() {
    const data = this.data; if (!data) return;
    const installed = data.strategies.filter(s => s.installed), enabled = installed.filter(s => s.enabled).length;
    $('strategy-control-summary').textContent = `${enabled} / ${installed.length} enabled · ${data.mode.toUpperCase()}${data.paused ? ' · entries paused' : !data.ready ? ' · entry gates blocked' : ''}`;
    $('strategy-control-note').textContent = data.note;
    const scope=data.filter?.experimentId ? `VERSION ${data.filter.experimentId.slice(0,12)}` : 'ALL VERSIONS';
    $('strategy-control-scope').textContent = `${data.mode === 'demo' ? 'SYNTHETIC DEMO' : data.mode.toUpperCase()} · ${scope}${data.filter?.from||data.filter?.to?' · FILTERED ENTRY DATES':''}`;
    const select=$('strategy-experiment'), selected=select.value;
    const options='<option value="">All versions</option>'+(data.experiments??[]).map(x=>`<option value="${escape(x.id)}">${escape(x.strategy??'Historical')} · ${escape(x.id.slice(0,12))}</option>`).join('');
    if(select.innerHTML!==options){select.innerHTML=options;select.value=selected;}
    for (const [id, row] of this.rows) if (!data.strategies.some(s => s.id === id)) { row.tr.remove(); this.rows.delete(id); }
    for (const strategy of data.strategies) {
      let row = this.rows.get(strategy.id);
      if (!row) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td><label class="strategy-switch"><input type="checkbox" role="switch" data-strategy="${escape(strategy.id)}" aria-label="Enable ${escape(strategy.name)}"><span class="strategy-switch-track" aria-hidden="true"></span><span data-field="selection"></span></label></td><td class="strategy-description"><strong data-field="name"></strong><small data-field="description"></small></td><td><strong data-field="net"></strong><small data-field="fees"></small></td><td><strong data-field="winRate"></strong><small data-field="wins"></small></td><td><span data-field="closed"></span><small data-field="partial"></small></td><td><strong data-field="open"></strong><small data-field="positions"></small></td><td class="strategy-availability"><span data-field="state"></span></td>`;
        row = { tr, input: tr.querySelector('input'), fields: Object.fromEntries([...tr.querySelectorAll('[data-field]')].map(el => [el.dataset.field, el])) };
        this.rows.set(strategy.id, row); $('strategy-control-rows').append(tr);
      }
      row.input.checked = strategy.enabled;
      row.input.disabled = this.saving || !strategy.installed || (!strategy.enabled && !!strategy.unavailableReason);
      row.input.title = strategy.unavailableReason ?? 'Saved immediately. Existing positions keep their exit management.';
      const f = row.fields;
      const values = { selection: strategy.enabled ? 'On' : 'Off', name: strategy.name, description: strategy.description,
        net: money(strategy.realizedNetPnl), fees: `${money(strategy.estimatedFees)} fees included`,
        winRate: strategy.winRate === null ? '—' : `${(strategy.winRate * 100).toFixed(1)}%`, wins: strategy.closed ? `${strategy.wins} wins / ${strategy.closed} closed` : 'No closed trades',
        closed: String(strategy.closed), partial: `${strategy.partial ? `${strategy.partial} partially exited. ` : ''}${strategy.excursions?.recorded??0} with bid tracking; ${strategy.excursions?.profitableThenLost??0} positive then lost.`,
        open: money(strategy.openGrossPnl), positions: `${strategy.openPositions} open position${strategy.openPositions === 1 ? '' : 's'}`,
        state: strategy.exceptions?.length ? `${strategy.exceptions.length} execution exception(s) · P/L unresolved` : strategy.pendingCancellations ? `${strategy.pendingCancellations} entry cancellation pending` : strategy.unavailableReason ?? (strategy.enabled ? data.paused ? 'Enabled · entries paused' : !data.ready ? 'Enabled · entry gates blocked' : 'Watching for new setups' : strategy.openPositions ? 'Off · managing exits' : 'Off · no new entries') };
      const risk=strategy.riskPolicy, q=strategy.qualification;
      values.description += ` Current version ${q.experimentId.slice(0,12)} · ${q.liveEligible?'qualified':'paper experiment'}. ` + (risk.sizing==='fixed_notional' ? `${money(risk.notional)} notional / ${money(risk.nominalStopRisk)} nominal stop risk; reservation ${risk.reservation.reason}.` : `${money(risk.risk)} stop risk / ${money(risk.maxPosition)} position cap.`);
      for (const [key, value] of Object.entries(values)) f[key].textContent = value;
      f.net.className = strategy.realizedNetPnl == null || strategy.realizedNetPnl === 0 ? '' : strategy.realizedNetPnl > 0 ? 'positive' : 'negative';
      f.open.className = strategy.openGrossPnl == null || strategy.openGrossPnl === 0 ? '' : strategy.openGrossPnl > 0 ? 'positive' : 'negative';
      f.state.className = strategy.unavailableReason || strategy.pendingCancellations ? 'amber' : 'muted';
    }
  }
}
