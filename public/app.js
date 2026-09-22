import { TradingChart, PnlChart } from './chart.js';
import { OperationsView } from './operations.js';
import { LiveQuotes } from './live.js';
import { JevLog } from './jev-log.js';
let token = '', busy = false, selectedSymbol = '', selectedInterval = 1, latestStatus = null, latestChart = null, chartSequence = 0, selectedEvent = null;
const $ = id => document.getElementById(id);
const money = n => Number(n ?? 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const number = n => Number(n ?? 0).toLocaleString('en-US', { maximumFractionDigits: 6 });
const quotePrice = n => Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });
const time = t => new Date(t).toLocaleTimeString('en-US', { hour12: false });
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const label = s => String(s).replaceAll('_', ' ');
const empty = (n, text) => `<tr><td colspan="${n}" class="empty">${escape(text)}</td></tr>`;
async function api(path, body) {
  const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
  if (!r.ok) { const error = await r.json().catch(() => ({})); throw new Error(r.status === 401 ? 'Token rejected. Check your .env file.' : error.error ?? `Request failed (${r.status})`); }
  return r.json();
}
const chart = new TradingChart($('price-chart'), $('chart-tooltip'), inspectEvent);
const pnlChart = new PnlChart($('pnl-chart'), $('pnl-tooltip'));
const operations = new OperationsView(api);
const jevLog = new JevLog(api);
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
    const pnl = (q.bid - p.entryPrice) * p.qty;
    $('position-pnl').textContent = money(pnl); $('position-pnl').className = pnl >= 0 ? 'positive' : 'negative';
    $('position-pnl-basis').textContent = `${number(p.qty)} last reconciled quantity · live bid mark, before exit fees${data.positionPnl?.external ? ' · external holding' : ''}`;
  } else {
    $('position-pnl').textContent = p ? money(p.unrealized) : '—'; $('position-pnl').className = p ? p.unrealized >= 0 ? 'positive' : 'negative' : 'muted';
    $('position-pnl-basis').textContent = p ? 'Last broker mark · waiting for a usable quote' : 'No open position in this instrument';
  }
}
let riskDirty = false, riskExpected = null, riskSaving = false, lastPerformance = 0, performanceSequence = 0, performanceScopeSet = false;
let lastResearch = 0;
async function refreshResearch() {
  if (Date.now() - lastResearch < 10000) return;
  try {
    const r = await api('/api/research'); if (!token) return; lastResearch = Date.now();
    $('research-state').textContent = `${r.mode.toUpperCase()} · ${new Date(r.now).toLocaleTimeString()}`;
    $('strategy-results').innerHTML = r.strategies.map(g => `<tr><td>${escape(label(g.strategy))}<small>${escape(g.asset)}</small></td><td>${g.closed} / ${g.partial}</td><td>${g.winRate == null ? '—' : (g.winRate*100).toFixed(1)+'%'}</td><td>${money(g.grossPnl)}</td><td>${money(g.estimatedFees)}</td><td class="${g.netPnl >= 0 ? 'positive' : 'negative'}">${money(g.netPnl)}</td><td>${g.meanNetPerClosedTrade == null ? '—' : money(g.meanNetPerClosedTrade)}</td><td>${escape(label(g.evidence))}</td></tr>`).join('') || empty(8, 'No closed or partially exited agent trades yet.');
    $('strategy-results-note').textContent = r.note;
    $('crypto-profile').textContent = `${r.mode === 'demo' ? 'Synthetic demo; provider context inactive' : 'Crypto: provider 5m context'} · ${r.crypto.state} · ${r.crypto.feePerSideBps} bps fee per side · up to ${r.crypto.maximumHoldingMs/60000}m holding horizon. Fresh quotes, spread, cost and allocation gates still apply. OFI scalping is restricted to equities.`;
    $('crypto-readiness').innerHTML = r.crypto.symbols.map(s => {
      const c = s.latestDecision, x = c?.preflight?.economics;
      return `<tr><td>${escape(s.symbol)}</td><td>${s.bars} observed 5m bars${s.coverage == null ? '' : '<small>'+(s.coverage*100).toFixed(1)+'% coverage</small>'}</td><td>${s.contextAt ? time(s.contextAt + 300000) : 'Warming up'}</td><td>${c ? escape(label(c.reason ?? c.status)) + '<small>'+time(c.ts)+'</small>' : 'No candidate yet'}</td><td>${x ? x.targetDistanceBps.toFixed(1)+' / '+x.roundTripCostBps.toFixed(1)+' bps' : 'Awaiting costed candidate'}</td><td>${x ? (x.breakEvenWinRate*100).toFixed(1)+'%' : '—'}</td></tr>`;
    }).join('') || empty(6, 'Crypto universe is empty.');
    $('jev-outcomes').innerHTML = r.outcomes.rows.map(g => `<tr><td>${escape(g.symbol)}<small>${escape(label(g.strategy))}</small></td><td>${g.modelPass ? 'Passed' : 'Declined / expired'}</td><td>${g.count} / ${g.missing}</td><td class="${g.meanNetBps >= 0 ? 'positive' : 'negative'}">${g.meanNetBps == null ? '—' : g.meanNetBps.toFixed(2)+' bps'}</td><td>${escape(g.fingerprint.slice(0,8))}</td></tr>`).join('') || empty(5, `Collecting forward observations · ${r.outcomes.pending} pending. No historical outcomes have been invented.`);
    $('jev-outcomes-note').textContent = r.outcomes.note;
  } catch { $('research-state').textContent = 'RESEARCH DATA UNAVAILABLE'; }
}
function renderReconciliation(s) {
  const details = s.reconciliation, shared = s.accountPolicy === 'shared', blocking = details?.blocking ?? s.issues.includes('external_account_activity');
  const visible = blocking || (shared && (details?.positions.length || details?.orders.length));
  $('reconciliation-panel').hidden = !visible;
  if (!visible) return;
  $('reconciliation-heading').textContent = blocking ? 'Account reconciliation needs attention' : 'External holdings · monitored separately';
  $('reconciliation-badge').textContent = blocking ? 'ENTRIES BLOCKED' : 'SHARED ACCOUNT';
  $('reconciliation-badge').className = `pill ${blocking ? 'amber' : ''}`;
  $('reconciliation-explanation').textContent = `${details?.positions.length ?? 0} external position(s) and ${details?.orders.length ?? 0} unmatched open order(s). ${blocking ? 'New entries are blocked until the reconciliation issues below are resolved.' : 'These holdings stay outside the agent portfolio. Other eligible instruments can trade when all entry checks pass.'}`;
  $('reconciliation-items').innerHTML = [...(details?.positions ?? []).map(p => `<div><strong>${escape(p.symbol)}</strong><span>${number(p.qty)} quantity · ${money(p.marketValue)} value</span><small>${escape(p.reason)}${p.configured ? '' : ' · outside the configured trading universe'}</small></div>`), ...(details?.orders ?? []).map(o => `<div><strong>${escape(o.symbol)} · ${escape(o.side)} order</strong><span>${number(o.qty)} quantity · ${escape(label(o.status))}</span><small>Client ID: ${escape(o.clientId)}</small></div>`)].join('');
  $('reconciliation-guidance').textContent = details?.guidance ?? 'External positions require account reconciliation.';
}
async function refreshPerformance() {
  if (Date.now() - lastPerformance < 5000) return;
  const sequence = ++performanceSequence, scope = $('performance-scope').value;
  try {
    const p = await api(`/api/performance?scope=${scope}`); if (!token || sequence !== performanceSequence) return;
    lastPerformance = Date.now(); pnlChart.update(p);
    $('performance-daily').textContent = p.latest.dailyPnl == null ? '—' : money(p.latest.dailyPnl);
    $('performance-open').textContent = p.latest.unrealized == null ? '—' : money(p.latest.unrealized);
    $('performance-daily').className = p.latest.dailyPnl >= 0 ? 'positive' : 'negative';
    $('performance-open').className = p.latest.unrealized >= 0 ? 'positive' : 'negative';
    $('performance-limit').textContent = p.dailyLoss == null ? 'Applies to other scope' : money(p.dailyLoss);
    $('performance-scope-label').textContent = p.scope === 'agent' ? 'AGENT PERFORMANCE · ESTIMATED' : 'ENTIRE ACCOUNT PERFORMANCE';
    $('performance-daily-label').textContent = p.scope === 'agent' ? '● Agent daily P/L' : '● Daily equity change';
    $('performance-open-label').textContent = p.scope === 'agent' ? '● Agent open P/L · before fees' : '● Open P/L · all holdings';
    $('performance-limit-label').textContent = `Daily loss ceiling · ${latestStatus?.limits.scope ?? 'account'} scope`;
    $('pnl-chart').setAttribute('aria-label', `${p.scope} daily change and open profit and loss over time`);
    $('performance-status').textContent = p.stale ? 'STALE ACCOUNT DATA' : p.mode === 'demo' ? 'SYNTHETIC ACCOUNT' : p.mode === 'shadow' ? 'LOCAL SIMULATED ACCOUNT' : `${p.scope === 'agent' ? 'AGENT MARK' : 'BROKER MARK'} · ${p.latest.observedAt ? time(p.latest.observedAt) : 'pending'}`;
    $('performance-status').className = `pill ${p.stale ? 'amber' : ''}`;
    $('performance-note').textContent = `${p.note} Broker reconciliation runs about every 5 seconds plus request time; this panel refreshes every 5 seconds.`;
  } catch (e) { if (sequence === performanceSequence && token) { $('performance-status').textContent = 'DISCONNECTED'; $('performance-note').textContent = e.message; } }
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
function renderDiagnostics(s) {
  const d = s.diagnostics;
  $('data-source').textContent = d?.dataSource ?? (s.mode === 'demo' ? 'Synthetic demo data' : 'Provider market data');
  $('data-explanation').textContent = d?.hint ?? (s.mode === 'demo' ? 'The running engine is in MODE=demo. Keys alone do not switch it to real prices; set MODE=paper and recreate the container.' : 'Quotes arrive independently of strategy warmup.');
  const badges = [[d?.execution ?? s.mode, s.mode === 'live' ? 'negative' : 'positive'], [s.mode === 'demo' ? 'Synthetic clock' : d?.equitySession?.open ? 'Equity session open' : 'Equity session closed', 'muted']];
  if (d?.clock) badges.push([d.clock.synchronized ? `Provider clock calibrated · ${(d.clock.offsetMs / 1000).toFixed(2)}s vs host` : `Clock blocked · ${label(d.clock.reason)}`, d.clock.synchronized ? 'positive' : 'negative']);
  for (const [name, feed] of Object.entries(s.feeds)) badges.push([`${name}: ${label(feed.status)}${feed.lastError ? ' · ' + label(feed.lastError) : ''}`, feed.status === 'streaming' ? 'positive' : 'amber']);
  $('connection-badges').innerHTML = badges.map(([t,c]) => `<span class="connection-tag ${c}">${escape(t)}</span>`).join('');
}
async function refreshChart() {
  if (!token || !selectedSymbol) return;
  const sequence = ++chartSequence;
  try {
    let data = await api(`/api/chart?symbol=${encodeURIComponent(selectedSymbol)}&interval=${selectedInterval}`);
    if (sequence !== chartSequence || !token) return;
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
  } catch(e) { if(sequence === chartSequence) { $('chart-state').textContent = `Chart unavailable: ${e.message}. Rebuild the container to load the chart API.`; chart.clear('Chart API unavailable. Check that this container was rebuilt.'); } }
}
async function refresh() {
  if (!token || busy || document.hidden) return; busy = true;
  try {
    const s = await api('/api/status'); $('login').hidden = true; $('main').hidden = false;
    if (!token) return;
    latestStatus = s; renderDiagnostics(s); renderReconciliation(s); renderTimings();
    const shared = s.accountPolicy === 'shared', book = s.portfolio;
    if (!performanceScopeSet) { $('performance-scope').value = shared ? 'agent' : 'account'; performanceScopeSet = true; lastPerformance = 0; }
    $('agent-portfolio').hidden = !shared;
    if (shared) {
      $('agent-book-state').textContent = book.valid ? 'AGENT BOOK RECONCILED' : 'AGENT BOOK UNAVAILABLE';
      $('agent-book-state').className = `pill ${book.valid ? '' : 'amber'}`;
      for (const [id, value] of [['agent-daily', book.dailyPnl], ['agent-open', book.unrealized], ['external-gross', book.externalGross], ['agent-cash', book.cashAvailable]]) { $(id).textContent = value == null ? '—' : money(value); $(id).className = value == null ? 'muted' : value < 0 ? 'negative' : 'positive'; }
      $('agent-book-note').textContent = `${book.note} Baseline: ${book.baselineAt ? new Date(book.baselineAt).toLocaleString() : 'waiting'}. ${book.accountDailyHalt ? 'A prior account-wide halt is retained in history; the active entry gate uses the agent loss halt.' : ''} ${book.agentDailyHalt ? 'Agent daily-loss halt is active.' : ''}`;
    }
    $('risk-scope-note').textContent = `${shared ? 'Agent daily P/L only, including estimated trading fees; external holdings and transfers are excluded.' : 'Account-wide daily equity change, including external holdings.'} A triggered halt lasts through the New York date; raising the ceiling does not clear it.`;
    if (!riskDirty && !riskSaving) { $('daily-loss-input').value = s.limits.dailyLoss; riskExpected = s.limits.dailyLoss; }
    $('risk-source').textContent = `${s.limits.dailyLossOverride ? 'Saved dashboard override' : 'Environment default'} · ${money(s.limits.dailyLoss)} active${s.limits.dailyLossHalted ? ' · HALTED FOR TODAY' : ''}. Changes persist across restarts.`;
    $('paper-test-panel').hidden = s.mode !== 'paper';
    const universe = s.market.map(m => m.symbol);
    if ($('chart-symbol').dataset.universe !== universe.join(',')) {
      if (!universe.includes(selectedSymbol)) selectedSymbol = universe[0];
      $('chart-symbol').innerHTML = universe.map(symbol => `<option value="${escape(symbol)}">${escape(symbol)}</option>`).join('');
      $('chart-symbol').value = selectedSymbol; $('chart-symbol').dataset.universe = universe.join(',');
    }
    $('mode').textContent = s.mode.toUpperCase(); $('mode').className = `pill ${s.mode === 'live' ? 'negative' : ''}`;
    $('clock').textContent = `${time(s.now)} ${s.mode === 'demo' ? 'SIMULATION' : 'LOCAL DISPLAY'}`;
    $('state-text').textContent = s.paused ? 'New entries paused. Position management remains active.' : s.ready ? 'Account gates clear. Strategies wait for qualifying setups and fresh data.' : `Entries blocked: ${s.issues.map(label).join(', ') || 'initializing'}.`;
    $('warnings').textContent = s.warnings.join(' '); $('equity').textContent = money(s.account?.equity);
    $('pnl').textContent = money(s.dailyPnl); $('pnl').className = s.dailyPnl >= 0 ? 'positive' : 'negative';
    $('exposure-scope').textContent = shared ? 'AGENT GROSS EXPOSURE' : 'ACCOUNT GROSS EXPOSURE';
    $('exposure').textContent = money(shared ? book.managedGross : s.positions.reduce((v, p) => v + Math.abs(p.marketValue), 0));
    const countLimit = s.limits.maxPositions === null ? 'No position-count cap' : Number.isInteger(s.limits.maxPositions) ? `${s.limits.maxPositions} positions + pending entries maximum` : 'Position-count setting unavailable';
    $('exposure-limit').textContent = `${money(s.limits.maxGross)} gross limit · ${shared ? s.positions.filter(p => p.management).length : s.positions.length} ${shared ? 'agent ' : ''}positions · ${countLimit}`;
    $('spend').textContent = money(s.jev.spent); $('model-label').textContent = `${s.jev.mode.toUpperCase()} · ${money(s.jev.budget)} monthly budget`;
    $('market').innerHTML = s.market.map(m => {
      const q = m.quote, age = q ? (s.now - q.ts) / 1000 : null, diagnostic = s.diagnostics?.symbols.find(d => d.symbol === m.symbol);
      return `<tr><td><strong>${escape(m.symbol)}</strong></td><td>${q ? `${quotePrice(q.bid)} / ${quotePrice(q.ask)}` : '—'}</td><td>${q ? ((q.ask - q.bid) / q.ask * 10000).toFixed(1) + ' bps' : '—'}</td><td class="${diagnostic?.fresh ? '' : 'amber'}">${age === null ? '—' : age.toFixed(2) + 's'}</td><td>${escape(diagnostic?.reason ?? 'Waiting for context')}<small>${m.bars} completed bars</small></td><td>${m.features ? (m.features.ema9 > m.features.ema21 ? '↗ Rising' : '↘ Falling') : '—'}</td></tr>`;
    }).join('');
    $('workers').innerHTML = s.workers.map(w => `<div class="worker"><div><strong>${escape(label(w.strategy))}</strong><small>${number(w.evaluated)} rule checks · ${number(w.matched)} matches · ${number(w.noSetup)} no setup · ${w.pending} queued</small></div><span class="${w.alive ? 'positive' : 'negative'}">${w.alive ? 'RUNNING' : 'STOPPED'}</span></div>`).join('');
    $('gates').innerHTML = `<div class="gate"><span>Account & reconciliation</span><span class="${s.ready ? 'positive' : 'amber'}">${s.ready ? 'CLEAR' : 'BLOCKED'}</span></div><div class="gate"><span>Operator permission</span><span>${s.paused ? 'PAUSED' : 'ENABLED'}</span></div><div class="gate"><span>Daily loss ceiling · ${escape(s.limits.scope ?? 'account')}</span><span>${money(s.limits.dailyLoss)}</span></div>` + s.issues.map(i => `<div class="amber">${escape(label(i))}</div>`).join('');
    $('feeds').textContent = Object.entries(s.feeds).map(([k, v]) => `${k}: ${label(v.status)}${v.providerAgeMs != null ? ` · last received ${v.lastKind} timestamp ${new Date(v.providerTimestamp).toLocaleString()} (${(v.providerAgeMs / 1000).toFixed(1)}s behind receipt)` : ''}`).join(' · ');
    $('positions-count').textContent = `${s.positions.length} positions`;
    const micro = (s.microstructure ?? []).filter(m => m.observations);
    $('microstructure').innerHTML = micro.map(m => `<tr><td>${escape(m.symbol)}</td><td>${(m.imbalance * 100).toFixed(1)}%</td><td>${m.normalizedOfi.toFixed(2)}</td><td>${m.micropriceSkewBps.toFixed(2)} bps</td><td>${m.observations}</td></tr>`).join('') || empty(5, 'Waiting for fresh quotes with bid and ask sizes. Synthetic bars are insufficient.');
    $('pairs').innerHTML = (s.pairs ?? []).map(p => `<div class="worker"><div><strong>${escape(p.pair)}</strong><small>Prior-window beta ${p.beta.toFixed(3)}</small></div><span class="${Math.abs(p.zscore) >= 2 ? 'amber' : 'muted'}">z ${p.zscore.toFixed(2)}</span></div>`).join('') || '<p class="muted">Requires 61 aligned one-minute observations.</p>';
    $('positions').innerHTML = s.positions.map(p => `<tr><td>${escape(p.symbol)}</td><td>${number(p.qty)}</td><td>${money(p.entryPrice)}</td><td>${money(p.marketValue)}</td><td class="${p.unrealized >= 0 ? 'positive' : 'negative'}">${money(p.unrealized)}</td><td>${escape(p.management?.exitReason ? label(p.management.exitReason) : p.management ? 'Monitoring' : 'External / unmanaged')}</td></tr>`).join('') || empty(6, 'No positions. Waiting for qualified entries.');
    $('candidates').innerHTML = s.candidates.map(c => `<tr><td>${time(c.ts)}</td><td>${escape(c.symbol)}<small>${escape(label(c.strategy))}</small></td><td class="${c.status === 'approved' ? 'positive' : 'muted'}">${escape(c.status)}</td><td>${c.model?.quality != null ? `${Math.round(c.model.quality * 100)} / 100 · ${escape(c.model.regime)}` : escape(c.model?.error ?? c.model?.mode ?? 'pending')}</td><td>${escape(label(c.reason ?? 'allocation accepted'))}</td></tr>`).join('') || empty(5, 'No setup has qualified yet. Warming up and observing is normal.');
    $('events').innerHTML = s.events.slice(0, 18).map(e => `<div class="event"><time>${time(e.ts)}</time><p>${escape(label(e.type))}<small class="muted"> ${escape(e.data.reason ?? e.data.action ?? e.data.symbol ?? '')}</small></p></div>`).join('');
    $('orders').innerHTML = s.orders.map(o => `<tr><td>${time(o.ts)}</td><td>${escape(o.symbol)}</td><td>${escape(o.kind)}</td><td>${number(o.qty)} / ${number(o.filledQty)}</td><td class="${['unknown', 'submitting'].includes(o.status) ? 'amber' : ''}">${escape(label(o.status))}</td><td class="code">${escape(o.id)}</td></tr>`).join('') || empty(6, 'No order intents recorded.');
    $('updated').textContent = `Updated ${time(Date.now())} · Broker sync ${s.lastReconcile ? time(s.lastReconcile) : 'pending'}`;
    await Promise.all([refreshChart(), refreshPerformance(), refreshResearch(), operations.refresh(s, selectedSymbol), jevLog.refresh(s)]);
  } catch (e) { $('login-error').textContent = e.message; $('state-text').textContent = `Dashboard disconnected: ${e.message}`; }
  finally { busy = false; }
}
$('login-form').addEventListener('submit', e => { e.preventDefault(); token = $('token').value.trim(); $('token').value = ''; void refresh(); });
document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', async () => {
  const action = button.dataset.action;
  if (action === 'flatten' && !confirm('Pause entries and request closure of all positions managed by this engine? Orders may fill at a loss.')) return;
  button.disabled = true;
  try { await api('/api/control', { action, ...(action === 'flatten' ? { confirmation: 'FLATTEN_MANAGED_POSITIONS' } : {}) }); $('action-message').textContent = `${label(action)} requested. Inspect order states for completion.`; await refresh(); }
  catch (e) { $('action-message').textContent = e.message; }
  finally { button.disabled = false; }
}));
$('disconnect').addEventListener('click', () => { token = ''; live.stop(); chartSequence++; latestStatus = null; latestChart = null; lastPerformance = 0; riskDirty = false; chart.clear(); pnlChart.clear(); performanceSequence++; performanceScopeSet = false; operations.clear(); jevLog.clear(); $('main').hidden = true; $('login').hidden = false; $('mode').textContent = 'CONNECT'; });
$('chart-symbol').addEventListener('change', () => { selectedSymbol = $('chart-symbol').value; live.stop(); latestChart = null; selectedEvent = null; $('trade-detail').innerHTML = '<p>Select a signal, order, or fill.</p>'; chart.clear(); void refreshChart(); });
document.querySelectorAll('[data-interval]').forEach(b => b.addEventListener('click', () => { selectedInterval = b.dataset.interval.endsWith('s') ? b.dataset.interval : Number(b.dataset.interval); live.stop(); latestChart = null; chart.clear(); document.querySelectorAll('[data-interval]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); void refreshChart(); }));
$('chart-signals').addEventListener('change', e => { chart.showSignals = e.target.checked; chart.draw(); });
$('chart-averages').addEventListener('change', e => { chart.showAverages = e.target.checked; chart.draw(); });
$('chart-in').addEventListener('click', () => chart.zoom(-1)); $('chart-out').addEventListener('click', () => chart.zoom(1));
$('chart-back').addEventListener('click', () => chart.pan(1)); $('chart-forward').addEventListener('click', () => chart.pan(-1));
$('chart-follow').addEventListener('click', () => chart.reset());
$('trade-tape').addEventListener('click', e => { const id = e.target.closest('[data-event]')?.dataset.event; const event = latestChart?.timeline.find(x => x.id === id); if (event) inspectEvent(event); });
let paperRequest = null;
$('paper-test').addEventListener('click', async () => {
  if (latestStatus?.mode !== 'paper') return;
  if (!paperRequest && !confirm(`Send an Alpaca PAPER test for ${selectedSymbol}? Maximum one share or $25 crypto, subject to risk limits. The engine attempts to exit after 60 seconds.`)) return;
  paperRequest ??= { symbol: selectedSymbol, requestId: crypto.randomUUID(), confirmation: 'PAPER_MONEY_ONLY' };
  $('paper-test').disabled = true;
  try {
    const result = await api('/api/paper-test', paperRequest);
    $('paper-test-result').textContent = `${label(result.status)} · ${label(result.reason ?? 'Intent recorded. Follow the execution tape for acknowledgment and fills.')}`;
    paperRequest = null; $('paper-test').textContent = 'Send paper test trade'; await refresh();
  } catch(e) { $('paper-test-result').textContent = `${e.message}. Outcome may be pending; retry checks the same request.`; $('paper-test').textContent = 'Check same paper test'; }
  finally { $('paper-test').disabled = false; }
});
$('performance-scope').addEventListener('change', () => { performanceSequence++; lastPerformance = 0; pnlChart.clear(); void refreshPerformance(); });
$('daily-loss-input').addEventListener('input', () => { riskDirty = true; $('risk-result').textContent = 'Unsaved change'; });
$('risk-form').addEventListener('submit', async e => {
  e.preventDefault(); if (riskSaving || riskExpected == null) return;
  riskSaving = true; $('save-risk').disabled = true;
  try {
    const result = await api('/api/risk-settings', { dailyLoss: Number($('daily-loss-input').value), expectedDailyLoss: riskExpected });
    riskExpected = result.dailyLoss; riskDirty = false; $('daily-loss-input').value = result.dailyLoss; lastPerformance = 0;
    $('risk-result').textContent = `Saved ${money(result.dailyLoss)}. ${result.halted ? 'The daily halt remains active for ' + result.day + '.' : 'Applies immediately and survives restarts.'}`;
  } catch (error) { $('risk-result').textContent = error.message; if (latestStatus) riskExpected = latestStatus.limits.dailyLoss; }
  finally { riskSaving = false; $('save-risk').disabled = false; void refresh(); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) live.stop(); else void refresh(); });
window.addEventListener('pagehide', () => live.stop());
setInterval(refresh, 2000);
