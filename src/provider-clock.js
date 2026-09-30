// Calibrate only from Alpaca's authenticated HTTPS /v2/clock response, never
// from a quote timestamp. Retain provider timestamps and the normal freshness gates.
export class ProviderClock {
  constructor({ wall = () => Date.now(), mono = () => performance.now() } = {}) {
    this.wall = wall; this.mono = mono; this.anchor = null; this.error = 'clock_not_synchronized';
  }
  now() {
    const candidate = this.anchor ? this.anchor.utc + this.mono() - this.anchor.mono : this.wall();
    // A small calibration adjustment must not run the trading clock backwards.
    if (this.anchor) this.last = Math.max(this.last ?? candidate, candidate);
    return this.anchor ? this.last : candidate;
  }
  observe(timestamp, started, ended = this.mono()) {
    const provider = Date.parse(timestamp), rtt = ended - started;
    const reject = reason => { this.error = reason; this.recovery = null; return false; };
    if (!Number.isFinite(provider)) return reject('invalid_provider_clock');
    if (!Number.isFinite(rtt) || rtt < 0 || rtt > 1000) return reject('provider_clock_request_too_slow');
    const utc = provider + rtt / 2, wall = this.wall(), sample = { utc, mono: ended, wall, rtt };
    if (Math.abs(utc - wall) > 300000) return reject('host_clock_skew_exceeds_five_minutes');
    const predicted = this.anchor ? this.anchor.utc + ended - this.anchor.mono : utc;
    if (Math.abs(utc - predicted) > 1000) {
      // Docker/host suspension can stop monotonic time while UTC keeps moving.
      // Never trust a single jump or move backwards: confirm a forward reset
      // with a separate, fresh provider read while entry checks remain blocked.
      const pending = this.recovery, elapsed = pending ? ended - pending.mono : 0;
      const confirmed = utc > predicted && utc >= (this.last ?? predicted) && pending && started >= pending.mono
        && elapsed >= 1000 && elapsed <= 60000
        && Math.abs(utc - (pending.utc + elapsed)) <= 1000
        && Math.abs(wall - pending.wall - elapsed) <= 1000;
      if (!confirmed) {
        reject('provider_clock_discontinuity');
        if (utc > predicted) this.recovery = sample;
        return false;
      }
    }
    this.anchor = sample; this.error = null; this.recovery = null;
    return true;
  }
  status() {
    const ageMs = this.anchor ? this.mono() - this.anchor.mono : null;
    // Check wall/monotonic elapsed time before the next reconciliation too.
    const elapsedJump = this.anchor && Math.abs(this.wall() - this.anchor.wall - ageMs) > 1000;
    const reason = this.error ?? (elapsedJump ? 'clock_elapsed_discontinuity' : ageMs > 60000 ? 'provider_clock_sample_expired' : null);
    return { synchronized: !!this.anchor && !reason, reason, source: 'Alpaca HTTPS /v2/clock + monotonic elapsed time',
      offsetMs: this.anchor ? Math.round(this.now() - this.wall()) : null, sampleAgeMs: ageMs,
      roundTripMs: this.anchor?.rtt ?? null, uncertaintyMs: this.anchor ? this.anchor.rtt / 2 + 1 : null };
  }
}
