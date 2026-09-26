import { chartPalette } from './chart-palette.js';
import { $ } from './dashboard-format.js';
import { pct, cash, date, color } from './return-format.js';
import { MINUTE, minuteTicks, ReturnViewport } from './return-timeline.js';

export class TradeReturnChart {
  constructor(onSelect) {
    this.canvas = $('trade-return-chart'); this.tooltip = $('trade-return-tooltip');
    this.trades = []; this.viewport = new ReturnViewport();
    document.addEventListener('dashboard-design-change', () => this.draw());
    this.observer = new ResizeObserver(() => this.draw()); this.observer.observe(this.canvas.parentElement);
    this.canvas.addEventListener('pointermove', event => {
      const rect = this.canvas.getBoundingClientRect(); this.pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top }; this.draw();
    });
    this.canvas.addEventListener('pointerleave', () => { this.pointer = null; this.draw(); });
    this.canvas.addEventListener('click', () => { if (this.hover) onSelect(this.hover.trade.id); });
    for (const [id, action] of [
      ['return-earlier', () => this.viewport.pan(-1)], ['return-later', () => this.viewport.pan(1)],
      ['return-zoom-in', () => this.viewport.zoom(.5)], ['return-zoom-out', () => this.viewport.zoom(2)],
      ['return-minute', () => this.viewport.latestMinute()], ['return-fit', () => this.viewport.reset()],
    ]) $(id).addEventListener('click', () => { action(); this.pointer = null; this.draw(); });
  }
  reset() { this.viewport.reset(); this.pointer = null; }
  update(data, trades, connected) { this.data = data; this.trades = trades; this.connected = connected; this.draw(); }
  draw() {
    const colors = chartPalette();
    const width = this.canvas.parentElement.clientWidth, height = 370;
    if (!width) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2), ctx = this.canvas.getContext('2d');
    this.canvas.width = width * ratio; this.canvas.height = height * ratio; ctx.scale(ratio, ratio);
    ctx.fillStyle = colors.bg; ctx.fillRect(0, 0, width, height); ctx.font = '11px ui-monospace, Consolas, monospace';
    this.tooltip.hidden = true; this.hover = null;
    const trades = this.trades, plotted = [];
    const since = this.data?.since ?? 0, now = this.data?.now ?? Date.now();
    for (const trade of trades) {
      const points = trade.points.filter(p => p.ts >= since && p.ts <= now && Number.isFinite(p.returnPct));
      const start = trade.entryAt != null && trade.entryAt >= since && trade.entryAt <= now ? { ts: trade.entryAt, returnPct: 0, type: 'entry' } : null;
      const stamp = trade.status === 'closed' ? trade.closedAt : trade.asOf;
      const end = stamp != null && stamp >= since && stamp <= now && Number.isFinite(trade.returnPct) ? { ts: stamp, returnPct: trade.returnPct, net: trade.net, type: trade.status === 'closed' ? 'exit' : this.connected ? 'active' : 'last observed' } : points.length ? { ...points.at(-1), type: 'last observed' } : null;
      if (start || points.length || end) plotted.push({ trade, points, start, end });
    }
    const marks = plotted.flatMap(t => [t.start, ...t.points, t.end].filter(Boolean));
    if (!marks.length) {
      for (const id of ['return-earlier', 'return-later', 'return-zoom-in', 'return-zoom-out', 'return-minute', 'return-fit']) $(id).disabled = true;
      $('return-viewport').textContent = 'No timestamped returns'; ctx.fillStyle = colors.text; ctx.textAlign = 'center'; ctx.fillText(trades.length ? 'No timestamped valuations in this window.' : 'No filled trades in this selection.', width / 2, 170); return; }
    const left = 65, right = Math.max(130, width - (width > 600 ? 160 : 85)), top = 45, bottom = 312;
    let low = 0, high = 0, from = now, to = since;
    for (const p of marks) { low = Math.min(low, p.low ?? p.returnPct); high = Math.max(high, p.high ?? p.returnPct); from = Math.min(from, p.ts); to = Math.max(to, p.ts); }
    if (trades.some(t => t.status !== 'closed')) to = now;
    const range = Math.max(.1, high - low); low -= range * .13; high += range * .13;
    ({ from, to } = this.viewport.resolve(Math.max(since, from), to));
    const minutes = (to - from) / MINUTE;
    $('return-viewport').textContent = `${minutes < 60 ? minutes.toFixed(1) + ' minutes' : (minutes / 60).toFixed(1) + ' hours'} visible · ${this.data.intervalMinutes}m resolution · ET`;
    $('return-earlier').disabled = from <= this.viewport.bounds.from;
    $('return-later').disabled = to >= this.viewport.bounds.to;
    $('return-zoom-in').disabled = to - from <= MINUTE;
    $('return-zoom-out').disabled = to - from >= this.viewport.bounds.to - this.viewport.bounds.from;
    $('return-minute').disabled = false; $('return-fit').disabled = false;
    const x = ts => left + (ts - from) / (to - from) * (right - left), y = v => bottom - (v - low) / (high - low) * (bottom - top);
    ctx.textAlign = 'left'; ctx.fillStyle = colors.text; ctx.fillText('RETURN %', left, 20);
    for (let i = 0; i <= 4; i++) {
      const value = low + i / 4 * (high - low), yy = y(value);
      ctx.strokeStyle = colors.grid; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(right, yy); ctx.stroke();
      ctx.textAlign = 'right'; ctx.fillStyle = colors.text; ctx.fillText(pct(value), left - 8, yy + 4);
    }
    ctx.strokeStyle = colors.text; ctx.setLineDash([4, 5]); ctx.beginPath(); ctx.moveTo(left, y(0)); ctx.lineTo(right, y(0)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = colors.text; ctx.textAlign = 'left'; ctx.fillText('0% entry reference', left + 5, y(0) - 8);
    for (const ts of minuteTicks(from, to, right - left)) {
      ctx.textAlign = x(ts) < left + 45 ? 'left' : x(ts) > right - 45 ? 'right' : 'center'; ctx.fillStyle = colors.text;
      ctx.fillText(new Date(ts).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' }), x(ts), 333);
      ctx.fillText(new Date(ts).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' }), x(ts), 350);
    }
    const hits = [], labels = [];
    const inView = point => point.ts >= from && point.ts <= to;
    const line = (a, b, dashed, c) => {
      ctx.save(); ctx.beginPath(); ctx.rect(left, top, right - left, bottom - top); ctx.clip();
      ctx.strokeStyle = c; ctx.lineWidth = dashed ? 1 : 1.8; ctx.setLineDash(dashed ? [2, 5] : []);
      ctx.beginPath(); ctx.moveTo(x(a.ts), y(a.returnPct)); ctx.lineTo(x(b.ts), y(b.returnPct)); ctx.stroke(); ctx.restore();
    };
    const marker = (trade, point) => {
      if (!inView(point)) return;
      const xx = x(point.ts), yy = y(point.returnPct), c = point.type === 'entry' ? colors.blue : color(point.returnPct);
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
      for (const point of points.filter(inView)) {
        // Whiskers retain observed intraminute gains/losses without pretending
        // their ordering or exact path is recoverable from a minute summary.
        if (Number.isFinite(point.low) && Number.isFinite(point.high)) {
          ctx.strokeStyle = color(point.returnPct); ctx.globalAlpha = .4; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(x(point.ts), y(point.low)); ctx.lineTo(x(point.ts), y(point.high)); ctx.stroke(); ctx.globalAlpha = 1;
        }
        hits.push({ x: x(point.ts), y: y(point.returnPct), point: { ...point, type: 'interval last observation' }, trade });
      }
      if (start) marker(trade, start);
      if (end && inView(end)) { marker(trade, end); labels.push({ trade, end, x: x(end.ts), y: y(end.returnPct) }); }
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
        this.tooltip.textContent = `${trade.symbol} · ${point.type.toUpperCase()} · ${date(point.ts)} ET · ${pct(point.returnPct)}${point.net != null ? ` / ${cash(point.net)}` : ' entry reference'} · ${trade.strategy.replaceAll('_', ' ')}${point.type === 'last observed' ? ' · not a current price' : ''}${Number.isFinite(point.low) ? ` · observed range ${pct(point.low)} to ${pct(point.high)} · ${point.samples} samples` : ''}`;
      }
    }
  }
}
