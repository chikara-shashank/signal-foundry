import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { chartData, performanceData } from './telemetry.js';
import { activityPage } from './observability.js';
import { createQuoteStream, intervalWidth } from './realtime.js';
import { jevTracePage, jevTraceDetail } from './jev-traces.js';

const files = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/jev-log.js', ['jev-log.js', 'text/javascript']], ['/live.js', ['live.js', 'text/javascript']], ['/chart.js', ['chart.js', 'text/javascript']], ['/operations.js', ['operations.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']], ['/chart.css', ['chart.css', 'text/css']], ['/operations.css', ['operations.css', 'text/css']]]);

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
      if (path === '/api/jev-traces' && req.method === 'GET') {
        const p = new URL(req.url, 'http://localhost').searchParams;
        return json(200, jevTracePage(engine, { symbol: p.get('symbol') ?? '', limit: Number(p.get('limit') ?? 40) }));
      }
      if (path === '/api/jev-trace' && req.method === 'GET') {
        const trace = jevTraceDetail(engine, new URL(req.url, 'http://localhost').searchParams.get('id'));
        return trace ? json(200, trace) : json(404, { error: 'Trace no longer retained' });
      }
      if (path === '/api/performance' && req.method === 'GET') return json(200, performanceData(engine, new URL(req.url, 'http://localhost').searchParams.get('scope') ?? undefined));
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
      if (['/api/control', '/api/paper-test', '/api/risk-settings'].includes(path) && req.method === 'POST') {
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return json(403, { error: 'Origin rejected' });
        if (!String(req.headers['content-type']).startsWith('application/json')) return json(415, { error: 'JSON required' });
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 1024) return json(413, { error: 'Request too large' }); }
        const request = JSON.parse(body);
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
