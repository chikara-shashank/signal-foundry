import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { chartData, performanceData } from './telemetry.js';
import { tradePerformanceData } from './trade-performance.js';
import { activityPage } from './observability.js';
import { createQuoteStream, intervalWidth } from './realtime.js';
import { jevTracePage, jevTraceDetail } from './jev-traces.js';

// Explicit public asset registry: private source, journals and .env are never served.
const scripts = [
  'app', 'chart', 'live', 'operations', 'jev-log', 'strategy-controls', 'options-lab',
  'discovery', 'session-research', 'research-context-view', 'trade-performance', 'dashboard-format',
  'dashboard-tabs', 'dashboard-controls', 'dashboard-status', 'account-performance', 'research-results',
  'return-format', 'return-timeline', 'trade-return-chart', 'crypto-signals',
  'design-catalog', 'dashboard-design', 'performance-panels', 'chart-palette',
];
const styles = ['style', 'chart', 'operations', 'strategy-controls', 'trade-performance', 'session-research', 'dashboard-tabs', 'dashboard-designs'];
const files = new Map([
  ['/', ['index.html', 'text/html']],
  ...scripts.map(name => [`/${name}.js`, [`${name}.js`, 'text/javascript']]),
  ...styles.map(name => [`/${name}.css`, [`${name}.css`, 'text/css']]),
]);

