import { Worker } from 'node:worker_threads';
import { STRATEGIES } from './strategies.js';

export class Workers {
  sequence = 0;
  constructor(strategies = STRATEGIES, { restartBaseMs = 250, maxRestarts = 5, factory } = {}) {
    this.stopping = false; this.restartBaseMs = restartBaseMs; this.maxRestarts = maxRestarts;
    this.factory = factory ?? (strategy => new Worker(new URL('./strategy-worker.js', import.meta.url), { workerData: { strategy } }));
    this.workers = strategies.map(strategy => {
      return { strategy, pending: new Map(), alive: false, evaluated: 0, matched: 0, noSetup: 0, errors: 0, restarts: 0 };
    });
    for (const slot of this.workers) this.start(slot);
  }
  start(slot) {
      if (this.stopping) return;
      let worker;
      const fail = () => {
        if (worker && slot.worker !== worker) return;
        if (slot.failed || this.stopping) return;
        slot.failed = true; slot.alive = false; slot.errors++;
        for (const p of slot.pending.values()) { clearTimeout(p.timer); p.reject(new Error('worker_unavailable')); } slot.pending.clear();
        if (slot.restarts < this.maxRestarts) {
          const delay = Math.min(30000, this.restartBaseMs * 2 ** slot.restarts++);
          slot.restartAt = Date.now() + delay; slot.restartTimer = setTimeout(() => this.start(slot), delay); slot.restartTimer.unref?.();
        } else slot.restartAt = null;
      };
      slot.failed = false; slot.restartAt = null;
      try { worker = this.factory(slot.strategy); slot.worker = worker; slot.alive = true; } catch { fail(); return; }
      worker.on('message', result => {
        const p = slot.pending.get(result.id); if (!p) return;
        clearTimeout(p.timer); slot.pending.delete(result.id);
        if (result.error) { slot.errors++; p.reject(new Error(result.error)); }
        else {
          slot.evaluated++; if (result.candidate) slot.matched++; else slot.noSetup++;
          try { this.onEvaluation?.({ ...result.assessment, latencyMs: performance.now() - p.started }); }
          catch { p.reject(new Error('evaluation_audit_failed')); return; }
          p.resolve(result.candidate);
        }
      });
      worker.once('error', fail); worker.once('exit', fail);
  }
  async evaluate(features, now, strategies = STRATEGIES) {
    const results = await Promise.allSettled(this.workers.filter(slot => strategies.includes(slot.strategy)).map(slot => new Promise((resolve, reject) => {
      if (!slot.alive || slot.pending.size >= 100) return reject(new Error('worker_queue_full'));
      const id = ++this.sequence;
      const timer = setTimeout(() => { slot.pending.delete(id); slot.errors++; reject(new Error('worker_timeout')); void slot.worker.terminate(); }, 2000);
      slot.pending.set(id, { resolve, reject, timer, started: performance.now() });
      try { slot.worker.postMessage({ id, features, now }); } catch { clearTimeout(timer); slot.pending.delete(id); reject(new Error('worker_unavailable')); void slot.worker.terminate(); }
    })));
    return results.filter(r => r.status === 'fulfilled').map(r => r.value).filter(Boolean).sort((a, b) => b.priority - a.priority || a.strategy.localeCompare(b.strategy));
  }
  status() { return this.workers.map(x => ({ strategy: x.strategy, alive: x.alive, pending: x.pending.size, evaluated: x.evaluated, matched: x.matched, noSetup: x.noSetup, errors: x.errors, restarts: x.restarts, restartAt: x.restartAt })); }
  async close() {
    this.stopping = true;
    for (const slot of this.workers) { clearTimeout(slot.restartTimer); for (const p of slot.pending.values()) { clearTimeout(p.timer); p.reject(new Error('worker_stopped')); } slot.pending.clear(); slot.alive = false; }
    await Promise.allSettled(this.workers.map(x => x.worker?.terminate()));
  }
}
