const colors = { grid: '#20303b', text: '#8496a8', up: '#6ce0b5', down: '#f08298', amber: '#ecc37c', blue: '#84b8fa', bg: '#0e151e' };
const price = n => Number(n).toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 5 : 2 });
const clock = (ts, seconds = false) => new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hour12: false });

// Dependency-free canvas renderer. Chart state never submits an order.
export class TradingChart {
  constructor(canvas, tooltip, onSelect) {
    Object.assign(this, { canvas, tooltip, onSelect });
    this.count = 90; this.offset = 0; this.follow = true; this.showSignals = true; this.showAverages = true; this.hover = null;
    this.observer = new ResizeObserver(() => this.draw()); this.observer.observe(canvas.parentElement);
    canvas.addEventListener('pointermove', e => { const r = canvas.getBoundingClientRect(); this.hover = { x: e.clientX - r.left, y: e.clientY - r.top }; this.draw(); });
    canvas.addEventListener('pointerleave', () => { this.hover = null; this.tooltip.hidden = true; this.draw(); });
    canvas.addEventListener('click', () => { if (this.closestMarker) this.onSelect(this.closestMarker); });
    canvas.addEventListener('wheel', e => { e.preventDefault(); this.zoom(e.deltaY > 0 ? 1 : -1); }, { passive: false });
  }
  update(data) { if (this.data?.symbol !== data.symbol || this.data?.interval !== data.interval) { this.offset = 0; this.follow = true; } this.data = data; this.draw(); }
  zoom(direction) { this.count = Math.max(20, Math.min(240, this.count + direction * 20)); this.draw(); }
  pan(direction) { this.follow = false; this.offset = Math.max(0, Math.min(Math.max(0, (this.data?.bars.length ?? 0) - this.count), this.offset + direction * 20)); this.draw(); }
  reset() { this.follow = true; this.offset = 0; this.draw(); }
  clear(message = 'Connecting to chart data…') { this.data = null; this.emptyMessage = message; this.draw(); }
  draw() {
    const { canvas, data } = this, width = canvas.parentElement.clientWidth, height = 430;
    if (!width) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) { canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); }
    const ctx = canvas.getContext('2d'); ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.fillStyle = colors.bg; ctx.fillRect(0, 0, width, height);
    ctx.font = '11px ui-monospace, SFMono-Regular, Consolas, monospace';
    const left = 12, right = width - 85, top = 24, bottom = 321, volumeTop = 349, volumeBottom = 394, plotWidth = right - left;
    const all = data?.bars ?? [], end = this.follow ? all.length : Math.max(0, all.length - this.offset), bars = all.slice(Math.max(0, end - this.count), end);
    this.closestMarker = null;
    if (!bars.length) {
      if (data?.quoteSeries?.length) { this.drawQuotes(ctx, width, height); return; }
      ctx.fillStyle = colors.text; ctx.textAlign = 'center';
      ctx.fillText(this.emptyMessage ?? 'Waiting for the first completed one-minute candle.', width / 2, 190);
      if (data?.quote) ctx.fillText(`Bid ${price(data.quote.bid)}   Ask ${price(data.quote.ask)} · ${data.quoteFresh ? 'fresh quote' : 'stale quote'}`, width / 2, 220);
      this.tooltip.hidden = true; return;
    }
    const step = plotWidth / (bars.length + 3), x = i => left + (i + .6) * step;
    const barWidth = data.intervalMs ?? data.interval * 60000;
    const minTime = bars[0].ts, maxTime = bars.at(-1).ts + barWidth;
    const levels = data.levels ?? [], q = this.follow ? data.quote : null;
    const values = bars.flatMap(b => [b.low, b.high]);
    if (q) values.push(q.bid, q.ask);
    let min = Math.min(...values), max = Math.max(...values), range = Math.max(max - min, max * .001);
    // Distant protective levels are listed in the inspector instead of destroying chart scale.
    for (const l of levels) if (l.price >= min - range * .5 && l.price <= max + range * .5) { min = Math.min(min, l.price); max = Math.max(max, l.price); }
    range = Math.max(max - min, max * .001); min -= range * .13; max += range * .13;
    const y = p => top + (max - p) / (max - min) * (bottom - top);
    ctx.strokeStyle = colors.grid; ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i++) { const yy = top + i * (bottom - top) / 5; ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(right, yy); ctx.stroke(); ctx.fillStyle = colors.text; ctx.textAlign = 'left'; ctx.fillText(price(max - i * (max - min) / 5), right + 8, yy + 4); }
    const volumeMax = Math.max(...bars.map(b => b.volume), 1);
    bars.forEach((b, i) => {
      const xx = x(i), yy = Math.min(y(b.open), y(b.close)), bodyHeight = Math.max(1.5, Math.abs(y(b.open) - y(b.close))), bodyWidth = Math.max(2, Math.min(12, step * .65));
      ctx.strokeStyle = ctx.fillStyle = b.close >= b.open ? colors.up : colors.down;
      ctx.beginPath(); ctx.moveTo(xx, y(b.high)); ctx.lineTo(xx, y(b.low)); ctx.stroke();
      if (b.partial) ctx.strokeRect(xx - bodyWidth / 2, yy, bodyWidth, bodyHeight); else ctx.fillRect(xx - bodyWidth / 2, yy, bodyWidth, bodyHeight);
      ctx.globalAlpha = .38; const vh = b.volume / volumeMax * (volumeBottom - volumeTop); ctx.fillRect(xx - bodyWidth / 2, volumeBottom - vh, bodyWidth, vh); ctx.globalAlpha = 1;
      if (i % Math.max(1, Math.ceil(bars.length / 6)) === 0) { ctx.fillStyle = colors.text; ctx.textAlign = 'center'; ctx.fillText(clock(b.ts, barWidth < 60000), xx, 416); }
    });
    ctx.fillStyle = colors.text; ctx.textAlign = 'left'; ctx.fillText('VOLUME', left + 5, volumeTop - 7);
    if (this.showAverages) for (const [period, color] of [[9, colors.blue], [21, colors.amber]]) {
      let value; const series = all.map(b => { value = value == null ? b.close : value + 2 / (period + 1) * (b.close - value); return value; });
      ctx.strokeStyle = color; ctx.lineWidth = 1.3; ctx.beginPath();
      const start = Math.max(0, end - this.count);
      bars.forEach((b, i) => { const yy = y(series[start + i]); if (i === 0 || b.ts - bars[i - 1].ts > barWidth) ctx.moveTo(x(i), yy); else ctx.lineTo(x(i), yy); }); ctx.stroke();
    }
    const line = (p, color, label) => {
      const yy = y(p); if (yy < top || yy > bottom) return;
      ctx.strokeStyle = color; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(right, yy); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = color; ctx.textAlign = 'right'; ctx.fillText(`${label} ${price(p)}`, right - 6, yy - 5);
    };
    for (const l of levels) line(l.price, l.kind === 'stop' ? colors.down : l.kind === 'target' ? colors.up : colors.blue, l.label);
    if (q && data.position && data.quoteFresh) {
      const y1 = Math.max(top, Math.min(bottom, y(data.position.entryPrice))), y2 = Math.max(top, Math.min(bottom, y(q.bid)));
      ctx.fillStyle = q.bid >= data.position.entryPrice ? colors.up : colors.down; ctx.globalAlpha = .06;
      ctx.fillRect(left, Math.min(y1, y2), plotWidth, Math.abs(y1 - y2)); ctx.globalAlpha = 1;
    }
    const tx = ts => { const i = bars.findIndex(b => ts >= b.ts && ts < b.ts + barWidth); return i < 0 ? ts >= maxTime ? x(bars.length) : null : x(i); };
    for (const trade of data.trades ?? []) {
      if (trade.entryTs < minTime || trade.exitTs > maxTime + barWidth) continue;
      const start = tx(trade.entryTs), end = tx(trade.exitTs);
      if (start == null || end == null || y(trade.entryPrice) < top || y(trade.exitPrice) > bottom) continue;
      ctx.strokeStyle = trade.pnl >= 0 ? colors.up : colors.down; ctx.lineWidth = 1.2; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(start, y(trade.entryPrice)); ctx.lineTo(end, y(trade.exitPrice)); ctx.stroke(); ctx.setLineDash([]);
    }
    if (q) { line(q.bid, data.quoteFresh ? colors.up : colors.text, data.positionPnl?.fresh ? `Open P/L ${money(data.positionPnl.value)} · Bid` : 'Bid'); if ((q.ask - q.bid) / (max - min) > .04) line(q.ask, colors.blue, 'Ask'); }
    const visibleMarkers = (data.markers ?? []).filter(m => m.ts >= minTime && m.ts <= maxTime + barWidth && (m.type === 'fill' || this.showSignals));
    let nearest = 16;
    for (const m of visibleMarkers) {
      let index = bars.findIndex(b => m.ts >= b.ts && m.ts < b.ts + barWidth);
      if (index < 0) { if (m.ts >= maxTime) index = bars.length; else continue; }
      const xx = x(index), yy = y(m.price); if (yy < top || yy > bottom) continue;
      const fill = m.type === 'fill', buy = m.side === 'buy';
      ctx.fillStyle = fill ? buy ? colors.up : colors.down : m.status === 'approved' ? colors.blue : '#8e82af';
      ctx.strokeStyle = colors.bg; ctx.lineWidth = 1.5; ctx.beginPath();
      if (fill) { const sign = buy ? 1 : -1; ctx.moveTo(xx, yy - sign * 7); ctx.lineTo(xx - 5, yy + sign * 4); ctx.lineTo(xx + 5, yy + sign * 4); ctx.closePath(); } else ctx.arc(xx, yy, 3.3, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
      if (this.hover) { const distance = Math.hypot(this.hover.x - xx, this.hover.y - yy); if (distance < nearest) { nearest = distance; this.closestMarker = m; } }
    }
    if (this.hover && this.hover.x < right && this.hover.y < volumeBottom) {
      const index = Math.max(0, Math.min(bars.length - 1, Math.round((this.hover.x - left) / step - .6))), b = bars[index], xx = x(index);
      ctx.setLineDash([3, 3]); ctx.strokeStyle = '#6d7d8c'; ctx.beginPath(); ctx.moveTo(xx, top); ctx.lineTo(xx, volumeBottom); ctx.moveTo(left, this.hover.y); ctx.lineTo(right, this.hover.y); ctx.stroke(); ctx.setLineDash([]);
      this.tooltip.hidden = false;
      this.tooltip.textContent = this.closestMarker ? `${this.closestMarker.type.toUpperCase()} · ${this.closestMarker.side ?? this.closestMarker.status} · ${price(this.closestMarker.price)} · click for details` :
        `${new Date(b.ts).toLocaleString()} | O ${price(b.open)} H ${price(b.high)} L ${price(b.low)} C ${price(b.close)} | V ${Number(b.volume).toLocaleString('en-US', { maximumFractionDigits: 8 })}${b.partial ? ' | forming / incomplete aggregate' : ''}`;
    } else this.tooltip.hidden = true;
  }
  drawQuotes(ctx, width) {
    const data = this.data, points = data.quoteSeries, left = 18, right = width - 85, top = 50, bottom = 350;
    const values = points.flatMap(p => [p.bid, p.ask]), lo = Math.min(...values), hi = Math.max(...values), pad = Math.max((hi - lo) * .15, hi * .0001);
    const t0 = points[0].ts, t1 = Math.max(t0 + 30000, points.at(-1).ts);
    const x = ts => left + (ts - t0) / (t1 - t0) * (right - left), y = v => bottom - (v - lo + pad) / (hi - lo + 2 * pad) * (bottom - top);
    ctx.textAlign = 'left'; ctx.fillStyle = colors.text; ctx.fillText(data.intervalMs < 60000 ? 'LIVE BID / ASK · waiting for trade-print candles' : 'LIVE BID / ASK · candles appear after a minute closes', left, 22);
    for (let i = 0; i <= 4; i++) {
      const yy = top + i * (bottom - top) / 4;
      ctx.strokeStyle = colors.grid; ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(right, yy); ctx.stroke();
      ctx.fillStyle = colors.text; ctx.fillText(price(hi + pad - i / 4 * (hi - lo + 2 * pad)), right + 7, yy + 4);
    }
    for (const [field, color] of [['bid', colors.up], ['ask', colors.blue]]) {
      ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath();
      points.forEach((p, i) => { if (!i || p.ts - points[i - 1].ts > 30000) ctx.moveTo(x(p.ts), y(p[field])); else ctx.lineTo(x(p.ts), y(p[field])); }); ctx.stroke();
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x(points.at(-1).ts), y(points.at(-1)[field]), 3, 0, Math.PI * 2); ctx.fill();
    }
    for (const m of data.markers.filter(m => m.type === 'fill' && m.ts >= t0 && m.ts <= t1 && m.price >= lo - pad && m.price <= hi + pad)) {
      ctx.fillStyle = m.side === 'buy' ? colors.up : colors.down; ctx.textAlign = 'center'; ctx.fillText(m.side === 'buy' ? '▲' : '▼', x(m.ts), y(m.price));
    }
    ctx.fillStyle = colors.text; ctx.textAlign = 'left'; ctx.fillText(clock(t0), left, 390); ctx.textAlign = 'right'; ctx.fillText(clock(points.at(-1).ts), right, 390);
    this.tooltip.hidden = true;
  }
}