export function createDashboard(engine, cfg) {
  const token = Buffer.from(cfg.token);
  const stream = createQuoteStream(engine);
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    const path = (req.url ?? '/').split('?')[0];
    try {
      if (path === '/healthz' && req.method === 'GET') return json(Date.now() - engine.lastLoop < 60000 ? 200 : 503, { alive: Date.now() - engine.lastLoop < 60000 });
      if (req.method === 'GET' && files.has(path)) {
        const [name, type] = files.get(path); const body = await readFile(new URL(`../public/${name}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': type }); return res.end(body);
      }
      const supplied = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (supplied.length !== token.length || !timingSafeEqual(supplied, token)) return json(401, { error: 'Authentication required' });
      if (path === '/api/clock' && req.method === 'GET') return json(200, { sessionId: String(engine.startedAt), serverMono: performance.now() });
      if (path === '/api/stream' && req.method === 'GET') {
        const p = new URL(req.url, 'http://localhost').searchParams, symbol = p.get('symbol'), interval = p.get('interval') ?? '1';
        if (!cfg.symbols.includes(symbol) || !intervalWidth(interval)) return json(400, { error: 'Invalid stream selection' });
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return json(403, { error: 'Origin rejected' });
        return stream.open(req, res, symbol, interval);
      }
      if (path === '/api/status' && req.method === 'GET') return json(200, engine.status());
      if (path === '/api/session-research' && req.method === 'GET') return json(200,{now:engine.clock(),mode:cfg.mode,schedule:engine.schedule?.state()??null,crypto:engine.cryptoUniverse?.status()??{mode:cfg.cryptoUniverse},desk:engine.desk?.snapshot()??null,researchContext:engine.researchContext.snapshot()});
      if (path === '/api/research-context' && req.method === 'GET') return json(200,engine.researchContext.snapshot());
      if (path === '/api/accounting' && req.method === 'GET') return json(200, engine.accounting.snapshot());
      if (path === '/api/incidents' && req.method === 'GET') return json(200, Object.values(engine.store.get('executionIncidents',{})));
      if (path === '/api/readiness' && req.method === 'GET') { const s=engine.status();return json(s.protection.healthy?200:503,{alive:Date.now()-engine.lastLoop<60000,entryReady:s.entryReady,entryBlockers:s.entryBlockers,protection:s.protection}); }
      if (path === '/api/strategies' && req.method === 'GET') {
        const p = new URL(req.url,'http://localhost').searchParams, filter = {};
        if (p.has('experimentId')) { if (!/^(legacy|[a-f0-9]{64})$/.test(p.get('experimentId'))) return json(400,{error:'Invalid experiment ID'}); filter.experimentId=p.get('experimentId'); }
        for (const k of ['from','to']) if (p.has(k)) { const v=p.get(k); if (!/^\d{4}-\d\d-\d\d$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0,10)!==v) return json(400,{error:'Use valid YYYY-MM-DD dates'}); filter[k]=Date.parse(v); }
        if (filter.from && filter.to && filter.from>=filter.to) return json(400,{error:'End date must follow start date'});
        return json(200, engine.strategyControls.snapshot(filter));
      }
      if (path === '/api/options' && req.method === 'GET') return engine.optionsLab ? json(200, engine.optionsLab.snapshot()) : json(503, { error: 'Options research is not initialized' });
      if (path === '/api/research' && req.method === 'GET') return json(200, engine.research());
      if (path === '/api/jev-traces' && req.method === 'GET') {
        const p = new URL(req.url, 'http://localhost').searchParams;
        return json(200, jevTracePage(engine, { symbol: p.get('symbol') ?? '', limit: Number(p.get('limit') ?? 40) }));
      }
      if (path === '/api/jev-trace' && req.method === 'GET') {
        const trace = jevTraceDetail(engine, new URL(req.url, 'http://localhost').searchParams.get('id'));
        return trace ? json(200, trace) : json(404, { error: 'Trace no longer retained' });
      }
      if (path === '/api/performance' && req.method === 'GET') return json(200, performanceData(engine, new URL(req.url, 'http://localhost').searchParams.get('scope') ?? undefined));
      if (path === '/api/trade-performance' && req.method === 'GET') {
        const p = new URL(req.url, 'http://localhost').searchParams;
        return json(200, tradePerformanceData(engine, Number(p.get('days') ?? 1), Number(p.get('interval') ?? 1)));
      }
      if (path === '/api/insights' && req.method === 'GET') {
        const symbol = new URL(req.url, 'http://localhost').searchParams.get('symbol');
        if (!cfg.symbols.includes(symbol)) return json(400, { error: 'Choose a configured symbol' });
        return json(200, engine.observability.snapshot(symbol));
      }
      if (path === '/api/activity' && req.method === 'GET') {
        const p = new URL(req.url, 'http://localhost').searchParams;
        return json(200, activityPage(engine, { after: Number(p.get('after') ?? 0), category: p.get('category') ?? 'all', symbol: p.get('symbol') ?? '', limit: Number(p.get('limit') ?? 100) }));
      }
      if (path === '/api/chart' && req.method === 'GET') {
        const params = new URL(req.url, 'http://localhost').searchParams;
        const symbol = params.get('symbol'), raw = params.get('interval') ?? '1', interval = raw.endsWith('s') ? raw : Number(raw);
        if (!cfg.symbols.includes(symbol) || !intervalWidth(interval)) return json(400, { error: 'Choose a configured symbol and supported candle interval' });
        return json(200, chartData(engine, symbol, interval));
      }
      if (path === '/api/metrics' && req.method === 'GET') {
        const s = engine.status(); res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end(`signal_foundry_ready ${Number(s.ready)}\nsignal_foundry_paused ${Number(s.paused)}\nsignal_foundry_equity_usd ${s.account?.equity ?? 0}\nsignal_foundry_daily_pnl_usd ${s.dailyPnl}\nsignal_foundry_model_spend_usd ${s.jev.spent}\nsignal_foundry_open_positions ${s.positions.length}\n`);
      }
      if (['/api/control', '/api/paper-test', '/api/risk-settings', '/api/strategy-settings', '/api/options-settings', '/api/options-experiment'].includes(path) && req.method === 'POST') {
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return json(403, { error: 'Origin rejected' });
        if (!String(req.headers['content-type']).startsWith('application/json')) return json(415, { error: 'JSON required' });
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 1024) return json(413, { error: 'Request too large' }); }
        const request = JSON.parse(body);
        if (path === '/api/options-settings' || path === '/api/options-experiment') {
          if (!engine.optionsLab) return json(503, { error: 'Options research is not initialized' });
          try { return json(200, await (path === '/api/options-experiment' ? engine.optionsLab.restartExperiment(request) : engine.optionsLab.update(request))); }
          catch (error) { if ([400, 409].includes(error.status)) return json(error.status, { error: error.message }); throw error; }
        }
        if (path === '/api/strategy-settings') {
          try { return json(200, await engine.strategyControls.update(request)); }
          catch (error) { if ([400, 409].includes(error.status)) return json(error.status, { error: error.message }); throw error; }
        }
        if (path === '/api/risk-settings') {
          try { return json(200, await engine.updateRiskSettings(request)); }
          catch (error) { if ([400, 409].includes(error.status)) return json(error.status, { error: error.message }); throw error; }
        }
        if (path === '/api/paper-test') {
          if (cfg.mode !== 'paper') return json(403, { error: 'Paper tests are only available in MODE=paper' });
          if (request.confirmation !== 'PAPER_MONEY_ONLY') return json(400, { error: 'Paper test acknowledgment required' });
          const result = await engine.paperTest(request.symbol, request.requestId);
          return json(202, { candidateId: result.id, status: result.status, reason: result.reason, orderId: result.orderId });
        }
        const { action, confirmation } = request;
        if (!['pause', 'resume', 'cancel_entries', 'flatten'].includes(action)) return json(400, { error: 'Invalid action' });
        if (action === 'flatten' && confirmation !== 'FLATTEN_MANAGED_POSITIONS') return json(400, { error: 'Flatten confirmation required' });
        await engine.control(action); return json(202, { accepted: true, action });
      }
      return json(404, { error: 'Not found' });
    } catch { if (!res.headersSent) json(400, { error: 'Request failed' }); else res.end(); }
  });
  server.closeStreams = () => stream.close();
  server.on('close', () => stream.close());
  return server;
}
