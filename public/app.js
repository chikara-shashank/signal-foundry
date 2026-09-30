import { DashboardDesign } from './dashboard-design.js';
import { PerformancePanels } from './performance-panels.js';
import { DashboardControls } from './dashboard-controls.js';
import { AccountPerformanceView } from './account-performance.js';
import { ResearchResultsView } from './research-results.js';
import { renderStatus } from './dashboard-status.js';
import { DashboardTabs } from './dashboard-tabs.js';
import { TradingChart } from './chart.js';
import { OperationsView } from './operations.js';
import { LiveQuotes } from './live.js';
import { JevLog } from './jev-log.js';
import { StrategyControlsView } from './strategy-controls.js';
import { OptionsLabView } from './options-lab.js';
import { DiscoveryView } from './discovery.js';
import { TradePerformanceView } from './trade-performance.js';
import { SessionResearchView } from './session-research.js';
import { TradeAlternativesView } from './trade-alternatives.js';
import { PaperRoutesView } from './paper-routes.js';
import { $, money, number, quotePrice, time, escape, label } from './dashboard-format.js';
let token = '', busy = false, selectedSymbol = '', selectedInterval = 1, latestStatus = null, latestChart = null, chartSequence = 0, selectedEvent = null, session = 0;
async function api(path, body) {
  const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
  if (!r.ok) { const error = await r.json().catch(() => ({})); throw new Error(r.status === 401 ? 'Token rejected. Check your .env file.' : error.error ?? `Request failed (${r.status})`); }
  return r.json();
}
new DashboardDesign();
const performancePanels = new PerformancePanels();
const chart = new TradingChart($('price-chart'), $('chart-tooltip'), inspectEvent);
const accountPerformance = new AccountPerformanceView(api);
const researchResults = new ResearchResultsView(api);
const operations = new OperationsView(api);
const jevLog = new JevLog(api);
const strategyControls = new StrategyControlsView(api);
const optionsLab = new OptionsLabView(api);
const discovery = new DiscoveryView();
const sessionResearch = new SessionResearchView(api);
const tradeAlternatives = new TradeAlternativesView(api);
const paperRoutes = new PaperRoutesView(api);
const tradePerformance = new TradePerformanceView(api);
const controls = new DashboardControls(api, refresh, () => selectedSymbol, () => { accountPerformance.last = 0; });
const tabs = new DashboardTabs(() => {
  performancePanels.show(tabs.active);
  if (tabs.active !== 'live') live.stop();
  if (busy) refreshPending = true;
  void refresh();
});
performancePanels.show(tabs.active);
let refreshPending = false;
let lastStreamEvent = null, lastEventRefresh = 0, lastTimingRender = 0;
const live = new LiveQuotes(frame => {
  if (!latestChart || frame.symbol !== selectedSymbol || String(frame.interval) !== String(selectedInterval)) return;
  latestChart = live.overlay(latestChart); renderLivePrice(latestChart);
  if (lastStreamEvent != null && frame.eventVersion !== lastStreamEvent && performance.now() - lastEventRefresh > 1000) { lastEventRefresh = performance.now(); void refresh(); }
  lastStreamEvent = frame.eventVersion;
  if (performance.now() - lastTimingRender > 1000) { lastTimingRender = performance.now(); renderTimings(); }
}, message => { $('push-state').textContent = message; });
const intervalLabel = interval => String(interval).endsWith('s') ? interval : `${interval}m`;
function renderTimings() {
  const t = latestStatus?.timings ?? {}, browser = live.stats(), ms = n => !Number.isFinite(n) ? '—' : `${n.toFixed(1)} ms`;
  const deliveryRange = n => !Number.isFinite(n) || browser.uncertainty == null ? '—' : `${Math.max(0, n - browser.uncertainty).toFixed(0)}–${Math.ceil(n + browser.uncertainty)} ms`;
  const cards = [['Feed age at receipt ≈', t.feed], ['Dispatch → draw ≈', browser.delivery], ['Canvas update', browser.draw], ['Strategy worker', t.strategy], ['Jev HTTP attempt', t.jev], ['Broker HTTP acknowledgment', t.orderAck]];
  $('latency-cards').innerHTML = cards.map(([name, v], i) => `<div><span>${name}</span><strong>${i === 1 ? deliveryRange(v?.p50) : ms(v?.p50)}</strong><small>p95 ${i === 1 ? deliveryRange(v?.p95) : ms(v?.p95)} · ${v?.samples ?? 0} samples</small></div>`).join('');
  $('latency-note').textContent = `Median / p95 of the last up to 1,000 backend samples or 120 browser frames. Push cadence: ${ms(browser.cadence.p50)} median, ${ms(browser.cadence.p95)} p95. Feed-clock uncertainty ≈ ${ms(latestStatus?.diagnostics?.clock?.uncertaintyMs ?? null)}; browser clock calibration ≈ ±${ms(browser.uncertainty)}. Delivery ends at canvas drawing, before physical screen presentation. Broker acknowledgment is not a fill. No observation means —.`;
}
function renderLivePrice(data) {
  chart.emptyMessage = null; chart.update(data);
  const q = data.quote, diag = latestStatus?.diagnostics?.symbols.find(x => x.symbol === selectedSymbol);
  $('chart-price').textContent = q ? quotePrice((q.bid + q.ask) / 2) : data.bars.length ? quotePrice(data.bars.at(-1).close) : '—';
  $('chart-reference-label').textContent = q ? 'MIDPOINT · REFERENCE PRICE' : 'LAST CANDLE PRICE';
  $('chart-quote').textContent = q ? `${diag?.source ?? 'Provider'} · ${time(q.ts)} · ${((data.now-q.ts)/1000).toFixed(2)}s age · ${data.quoteFresh ? 'fresh' : 'UNUSABLE'}` : 'Waiting for an accepted quote';
  $('quote-bid').textContent = q ? quotePrice(q.bid) : '—'; $('quote-ask').textContent = q ? quotePrice(q.ask) : '—';
  $('quote-spread').textContent = q ? `${quotePrice(q.ask - q.bid)} · ${((q.ask - q.bid) / q.ask * 10000).toFixed(1)} bps` : '—';
  $('chart-summary').textContent = `${data.bars.length} ${data.intervalMs < 60000 ? 'trade-print' : 'provider'} candles · ${intervalLabel(selectedInterval)} · ${live.connected ? '100 ms push target' : '2s polling fallback'}`;
  const p = data.position;
  if (p && q && data.quoteFresh) {
    const pnl = ((p.qty < 0 ? q.ask : q.bid) - p.entryPrice) * p.qty;
    $('position-pnl').textContent = money(pnl); $('position-pnl').className = pnl >= 0 ? 'positive' : 'negative';
    $('position-pnl-basis').textContent = `${number(p.qty)} last reconciled quantity · live ${p.qty < 0 ? 'ask' : 'bid'} mark, before exit fees${data.positionPnl?.external ? ' · external holding' : ''}`;
  } else {
    $('position-pnl').textContent = p ? money(p.unrealized) : '—'; $('position-pnl').className = p ? p.unrealized >= 0 ? 'positive' : 'negative' : 'muted';
    $('position-pnl-basis').textContent = p ? 'Last broker mark · waiting for a usable quote' : 'No open position in this instrument';
  }
}
function updateTape(markup) {
  const tape = $('trade-tape'), template = document.createElement('template'); template.innerHTML = markup;
  const existing = new Map([...tape.children].filter(n => n.dataset.event).map(n => [n.dataset.event, n]));
  const next = [...template.content.children];
  next.forEach((node, index) => {
    const prior = existing.get(node.dataset.event), keep = prior ?? node;
    if (prior && prior.innerHTML !== node.innerHTML) prior.innerHTML = node.innerHTML;
    if (tape.children[index] !== keep) tape.insertBefore(keep, tape.children[index] ?? null);
  });
  while (tape.children.length > next.length) tape.lastElementChild.remove();
}
function inspectEvent(event) {
  selectedEvent = event.id;
  const heading = `${event.type.toUpperCase()} · ${label(event.side ?? event.status)}`;
  const fields = [['Time', event.ts ? new Date(event.ts).toLocaleString() : 'Unavailable for this older record'], ['Price', event.price ? money(event.price) : '—'], ['Quantity', event.qty == null ? '—' : number(event.qty)], ['Strategy', label(event.strategy ?? 'protective exit')], ['State', label(event.status)], ['Reason', label(event.reason)], ['Order / signal ID', event.orderId ?? event.id]];
  if (event.model) fields.push(['Jev', event.model.error ?? `${event.model.mode ?? ''} · ${event.model.regime ?? 'not evaluated'}`], ['Contextual quality', event.model.quality == null ? '—' : `${Math.round(event.model.quality * 100)}/100 (not win probability)`]);
  if (event.timeSource) fields.push(['Timestamp source', label(event.timeSource)]);
  if (event.note) fields.push(['Fill detail', event.note]);
  if (event.grossPnl != null) fields.push(['Matched gross P/L', `${money(event.grossPnl)} before fees`]);
  $('trade-detail').innerHTML = `<span class="eyebrow">${escape(heading)}</span><dl>${fields.map(([k,v]) => `<dt>${escape(k)}</dt><dd>${escape(v)}</dd>`).join('')}</dl>`;
}
async function refreshChart() {
  if (!token || !selectedSymbol || tabs.active !== 'live') return;
  const sequence = ++chartSequence;
  try {
    let data = await api(`/api/chart?symbol=${encodeURIComponent(selectedSymbol)}&interval=${selectedInterval}`);
    if (sequence !== chartSequence || !token || tabs.active !== 'live') return;
    if (!document.hidden) live.select(token, selectedSymbol, selectedInterval);
    data = live.overlay(data); latestChart = data; renderLivePrice(data);
    const diag = latestStatus?.diagnostics?.symbols.find(x => x.symbol === selectedSymbol);
    $('chart-mode').textContent = data.mode === 'demo' ? 'SYNTHETIC DATA' : data.mode === 'paper' ? 'REAL DATA · PAPER MONEY' : data.mode === 'live' ? 'REAL MONEY' : 'REAL DATA · LOCAL FILLS';
    $('chart-state').textContent = diag?.reason ?? (data.quoteFresh ? 'Fresh quote' : 'Waiting for fresh quote');
    $('chart-state').className = data.quoteFresh ? 'positive muted' : 'amber muted';
    $('chart-note').textContent = `${data.note} EMA overlays use the selected candle interval.`;
    $('tape-source').textContent = data.mode === 'paper' ? 'ALPACA PAPER' : data.mode === 'live' ? 'ALPACA LIVE' : 'SIMULATED';
    const rows = data.timeline.slice(0, 35);
    updateTape(rows.map(e => `<button class="tape-row" data-event="${escape(e.id)}"><span class="tape-icon ${e.type === 'fill' ? e.side === 'buy' ? 'positive' : 'negative' : e.status === 'approved' ? 'chart-blue' : 'muted'}">${e.type === 'fill' ? e.side === 'buy' ? '▲' : '▼' : e.type === 'signal' ? '●' : '↗'}</span><span><strong>${escape(e.type === 'fill' ? `${e.side} fill` : e.type === 'signal' ? label(e.strategy) : `${e.side} order`)}</strong><small>${escape(label(e.type === 'signal' ? e.reason : e.status))}</small></span><span class="tape-time">${e.ts ? time(e.ts) : 'No time'}<small>${e.price ? money(e.price) : ''}</small></span></button>`).join('') || '<p class="empty">No events for this instrument yet. Signals must qualify before the engine submits an order.</p>');
    const selected = data.timeline.find(e => e.id === selectedEvent);
    if (selected) inspectEvent(selected);
  } catch(e) { if(sequence === chartSequence) { $('chart-state').textContent = `Chart unavailable: ${e.message}.`; chart.clear('Chart unavailable. Waiting for a successful refresh.'); } }
}
async function refresh() {
  if (!token || busy || document.hidden) return; busy = true;
  const generation = session;
  try {
    const s = await api('/api/status'); if (!token || generation !== session) return;
    $('login').hidden = true; $('main').hidden = false;
    tabs.revealAnchor();
    latestStatus = s; renderTimings(); accountPerformance.setStatus(s);
    controls.render(s);
    discovery.render(s);
    const universe = s.market.map(m => m.symbol);
    if ($('chart-symbol').dataset.universe !== universe.join(',')) {
      if (!universe.includes(selectedSymbol)) {selectedSymbol = universe[0];live.stop();latestChart=null;selectedEvent=null;chart.clear();}
      $('chart-symbol').innerHTML = universe.map(symbol => `<option value="${escape(symbol)}">${escape(symbol)}</option>`).join('');
      $('chart-symbol').value = selectedSymbol; $('chart-symbol').dataset.universe = universe.join(',');
    }
    renderStatus(s);
    await Promise.all([
      tabs.active === 'live' && refreshChart(),
      tabs.active === 'research' && sessionResearch.refresh(),
      tabs.active === 'research' && tradeAlternatives.refresh(),
      ['live', 'performance'].includes(tabs.active) && accountPerformance.refresh(),
      ['live', 'performance'].includes(tabs.active) && tradePerformance.refresh(),
      tabs.active === 'performance' && researchResults.refresh(),
      tabs.active === 'strategies' && strategyControls.refresh(s),
      tabs.active === 'strategies' && optionsLab.refresh(),
      tabs.active === 'strategies' && paperRoutes.refresh(),
      ['operations', 'strategies', 'logs'].includes(tabs.active) && operations.refresh(s, selectedSymbol, tabs.active),
      tabs.active === 'logs' && jevLog.refresh(s),
    ]);
  } catch (e) { if (generation !== session) return; tradePerformance.disconnect(); sessionResearch.disconnect(); tradeAlternatives.disconnect(); paperRoutes.disconnect(); $('login-error').textContent = e.message; $('state-text').textContent = `Dashboard disconnected: ${e.message}`; $('live-state').textContent = $('state-text').textContent; live.stop(); }
  finally { busy = false; if (refreshPending) { refreshPending = false; void refresh(); } }
}
$('login-form').addEventListener('submit', e => { e.preventDefault(); session++; token = $('token').value.trim(); $('token').value = ''; if (busy) refreshPending = true; void refresh(); });
$('disconnect').addEventListener('click', () => { session++; token = ''; live.stop(); chartSequence++; latestStatus = null; latestChart = null; controls.clear(); chart.clear(); accountPerformance.clear(); researchResults.clear(); tradePerformance.clear(); sessionResearch.clear(); tradeAlternatives.clear(); paperRoutes.clear(); operations.clear(); jevLog.clear(); strategyControls.clear(); optionsLab.clear(); $('main').hidden = true; $('login').hidden = false; $('mode').textContent = 'CONNECT'; });
$('chart-symbol').addEventListener('change', () => { selectedSymbol = $('chart-symbol').value; live.stop(); latestChart = null; selectedEvent = null; $('trade-detail').innerHTML = '<p>Select a signal, order, or fill.</p>'; chart.clear(); void refreshChart(); });
document.querySelectorAll('[data-interval]').forEach(b => b.addEventListener('click', () => { selectedInterval = b.dataset.interval.endsWith('s') ? b.dataset.interval : Number(b.dataset.interval); live.stop(); latestChart = null; chart.clear(); document.querySelectorAll('[data-interval]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); void refreshChart(); }));
$('chart-signals').addEventListener('change', e => { chart.showSignals = e.target.checked; chart.draw(); });
$('chart-averages').addEventListener('change', e => { chart.showAverages = e.target.checked; chart.draw(); });
$('chart-in').addEventListener('click', () => chart.zoom(-1)); $('chart-out').addEventListener('click', () => chart.zoom(1));
$('chart-back').addEventListener('click', () => chart.pan(1)); $('chart-forward').addEventListener('click', () => chart.pan(-1));
$('chart-follow').addEventListener('click', () => chart.reset());
$('trade-tape').addEventListener('click', e => { const id = e.target.closest('[data-event]')?.dataset.event; const event = latestChart?.timeline.find(x => x.id === id); if (event) inspectEvent(event); });
document.addEventListener('visibilitychange', () => { if (document.hidden) live.stop(); else void refresh(); });
window.addEventListener('pagehide', () => live.stop());
setInterval(refresh, 2000);
