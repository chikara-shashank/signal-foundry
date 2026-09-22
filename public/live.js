const summary = values => {
  const a = [...values].sort((x, y) => x - y);
  return { samples: a.length, p50: a.length ? a[Math.ceil(a.length * .5) - 1] : null, p95: a.length ? a[Math.ceil(a.length * .95) - 1] : null };
};
export class LiveQuotes {
  constructor(onFrame, onState) {
    this.onFrame = onFrame; this.onState = onState; this.generation = 0; this.samples = { delivery: [], draw: [], cadence: [] };
  }
  record(key, value) { if (!Number.isFinite(value) || value < 0) return; const list = this.samples[key]; list.push(value); if (list.length > 120) list.shift(); }
  stats() { return { ...Object.fromEntries(Object.entries(this.samples).map(([k, v]) => [k, summary(v)])), uncertainty: this.deliveryUncertainty ?? (this.calibration ? this.calibration.rtt / 2 : null) }; }
  select(token, symbol, interval) {
    const key = `${symbol}:${interval}`;
    if (this.key === key && this.token === token && this.controller) return;
    this.stop(); this.key = key; this.token = token; this.symbol = symbol; this.interval = String(interval); this.bars = new Map();
    this.samples = { delivery: [], draw: [], cadence: [] }; this.lastDraw = null; this.deliveryUncertainty = null;
    const generation = this.generation;
    void this.connect(generation);
  }
  stop() {
    this.generation++; this.controller?.abort(); this.controller = null; clearTimeout(this.retry); clearInterval(this.watchdog);
    cancelAnimationFrame(this.paint); this.paint = null; this.frame = null; this.pending = null; this.barList = []; this.calibration = null; this.key = null; this.connected = false; this.token = '';
  }
  async calibrate(generation) {
    const started = performance.now();
    const r = await fetch('/api/clock', { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(3000) });
    if (!r.ok) return; const data = await r.json(), ended = performance.now();
    if (generation !== this.generation) return;
    this.calibration = { sessionId: data.sessionId, offset: data.serverMono - (started + ended) / 2, rtt: ended - started, measured: ended };
  }
  async connect(generation) {
    if (generation !== this.generation) return;
    const controller = this.controller = new AbortController();
    this.connected = false; this.onState('Connecting live prices · 2s polling fallback');
    let lastPacket = performance.now(), lastCalibration = 0;
    this.watchdog = setInterval(() => { if (performance.now() - lastPacket > 3000) controller.abort(); }, 1000);
    try {
      await this.calibrate(generation);
      if (generation !== this.generation) return;
      const params = new URLSearchParams({ symbol: this.symbol, interval: this.interval });
      const r = await fetch(`/api/stream?${params}`, { headers: { Authorization: `Bearer ${this.token}` }, signal: controller.signal });
      if (!r.ok) throw new Error(`Live stream HTTP ${r.status}`);
      const reader = r.body.getReader(), decoder = new TextDecoder(); let buffer = '';
      try {
        while (generation === this.generation) {
          const { value, done } = await reader.read(); if (done) break;
          buffer += decoder.decode(value, { stream: true }); if (buffer.length > 1000000) throw new Error('Live frame too large');
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            if (!block.startsWith('data: ')) continue;
            const frame = JSON.parse(block.slice(6)); lastPacket = performance.now();
            if (generation !== this.generation || frame.symbol !== this.symbol || String(frame.interval) !== this.interval) continue;
            if (this.session !== frame.sessionId) { this.session = frame.sessionId; this.bars.clear(); this.lastSequence = 0; }
            if (frame.sequence <= (this.lastSequence ?? 0)) continue;
            this.lastSequence = frame.sequence; this.connected = true; this.frame = frame;
            if (frame.barDelta) {
              if (frame.barDelta.reset) this.bars.clear();
              for (const ts of frame.barDelta.remove) this.bars.delete(ts);
              for (const bar of frame.barDelta.upsert) this.bars.set(bar.ts, bar);
              this.barList = [...this.bars.values()].sort((a, b) => a.ts - b.ts).slice(-240);
            }
            this.pending = frame;
            if (!this.paint) this.paint = requestAnimationFrame(() => {
              this.paint = null; if (generation !== this.generation || !this.pending) return;
              const f = this.pending; this.pending = null; const before = performance.now();
              this.onFrame(f); const after = performance.now(); this.record('draw', after - before);
              if (this.lastDraw != null) this.record('cadence', after - this.lastDraw); this.lastDraw = after;
              const c = this.calibration;
              if (c?.sessionId === f.sessionId && after - c.measured < 60000 && c.rtt < 1000) {
                this.deliveryUncertainty = Math.max(this.deliveryUncertainty ?? 0, c.rtt / 2);
                this.record('delivery', Math.max(0, after + c.offset - f.serverMono));
              }
            });
            this.onState('Live push · target 100 ms / 10 Hz');
            if (lastPacket - lastCalibration > 30000) { lastCalibration = lastPacket; void this.calibrate(generation).catch(() => {}); }
          }
        }
      } finally { await reader.cancel().catch(() => {}); }
    } catch { /* Dashboard polling remains available during a stream outage. */ }
    finally {
      if (generation === this.generation) {
        clearInterval(this.watchdog); this.connected = false; this.onState('Live stream disconnected · 2s polling fallback');
        this.retry = setTimeout(() => void this.connect(generation), 1000);
      }
    }
  }
  overlay(data) {
    const f = this.frame;
    if (!this.connected || !f || f.symbol !== data.symbol || String(f.interval) !== String(data.interval) || (data.serverMono ?? 0) > f.serverMono) return data;
    const fresh = f.quoteFresh && f.clockTrusted;
    const positionPnl = data.positionPnl && data.position ? { ...data.positionPnl, fresh, value: fresh ? (f.quote.bid - data.position.entryPrice) * data.position.qty : data.position.unrealized } : data.positionPnl;
    const quoteSeries = [...(data.quoteSeries ?? [])], q = f.quote;
    if (q && (!quoteSeries.length || q.ts >= quoteSeries.at(-1).ts)) {
      const point = { ts: q.ts, bid: q.bid, ask: q.ask };
      if (quoteSeries.length && Math.floor(q.ts / 100) === Math.floor(quoteSeries.at(-1).ts / 100)) quoteSeries[quoteSeries.length - 1] = point;
      else quoteSeries.push(point);
    }
    return { ...data, now: f.now, serverMono: f.serverMono, quote: f.quote, quoteFresh: fresh, positionPnl, quoteSeries: quoteSeries.slice(-600),
      ...(f.intervalMs < 60000 ? { bars: this.barList ?? [] } : {}) };
  }
}
