import { $, escape } from './dashboard-format.js';
import { pct, cash, date, tone } from './return-format.js';
import { TradeReturnChart } from './trade-return-chart.js';

export class TradePerformanceView {
  constructor(api) {
    Object.assign(this, { api, sequence: 0, lastRefresh: 0, selected: '', connected: false });
    this.chart = new TradeReturnChart(id => { this.selected = id; this.chart.reset(); this.render(); });
    for (const id of ['trade-return-days', 'trade-return-interval']) $(id).addEventListener('change', () => { this.sequence++; this.lastRefresh = 0; this.data = null; this.selected = ''; this.chart.reset(); this.render(); void this.refresh(true); });
    for (const id of ['trade-return-symbol', 'trade-return-status']) $(id).addEventListener('change', () => { this.selected = ''; this.chart.reset(); this.render(); });
    $('trade-return-reset').addEventListener('click', () => { this.selected = ''; this.chart.reset(); this.render(); });
    $('trade-return-rows').addEventListener('click', e => {
      const button = e.target.closest('[data-trade]'); if (!button) return;
      this.selected = this.selected === button.dataset.trade ? '' : button.dataset.trade; this.chart.reset(); this.render();
    });
  }
  async refresh(force = false) {
    if (!force && Date.now() - this.lastRefresh < 5000) return;
    this.lastRefresh = Date.now(); const sequence = ++this.sequence;
    try {
      const data = await this.api(`/api/trade-performance?days=${$('trade-return-days').value}&interval=${$('trade-return-interval').value}`);
      if (sequence !== this.sequence) return;
      this.data = data; this.connected = true;
      const current = $('trade-return-symbol').value, symbols = [...new Set(data.trades.map(t => t.symbol))].sort();
      $('trade-return-symbol').innerHTML = '<option value="">All tickers</option>' + symbols.map(s => `<option value="${escape(s)}">${escape(s)}</option>`).join('');
      if (symbols.includes(current)) $('trade-return-symbol').value = current;
      this.render();
    } catch (error) {
      if (sequence !== this.sequence) return;
      this.connected = false; this.render(); $('trade-return-health').textContent = `DISCONNECTED · ${error.message}`;
    }
  }
  clear() {
    this.sequence++; this.lastRefresh = 0; this.data = null; this.selected = ''; this.connected = false; this.chart.reset();
    $('trade-return-symbol').innerHTML = '<option value="">All tickers</option>'; this.render();
  }
  filtered() {
    const symbol = $('trade-return-symbol').value, status = $('trade-return-status').value;
    return (this.data?.trades ?? []).filter(t => (!symbol || t.symbol === symbol) && (status === 'all' || (status === 'active' ? t.status !== 'closed' : t.status === 'closed')));
  }
  disconnect() { this.connected = false; this.render(); }
  render() {
    const trades = this.filtered();
    if (!trades.some(t => t.id === this.selected)) this.selected = '';
    const closed = trades.filter(t => t.status === 'closed'), active = trades.filter(t => t.status !== 'closed');
    $('trade-return-counts').textContent = this.data ? `${closed.filter(t => t.returnPct > 0).length} closed positive · ${closed.filter(t => t.returnPct < 0).length} closed negative · ${closed.filter(t => t.returnPct === 0).length} flat · ${active.length} active / settling · ${trades.filter(t => t.returnPct == null).length} unpriced` : 'Waiting for the fill journal.';
    $('trade-return-health').textContent = !this.data ? 'CONNECTING' : !this.connected ? 'DISCONNECTED · cached values' : this.data.recordingError ? 'HISTORY RECORDING ERROR' : active.some(t => t.returnPct == null) ? 'SOME MARKS UNAVAILABLE' : `UPDATED ${date(this.data.now)} ET`;
    $('trade-return-health').className = `pill ${!this.connected || this.data?.recordingError || active.some(t => t.returnPct == null) ? 'amber' : ''}`;
    $('trade-return-reset').hidden = !this.selected;
    $('trade-return-rows').innerHTML = trades.map(t => {
      const last = t.points.at(-1), unavailable = t.returnPct == null;
      const state = t.status === 'closed' ? 'Closed' : t.status === 'settling' ? 'Settling' : !this.connected ? 'Active · cached' : unavailable ? 'Active · unpriced' : 'Active';
      return `<tr class="${this.selected === t.id ? 'return-selected' : ''}"><td><button class="return-pick" data-trade="${escape(t.id)}" aria-pressed="${this.selected === t.id}" aria-label="Focus ${escape(t.symbol)} trade entered ${escape(date(t.entryAt))}">${escape(t.symbol)} <span>↗</span></button><small>${escape(t.strategy.replaceAll('_', ' '))}</small></td><td>${state}<small>${escape(t.reason ?? (t.status === 'closed' ? 'Final recorded fills' : `${t.qty.toLocaleString('en-US', { maximumFractionDigits: 6 })} shares / units remaining`))}</small></td><td>${date(t.entryAt)}<small>${escape(t.entryTimeSource)}${t.entryAt != null && t.entryAt < this.data.since ? ' · before chart window' : ''}</small></td><td>${date(t.status === 'closed' ? t.closedAt : t.asOf)}<small>${t.status === 'closed' ? 'Exit' : t.quoteAt ? `Bid at ${date(t.quoteAt)}` : 'No fresh valuation'}</small></td><td class="${tone(t.returnPct)}"><strong>${pct(t.returnPct)}</strong><small>${unavailable && last ? `Last observed ${pct(last.returnPct)} · ${date(last.ts)}` : `${cash(t.net)} estimated net`}</small></td><td>${cash(t.capital)}<small>${t.fills.filter(f => f.type === 'add').length} adds · ${t.fills.filter(f => f.type === 'exit').length} exit orders</small></td></tr>`;
    }).join('') || '<tr><td colspan="6" class="empty">No filled trades in this selection. Unfilled orders are not positions.</td></tr>';
    const focused = trades.find(t => t.id === this.selected);
    $('trade-return-detail').textContent = focused ? `${focused.symbol} · ${focused.fills.map(f => `${f.type.toUpperCase()} ${f.qty} @ ${cash(f.price)} · ${date(f.ts)} ET (${f.timeSource})`).join(' | ')}. These are cumulative order fills; partial-fill start times may be unavailable.` : 'Hover a marker for its ticker and return, or select a trade in the table to focus its path. All times are New York (ET).';
    $('trade-return-note').textContent = (this.data?.note ?? '') + (this.data?.truncated ? ` Showing the first 100 of ${this.data.total} campaigns, with active trades first.` : '') + (trades.some(t => t.historyLimited) ? ` History is capped at the latest 3,000 ${this.data.intervalMinutes}-minute intervals per trade. Choose a coarser resolution to see farther back.` : '') + (this.data?.recordingError ? ` ${this.data.recordingError}.` : '');
    this.chart.update(this.data, trades.filter(t => !this.selected || t.id === this.selected), this.connected);
  }
}
