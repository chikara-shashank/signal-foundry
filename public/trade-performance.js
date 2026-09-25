const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = n => Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}%` : '—';
const cash = n => Number.isFinite(n) ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : '—';
const date = ts => ts == null ? 'Time unavailable' : new Date(ts).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const tone = n => !Number.isFinite(n) || Math.abs(n) < 1e-9 ? 'neutral' : n > 0 ? 'positive' : 'negative';
const color = n => !Number.isFinite(n) || Math.abs(n) < 1e-9 ? '#abc1d0' : n > 0 ? '#80ddb0' : '#ff8794';

export class TradePerformanceView {
  constructor(api) {
    Object.assign(this, { api, sequence: 0, lastRefresh: 0, selected: '', connected: false });
    this.canvas = $('trade-return-chart'); this.tooltip = $('trade-return-tooltip');
    this.observer = new ResizeObserver(() => this.draw()); this.observer.observe(this.canvas.parentElement);
    $('trade-return-days').addEventListener('change', () => { this.sequence++; this.lastRefresh = 0; this.data = null; this.selected = ''; this.render(); void this.refresh(true); });
    for (const id of ['trade-return-symbol', 'trade-return-status']) $(id).addEventListener('change', () => { this.selected = ''; this.render(); });
    $('trade-return-reset').addEventListener('click', () => { this.selected = ''; this.render(); });
    $('trade-return-rows').addEventListener('click', e => {
      const button = e.target.closest('[data-trade]'); if (!button) return;
      this.selected = this.selected === button.dataset.trade ? '' : button.dataset.trade; this.render();
    });
    this.canvas.addEventListener('pointermove', e => {
      const rect = this.canvas.getBoundingClientRect(); this.pointer = { x: e.clientX - rect.left, y: e.clientY - rect.top }; this.draw();
    });
    this.canvas.addEventListener('pointerleave', () => { this.pointer = null; this.draw(); });
    this.canvas.addEventListener('click', () => { if (this.hover) { this.selected = this.hover.trade.id; this.render(); } });
  }
  async refresh(force = false) {
    if (!force && Date.now() - this.lastRefresh < 5000) return;
    this.lastRefresh = Date.now(); const sequence = ++this.sequence;
    try {
      const data = await this.api(`/api/trade-performance?days=${$('trade-return-days').value}`);
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
    this.sequence++; this.lastRefresh = 0; this.data = null; this.selected = ''; this.connected = false; this.pointer = null;
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
    $('trade-return-note').textContent = (this.data?.note ?? '') + (this.data?.truncated ? ` Showing the first 100 of ${this.data.total} campaigns, with active trades first.` : '') + (trades.some(t => t.historyLimited) ? ' History is capped at the latest 3,000 retained observations per trade in this window.' : '') + (this.data?.recordingError ? ` ${this.data.recordingError}.` : '');
    this.draw();
  }
  draw() {
    const width = this.canvas.parentElement.clientWidth, height = 370;
    if (!width) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2), ctx = this.canvas.getContext('2d');
    this.canvas.width = width * ratio; this.canvas.height = height * ratio; ctx.scale(ratio, ratio);
    ctx.fillStyle = '#0e151e'; ctx.fillRect(0, 0, width, height); ctx.font = '11px ui-monospace, Consolas, monospace';
    this.tooltip.hidden = true; this.hover = null;
    const trades = this.filtered().filter(t => !this.selected || t.id === this.selected), plotted = [];
    const since = this.data?.since ?? 0, now = this.data?.now ?? Date.now();
    for (const trade of trades) {
      const points = trade.points.filter(p => p.ts >= since && p.ts <= now && Number.isFinite(p.returnPct));
      const start = trade.entryAt != null && trade.entryAt >= since && trade.entryAt <= now ? { ts: trade.entryAt, returnPct: 0, type: 'entry' } : null;
      const stamp = trade.status === 'closed' ? trade.closedAt : trade.asOf;
      const end = stamp != null && stamp >= since && stamp <= now && Number.isFinite(trade.returnPct) ? { ts: stamp, returnPct: trade.returnPct, net: trade.net, type: trade.status === 'closed' ? 'exit' : this.connected ? 'active' : 'last observed' } : points.length ? { ...points.at(-1), type: 'last observed' } : null;
      if (start || points.length || end) plotted.push({ trade, points, start, end });
    }
    const marks = plotted.flatMap(t => [t.start, ...t.points, t.end].filter(Boolean));
    if (!marks.length) { ctx.fillStyle = '#a4b6c5'; ctx.textAlign = 'center'; ctx.fillText(trades.length ? 'No timestamped valuations in this window.' : 'No filled trades in this selection.', width / 2, 170); return; }
    const left = 65, right = Math.max(130, width - (width > 600 ? 160 : 85)), top = 45, bottom = 312;
    let low = 0, high = 0, from = now, to = since;
    for (const p of marks) { low = Math.min(low, p.returnPct); high = Math.max(high, p.returnPct); from = Math.min(from, p.ts); to = Math.max(to, p.ts); }
    if (trades.some(t => t.status !== 'closed')) to = now;
    const range = Math.max(.1, high - low); low -= range * .13; high += range * .13;
    const span = Math.max(60000, to - from); from = Math.max(since, from - span * .015); to = Math.max(from + 60000, to + span * .015);
    const x = ts => left + (ts - from) / (to - from) * (right - left), y = v => bottom - (v - low) / (high - low) * (bottom - top);
    ctx.textAlign = 'left'; ctx.fillStyle = '#b5c6d4'; ctx.fillText('RETURN %', left, 20);
    for (let i = 0; i <= 4; i++) {
      const value = low + i / 4 * (high - low), yy = y(value);
      ctx.strokeStyle = '#24303d'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(right, yy); ctx.stroke();
      ctx.textAlign = 'right'; ctx.fillStyle = '#9fb1c1'; ctx.fillText(pct(value), left - 8, yy + 4);
    }
    ctx.strokeStyle = '#9caebb'; ctx.setLineDash([4, 5]); ctx.beginPath(); ctx.moveTo(left, y(0)); ctx.lineTo(right, y(0)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#b5c6d4'; ctx.textAlign = 'left'; ctx.fillText('0% entry reference', left + 5, y(0) - 8);
    const ticks = width < 600 ? 2 : 4;
    for (let i = 0; i <= ticks; i++) {
      const ts = from + (to - from) * i / ticks;
      ctx.textAlign = i === 0 ? 'left' : i === ticks ? 'right' : 'center'; ctx.fillStyle = '#9fb1c1';
      ctx.fillText(new Date(ts).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' }), x(ts), 333);
      ctx.fillText(new Date(ts).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' }), x(ts), 350);
    }
    const hits = [], labels = [];
    const line = (a, b, dashed, c) => {
      ctx.strokeStyle = c; ctx.lineWidth = dashed ? 1 : 1.8; ctx.setLineDash(dashed ? [2, 5] : []);
      ctx.beginPath(); ctx.moveTo(x(a.ts), y(a.returnPct)); ctx.lineTo(x(b.ts), y(b.returnPct)); ctx.stroke(); ctx.setLineDash([]);
    };
    const marker = (trade, point) => {
      const xx = x(point.ts), yy = y(point.returnPct), c = point.type === 'entry' ? '#96baff' : color(point.returnPct);
      ctx.fillStyle = c; ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.beginPath();
      if (point.type === 'entry') { ctx.moveTo(xx, yy - 6); ctx.lineTo(xx - 5, yy + 4); ctx.lineTo(xx + 5, yy + 4); ctx.closePath(); ctx.fill(); }
      else if (point.type === 'exit') { ctx.moveTo(xx, yy - 6); ctx.lineTo(xx - 6, yy); ctx.lineTo(xx, yy + 6); ctx.lineTo(xx + 6, yy); ctx.closePath(); ctx.fill(); }
      else { ctx.arc(xx, yy, 5, 0, Math.PI * 2); if (point.type === 'active') ctx.fill(); ctx.stroke(); ctx.beginPath(); ctx.arc(xx, yy, 8, 0, Math.PI * 2); ctx.stroke(); }
      hits.push({ x: xx, y: yy, point, trade });
    };
    for (const item of plotted) {
      const { trade, points, start, end } = item;
      if (start && (points[0] ?? end)) line(start, points[0] ?? end, true, color((points[0] ?? end).returnPct));
      for (let i = 1; i < points.length; i++) if (!points[i].breakBefore) line(points[i - 1], points[i], false, color(points[i].returnPct));
      if (end && points.length && end.ts > points.at(-1).ts) line(points.at(-1), end, end.ts - points.at(-1).ts > this.data.gapMs || end.type === 'exit', color(end.returnPct));
      for (const point of points) hits.push({ x: x(point.ts), y: y(point.returnPct), point: { ...point, type: 'recorded mark' }, trade });
      if (start) marker(trade, start);
      if (end) { marker(trade, end); labels.push({ trade, end, x: x(end.ts), y: y(end.returnPct) }); }
    }
    // The table identifies every trade. Keep overview labels legible rather than
    // overlapping hundreds of ticker names at the current-time edge.
    const shown = labels.slice(0, 14).sort((a, b) => a.y - b.y);
    let previousY = top - 16;
    for (let i = 0; i < shown.length; i++) {
      const l = shown[i], yy = Math.min(bottom - (shown.length - i - 1) * 17, Math.max(top + 4, l.y, previousY + 17)); previousY = yy;
      const xx = Math.min(right + 10, l.x + 13);
      ctx.strokeStyle = color(l.end.returnPct); ctx.globalAlpha = .45; ctx.beginPath(); ctx.moveTo(l.x + 6, l.y); ctx.lineTo(xx - 3, yy - 3); ctx.stroke(); ctx.globalAlpha = 1;
      ctx.fillStyle = color(l.end.returnPct); ctx.textAlign = 'left'; ctx.fillText(`${l.trade.symbol} ${pct(l.end.returnPct)}${l.end.type === 'last observed' ? ' (last)' : ''}`, xx, yy, width - xx - 6);
    }
    if (this.pointer) {
      let distance = 25;
      // Markers win ties with recorded observations at the same timestamp.
      for (const hit of hits) { const d = Math.hypot(hit.x - this.pointer.x, hit.y - this.pointer.y); if (d <= distance) { this.hover = hit; distance = d; } }
      if (this.hover) {
        const { trade, point } = this.hover;
        this.tooltip.hidden = false;
        this.tooltip.textContent = `${trade.symbol} · ${point.type.toUpperCase()} · ${date(point.ts)} ET · ${pct(point.returnPct)}${point.net != null ? ` / ${cash(point.net)}` : ' entry reference'} · ${trade.strategy.replaceAll('_', ' ')}${point.type === 'last observed' ? ' · not a current price' : ''}`;
      }
    }
  }
}
