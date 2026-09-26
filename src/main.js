import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { Store } from './store.js';
import { Workers } from './workers.js';
import { AlpacaBroker, SimBroker } from './broker.js';
import { Engine } from './engine.js';
import { AlpacaFeed, DemoFeed } from './feeds.js';
import { createDashboard } from './server.js';
import { sleep, isCrypto } from './util.js';
import { ProviderClock } from './provider-clock.js';
import { AlpacaOrderFeed } from './order-feed.js';
import { CryptoContext } from './crypto-context.js';
import { StockHistory } from './stock-history.js';
import { NoiseArea } from './noise-area.js';
import { VwapTrend } from './vwap-trend.js';
import { MonthlyTrend } from './monthly-trend.js';
import { DailyHistory } from './daily-history.js';
import { WORKER_STRATEGIES, noiseUnavailable } from './strategy-registry.js';
import { OptionsData } from './options-data.js';
import { OptionsLab } from './options-lab.js';
import { RELEASE } from './release.js';
import { createBackup } from './recovery.js';
import { accountWriterLock } from './account-writer-lock.js';
import { EquityUniverse } from './equity-universe.js';
import { MarketSchedule } from './market-schedule.js';
import { CryptoUniverse } from './crypto-universe.js';
import { ResearchDesk } from './research-desk.js';

