import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { Store } from './store.js';
import { Workers } from './workers.js';
import { AlpacaBroker, SimBroker } from './broker.js';
import { Engine } from './engine.js';
import { AlpacaFeed, DemoFeed } from './feeds.js';
import { createDashboard } from './server.js';
import { sleep } from './util.js';
import { ProviderClock } from './provider-clock.js';
import { AlpacaOrderFeed } from './order-feed.js';

let cfg;
try { cfg = config(); } catch (e) { console.error(e.message); process.exit(1); }
const store = new Store(join(cfg.dataDir, `${cfg.mode}.sqlite`));
const workers = new Workers(cfg.strategies);
let demoTime = Math.max(Date.now(), store.get('demoClock', 0));
const timebase = cfg.mode === 'demo' ? null : new ProviderClock();
const venue = timebase ? new AlpacaBroker(cfg, fetch, timebase) : null;
const broker = ['demo', 'shadow'].includes(cfg.mode) ? new SimBroker(cfg, store) : venue;
const engine = new Engine(cfg, store, broker, workers, () => cfg.mode === 'demo' ? demoTime : timebase.now());
engine.timebase = timebase;
// Shadow uses real exchange session eligibility while retaining local capital.
if (cfg.mode === 'shadow') { broker.clock = now => venue.clock(now); broker.assets = () => venue.assets(); }
let feeds = [], server, quitting = false;
const shutdown = async () => {
  if (quitting) return; quitting = true; engine.stopped = true;
  for (const f of feeds) f.stop();
  server?.closeStreams?.(); server?.close(); clearInterval(watchdog); clearTimeout(engine.streamReconcile);
  const forced = setTimeout(() => process.exit(1), 10000); forced.unref();
  await engine.mutex.run(async () => { store.event('shutdown', { pending: engine.pending().length }); store.release(); });
  await workers.close(); store.close(); process.exit(0);
};
const watchdog = setInterval(() => {
  if (Date.now() - engine.lastLoop > 60000) { console.error('Engine watchdog expired; restarting required'); process.exit(1); }
}, 10000);
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
process.on('uncaughtException', () => { console.error('Fatal runtime error; state retained for reconciliation'); process.exit(1); });
process.on('unhandledRejection', () => { console.error('Fatal asynchronous error; state retained for reconciliation'); process.exit(1); });

try {
  // Bootstrap before restoring historical bars or stamping account state.
  if (venue) await venue.clock(timebase.now());
  await engine.init();
  server = createDashboard(engine, cfg);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(cfg.port, cfg.host, resolve); });
  console.log(JSON.stringify({ service: 'Signal Foundry', mode: cfg.mode, dashboard: `http://localhost:${cfg.port}`, token: 'read DASHBOARD_TOKEN in your .env', data: cfg.dataDir }));
  if (cfg.mode === 'demo') feeds = [new DemoFeed(cfg, engine, t => { demoTime = t; })];
  else {
    if (cfg.equities.length) feeds.push(new AlpacaFeed('equities', `wss://stream.data.alpaca.markets/v2/${cfg.feed}`, cfg.equities, cfg, engine));
    if (cfg.crypto.length) feeds.push(new AlpacaFeed('crypto', `wss://stream.data.alpaca.markets/v1beta3/crypto/${cfg.cryptoLocation}`, cfg.crypto, cfg, engine));
    if (['paper', 'live'].includes(cfg.mode)) feeds.push(new AlpacaOrderFeed(cfg, engine));
  }
  for (const f of feeds) void f.run();
  let lastBackup = 0, lastHeartbeat = 0;
  while (!quitting) {
    await sleep(5000); if (quitting) break;
    if (cfg.mode !== 'demo') await engine.reconcile();
    if (cfg.heartbeatUrl && Date.now() - lastHeartbeat > 60000 && engine.healthyForHeartbeat()) {
      lastHeartbeat = Date.now();
      // An external dead-man monitor must alert when these success pings stop.
      void fetch(cfg.heartbeatUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000) }).catch(() => {});
    }
    if (Date.now() - lastBackup > 86400000) {
      const dir = join(cfg.dataDir, 'backups'); mkdirSync(dir, { recursive: true });
      await store.backup(join(dir, `${cfg.mode}-${new Date().toISOString().slice(0, 10)}.sqlite`));
      const files = readdirSync(dir).filter(x => x.startsWith(`${cfg.mode}-`) && x.endsWith('.sqlite')).sort();
      for (const file of files.slice(0, -7)) unlinkSync(join(dir, file));
      store.prune(engine.clock() - cfg.retentionDays * 86400000); lastBackup = Date.now();
    }
  }
} catch (e) {
  console.error(/^Asset unavailable|^Live account|^Database belongs|^Another engine/.test(e.message) ? e.message : 'Startup failed; check provider credentials, entitlement, network, port, and data permissions using npm run doctor');
  await workers.close(); store.release(); store.close(); clearInterval(watchdog); process.exit(1);
}