const money = n => Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
export class PnlChart {
  constructor(canvas, tooltip) {
    Object.assign(this, { canvas, tooltip });
    this.observer = new ResizeObserver(() => this.draw()); this.observer.observe(canvas.parentElement);
    canvas.addEventListener('pointermove', e => { this.pointer = e.clientX - canvas.getBoundingClientRect().left; this.draw(); });
    canvas.addEventListener('pointerleave', () => { this.pointer = null; tooltip.hidden = true; this.draw(); });
  }
  update(data) { this.data = data; this.draw(); }
  clear() { this.data = null; this.draw(); }
  draw() {
    const width = this.canvas.parentElement.clientWidth, height = 245;
    if (!width) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = width * ratio; this.canvas.height = height * ratio;
    const ctx = this.canvas.getContext('2d'); ctx.scale(ratio, ratio); ctx.fillStyle = colors.bg; ctx.fillRect(0, 0, width, height);
    ctx.font = '11px ui-monospace, Consolas, monospace';
    const points = this.data?.points ?? [];
    if (!points.length) { ctx.fillStyle = colors.text; ctx.textAlign = 'center'; ctx.fillText('Waiting for the first reconciled account observation.', width / 2, 120); return; }
    const left = 16, right = width - 95, top = 30, bottom = 208;
    const values = [0, ...points.flatMap(p => [p.dailyPnl, p.unrealized].filter(Number.isFinite))];
    let low = Math.min(...values), high = Math.max(...values), range = Math.max(1, high - low);
    const limit = -this.data.dailyLoss, showLimit = Number.isFinite(this.data.dailyLoss) && this.data.dailyLoss > 0 && limit >= low - range * .3;
    if (showLimit) low = Math.min(low, limit);
    range = Math.max(1, high - low); low -= range * .12; high += range * .12;
    const start = points[0].ts, finish = Math.max(start + 10000, points.at(-1).ts);
    const x = ts => left + (ts - start) / (finish - start) * (right - left), y = v => bottom - (v - low) / (high - low) * (bottom - top);
    for (let i = 0; i <= 4; i++) {
      const v = low + i / 4 * (high - low);
      ctx.strokeStyle = colors.grid; ctx.beginPath(); ctx.moveTo(left, y(v)); ctx.lineTo(right, y(v)); ctx.stroke();
      ctx.fillStyle = colors.text; ctx.fillText(money(v), right + 8, y(v) + 4);
    }
    ctx.setLineDash([4, 4]); ctx.strokeStyle = colors.text; ctx.beginPath(); ctx.moveTo(left, y(0)); ctx.lineTo(right, y(0)); ctx.stroke();
    if (showLimit) { ctx.strokeStyle = colors.down; ctx.beginPath(); ctx.moveTo(left, y(limit)); ctx.lineTo(right, y(limit)); ctx.stroke(); ctx.fillStyle = colors.down; ctx.fillText('Daily loss ceiling', left + 4, y(limit) - 5); }
    ctx.setLineDash([]);
    for (const [field, color] of [['dailyPnl', colors.up], ['unrealized', colors.blue]]) {
      ctx.strokeStyle = color; ctx.lineWidth = 1.8; ctx.beginPath(); let previous = null;
      for (const p of points) {
        if (!Number.isFinite(p[field])) { previous = null; continue; }
        if (!previous || p.ts - previous.ts > (this.data.gapMs ?? 30000)) ctx.moveTo(x(p.ts), y(p[field])); else ctx.lineTo(x(p.ts), y(p[field]));
        previous = p;
      }
      ctx.stroke();
      const last = points.at(-1);
      if (Number.isFinite(last[field])) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x(last.ts), y(last[field]), 3, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.fillStyle = colors.text; ctx.textAlign = 'left'; ctx.fillText(clock(start), left, 234); ctx.textAlign = 'right'; ctx.fillText(clock(points.at(-1).ts), right, 234);
    if (this.pointer != null && this.pointer >= left && this.pointer <= right) {
      const ts = start + (this.pointer - left) / (right - left) * (finish - start);
      const closest = points.reduce((best, p) => Math.abs(p.ts - ts) < Math.abs(best.ts - ts) ? p : best);
      ctx.strokeStyle = colors.text; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x(closest.ts), top); ctx.lineTo(x(closest.ts), bottom); ctx.stroke(); ctx.setLineDash([]);
      this.tooltip.hidden = false; this.tooltip.textContent = `${new Date(closest.ts).toLocaleString()} · Daily change ${money(closest.dailyPnl)} · Open P/L ${Number.isFinite(closest.unrealized) ? money(closest.unrealized) : 'unavailable'}`;
    } else this.tooltip.hidden = true;
  }
}
