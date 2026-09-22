import { Worker } from 'node:worker_threads';
import { STRATEGIES } from './strategies.js';

export class Workers {
  sequence = 0;
  constructor(strategies = STRATEGIES) {
    this.workers = strategies.map(strategy => {
      const worker = new Worker(new URL('./strategy-worker.js', import.meta.url), { workerData: { strategy } });
      const slot = { strategy, worker, pending: new Map(), alive: true, evaluated: 0, matched: 0, noSetup: 0, errors: 0 };
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
      const fail = () => { slot.alive = false; for (const p of slot.pending.values()) { clearTimeout(p.timer); p.reject(new Error('worker_unavailable')); } slot.pending.clear(); };
      worker.on('error', fail); worker.on('exit', fail);
      return slot;
    });
  }
  async evaluate(features, now, strategies = STRATEGIES) {
    const candidates = await Promise.all(this.workers.filter(slot => strategies.includes(slot.strategy)).map(slot => new Promise((resolve, reject) => {
      if (!slot.alive || slot.pending.size >= 100) return reject(new Error('worker_queue_full'));
      const id = ++this.sequence;
      const timer = setTimeout(() => { slot.pending.delete(id); slot.errors++; reject(new Error('worker_timeout')); }, 2000);
      slot.pending.set(id, { resolve, reject, timer, started: performance.now() });
      slot.worker.postMessage({ id, features, now });
    })));
    return candidates.filter(Boolean).sort((a, b) => b.priority - a.priority || a.strategy.localeCompare(b.strategy));
  }
  status() { return this.workers.map(x => ({ strategy: x.strategy, alive: x.alive, pending: x.pending.size, evaluated: x.evaluated, matched: x.matched, noSetup: x.noSetup, errors: x.errors })); }
  async close() { await Promise.all(this.workers.map(x => x.worker.terminate())); }
}
