export const MINUTE = 60000;

/** Tick spacing never falls below one minute, including a short trade. */
export function minuteTicks(from, to, width) {
  const target = (to - from) / Math.max(1, Math.floor(width / 120));
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 240, 360, 720, 1440, 2880, 10080, 43200];
  const step = (steps.find(n => n * MINUTE >= target) ?? 43200) * MINUTE;
  const ticks = [];
  for (let ts = Math.ceil(from / step) * step; ts <= to; ts += step) ticks.push(ts);
  return ticks;
}

export class ReturnViewport {
  reset() { this.window = null; }
  resolve(from, to) {
    this.bounds = { from: Math.floor(from / MINUTE) * MINUTE, to: Math.max(Math.floor(from / MINUTE) * MINUTE + MINUTE, Math.ceil(to / MINUTE) * MINUTE) };
    if (!this.window) return this.bounds;
    const span = Math.min(this.window.to - this.window.from, this.bounds.to - this.bounds.from);
    const start = Math.max(this.bounds.from, Math.min(this.window.from, this.bounds.to - span));
    return this.window = { from: start, to: start + span };
  }
  zoom(factor) {
    if (!this.bounds) return;
    const current = this.window ?? this.bounds, span = Math.max(MINUTE, Math.min(this.bounds.to - this.bounds.from, (current.to - current.from) * factor));
    const center = (current.from + current.to) / 2;
    this.window = { from: center - span / 2, to: center + span / 2 };
    this.resolve(this.bounds.from, this.bounds.to);
  }
  latestMinute() {
    if (this.bounds) this.window = { from: this.bounds.to - MINUTE, to: this.bounds.to };
  }
  pan(direction) {
    if (!this.bounds) return;
    const current = this.window ?? this.bounds, shift = (current.to - current.from) * .75 * direction;
    this.window = { from: current.from + shift, to: current.to + shift };
    this.resolve(this.bounds.from, this.bounds.to);
  }
}
