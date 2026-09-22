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
    const reject = reason => { this.error = reason; return false; };
    if (!Number.isFinite(provider)) return reject('invalid_provider_clock');
    if (!Number.isFinite(rtt) || rtt < 0 || rtt > 1000) return reject('provider_clock_request_too_slow');
    const utc = provider + rtt / 2;
    if (Math.abs(utc - this.wall()) > 300000) return reject('host_clock_skew_exceeds_five_minutes');
    if (this.anchor && Math.abs(utc - (this.anchor.utc + ended - this.anchor.mono)) > 1000) return reject('provider_clock_discontinuity');
    this.anchor = { utc, mono: ended, rtt }; this.error = null;
    return true;
  }
  status() {
    const ageMs = this.anchor ? this.mono() - this.anchor.mono : null;
    const reason = this.error ?? (ageMs > 60000 ? 'provider_clock_sample_expired' : null);
    return { synchronized: !!this.anchor && !reason, reason, source: 'Alpaca HTTPS /v2/clock + monotonic elapsed time',
      offsetMs: this.anchor ? Math.round(this.now() - this.wall()) : null, sampleAgeMs: ageMs,
      roundTripMs: this.anchor?.rtt ?? null, uncertaintyMs: this.anchor ? this.anchor.rtt / 2 + 1 : null };
  }
}