let cfg;
try { cfg = config(); } catch (e) { console.error(e.message); process.exit(1); }
const store = new Store(join(cfg.dataDir, `${cfg.mode}.sqlite`));
const workers = new Workers(WORKER_STRATEGIES);
let demoTime = Math.max(Date.now(), store.get('demoClock', 0));
const timebase = cfg.mode === 'demo' ? null : new ProviderClock();
const venue = timebase ? new AlpacaBroker(cfg, fetch, timebase) : null;
const broker = ['demo', 'shadow'].includes(cfg.mode) ? new SimBroker(cfg, store) : venue;
const engine = new Engine(cfg, store, broker, workers, () => cfg.mode === 'demo' ? demoTime : timebase.now());
// Disabling new crypto entries must not strand already-owned positions.
if(cfg.cryptoUniverse==='off') {
  cfg.crypto=[...new Set([...Object.keys(engine.managed),...engine.pending().map(o=>o.symbol)])].filter(isCrypto);
  cfg.symbols=[...cfg.equities,...cfg.crypto];engine.realtime.trades.setSymbols(cfg.symbols);
}
if(cfg.universe.mode==='all'){engine.universe=new EquityUniverse(engine);engine.universe.restore();}
engine.timebase = timebase;
if(venue) {
  engine.schedule=new MarketSchedule(engine,venue);
  if(cfg.cryptoUniverse==='top25'){engine.cryptoUniverse=new CryptoUniverse(engine,venue);engine.cryptoUniverse.restore();}
  engine.desk=new ResearchDesk(engine);
}
engine.optionsLab = new OptionsLab(engine, ['paper', 'shadow'].includes(cfg.mode) ? new OptionsData({...cfg,canRead:()=>engine.schedule?.state().equityTracking??true}) : null);
const cryptoContext = cfg.mode === 'demo' ? null : new CryptoContext(engine);
engine.cryptoContext=cryptoContext;
if (cfg.mode !== 'demo') engine.stockHistory = new StockHistory(engine);
if (!noiseUnavailable(cfg)) engine.noiseArea = new NoiseArea(engine, venue, engine.stockHistory);
if (['paper', 'shadow'].includes(cfg.mode)) engine.vwapTrend = new VwapTrend(engine, engine.stockHistory);
if (['paper', 'shadow'].includes(cfg.mode)) engine.monthlyTrend = new MonthlyTrend(engine, new DailyHistory({...cfg,canRead:()=>engine.schedule?.state().equityTracking??false}));
// Shadow uses real exchange session eligibility while retaining local capital.
if (cfg.mode === 'shadow') { broker.clock = now => venue.clock(now); broker.assets = () => venue.assets(); }
let feeds = [], server, quitting = false, accountLock;
const background = new Set();
const launch = promise => { background.add(promise); void promise.then(()=>background.delete(promise),()=>background.delete(promise)); };
const shutdown = async () => {
  if (quitting) return; quitting = true; engine.stopped = true;
  for (const f of feeds) f.stop();
  server?.closeStreams?.(); server?.close(); clearInterval(watchdog); clearTimeout(engine.streamReconcile);
  const forced = setTimeout(() => process.exit(1), 10000); forced.unref();
  await Promise.allSettled([...background]);
  await workers.close();
  while(engine.pendingCandidates>0)await sleep(50);
  await engine.mutex.run(async () => { store.event('shutdown', { pending: engine.pending().length }); store.release(); });
  store.close(); await accountLock?.close(); process.exit(0);
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
  if (['paper','live'].includes(cfg.mode)) accountLock=await accountWriterLock((await venue.account(timebase.now())).id,cfg.mode);
  await engine.init();
  await engine.schedule?.poll();
  await engine.cryptoUniverse?.poll(true);
  if(engine.schedule?.state().equityTracking)await engine.universe?.primeWatchlist();
  // Restore recent provider minute bars before streaming so a restart is not blind for 30+ minutes.
  await engine.stockHistory?.warmup();
  server = createDashboard(engine, cfg);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(cfg.port, cfg.host, resolve); });
  console.log(JSON.stringify({ service: 'Signal Foundry', mode: cfg.mode, dashboard: `http://localhost:${cfg.port}`, token: 'read DASHBOARD_TOKEN in your .env', data: cfg.dataDir }));
  if (cfg.mode === 'demo') feeds = [new DemoFeed(cfg, engine, t => { demoTime = t; })];
  else {
    if (cfg.equities.length||engine.universe) {
      const equityFeed=new AlpacaFeed('equities', `wss://stream.data.alpaca.markets/v2/${cfg.feed}`, cfg.equities, cfg, engine);
      equityFeed.setStreaming(engine.schedule.state().equityTracking);
      feeds.push(equityFeed);if(engine.universe)engine.universe.feed=equityFeed;
    }
    if (cfg.crypto.length||engine.cryptoUniverse) {
      const cryptoFeed=new AlpacaFeed('crypto', `wss://stream.data.alpaca.markets/v1beta3/crypto/${cfg.cryptoLocation}`, cfg.crypto, cfg, engine);
      feeds.push(cryptoFeed);if(engine.cryptoUniverse)engine.cryptoUniverse.feed=cryptoFeed;
    }
    if (['paper', 'live'].includes(cfg.mode)) feeds.push(new AlpacaOrderFeed(cfg, engine));
  }
  for (const f of feeds) void f.run();
  if (cryptoContext) launch(cryptoContext.poll());
  launch(engine.optionsLab.tape.flush());
  let lastBackup = 0, lastBackupAttempt = 0, lastHeartbeat = 0;
  while (!quitting) {
    await sleep(5000); if (quitting) break;
    engine.lastLoop=Date.now();
    if(engine.schedule) {
      launch(engine.schedule.poll());
      const feed=feeds.find(f=>f.name==='equities'),active=engine.schedule.state().equityTracking;
      if(feed&&feed.scheduled!==active) {
        if(active){await engine.universe?.primeWatchlist();launch(engine.stockHistory?.warmup()??Promise.resolve());}
        feed.setStreaming(active);
      }
    }
    if (cfg.mode !== 'demo'&&Date.now()-engine.lastReconcile>=(engine.schedule?.reconciliationInterval()??5000)) { const task=engine.reconcile(); launch(task); await task; } if(quitting)break;
    if (engine.noiseArea) { const task=engine.noiseArea.tick(engine.clock()).catch(() => engine.fail('noise_area_failure'));launch(task);await task; } if(quitting)break;
    if (cryptoContext) launch(cryptoContext.poll());
    launch(engine.optionsLab.poll());
    launch(engine.optionsLab.tape.flush());
    launch(engine.accounting.poll());
    if(engine.universe)launch(engine.universe.poll());
    if(engine.cryptoUniverse)launch(engine.cryptoUniverse.poll());
    if(engine.desk)launch(engine.desk.poll());
    if (cfg.heartbeatUrl && Date.now() - lastHeartbeat > 60000 && engine.healthyForHeartbeat()) {
      lastHeartbeat = Date.now();
      // An external dead-man monitor must alert when these success pings stop.
      void fetch(cfg.heartbeatUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000) }).catch(() => {});
    }
    if (Date.now() - lastBackup > 86400000 && Date.now()-lastBackupAttempt>300000) {
      lastBackupAttempt=Date.now();
      try {
      const dir = join(cfg.dataDir, 'backups'); mkdirSync(dir, { recursive: true });
      const task=createBackup(store,join(dir, `${cfg.mode}-${new Date().toISOString().slice(0, 10)}.sqlite`),{release:RELEASE,exportDir:cfg.backupDir});
      launch(task);await task;if(quitting)break;
      const files = readdirSync(dir).filter(x => x.startsWith(`${cfg.mode}-`) && x.endsWith('.sqlite')).sort();
      for (const file of files.slice(0, -7)) { unlinkSync(join(dir, file));try{unlinkSync(join(dir,file+'.manifest.json'));}catch{} }
      store.prune(engine.clock() - cfg.retentionDays * 86400000); lastBackup = Date.now();
      store.set('backupStatus',{at:lastBackup,verified:true,exportConfigured:!!cfg.backupDir,error:null});
      } catch { if(!quitting){store.set('backupStatus',{at:Date.now(),verified:false,exportConfigured:!!cfg.backupDir,error:'backup_or_export_failed'});store.event('backup_failed',{});} }
    }
  }
} catch (e) {
  console.error(/^Asset unavailable|^Live account|^Database belongs|^Another engine/.test(e.message) ? e.message : 'Startup failed; check provider credentials, entitlement, network, port, and data permissions using npm run doctor');
  engine.stopped=true;await Promise.allSettled([...background]);await workers.close(); store.release(); store.close(); await accountLock?.close(); clearInterval(watchdog); process.exit(1);
}
