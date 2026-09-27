import { $, money, number, quotePrice, time, escape, label, empty } from './dashboard-format.js';
import { renderCryptoSignals } from './crypto-signals.js';
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
function renderDiagnostics(s) {
  const d = s.diagnostics;
  $('data-source').textContent = d?.dataSource ?? (s.mode === 'demo' ? 'Synthetic demo data' : 'Provider market data');
  $('data-explanation').textContent = d?.hint ?? (s.mode === 'demo' ? 'The running engine is in MODE=demo. Keys alone do not switch it to real prices; set MODE=paper and recreate the container.' : 'Quotes arrive independently of strategy warmup.');
  const badges = [[d?.execution ?? s.mode, s.mode === 'live' ? 'negative' : 'positive'], [s.mode === 'demo' ? 'Synthetic clock' : d?.equitySession?.open ? 'Equity session open' : 'Equity session closed', 'muted']];
  if (d?.clock) badges.push([d.clock.synchronized ? `Provider clock calibrated · ${(d.clock.offsetMs / 1000).toFixed(2)}s vs host` : `Clock blocked · ${label(d.clock.reason)}`, d.clock.synchronized ? 'positive' : 'negative']);
  for (const [name, feed] of Object.entries(s.feeds)) badges.push([`${name}: ${label(feed.status)}${feed.lastError ? ' · ' + label(feed.lastError) : ''}`, feed.status === 'streaming' ? 'positive' : 'amber']);
  $('connection-badges').innerHTML = badges.map(([t,c]) => `<span class="connection-tag ${c}">${escape(t)}</span>`).join('');
}
export function renderStatus(s) {
  renderCryptoSignals(s);
  const shared = s.accountPolicy === 'shared', book = s.portfolio;
  renderDiagnostics(s); renderReconciliation(s);
    $('agent-portfolio').hidden = !shared;
    if (shared) {
      $('agent-book-state').textContent = book.valid ? 'AGENT BOOK RECONCILED' : 'AGENT BOOK UNAVAILABLE';
      $('agent-book-state').className = `pill ${book.valid ? '' : 'amber'}`;
      for (const [id, value] of [['agent-daily', book.dailyPnl], ['agent-open', book.unrealized], ['external-gross', book.externalGross], ['agent-cash', book.cashAvailable]]) { $(id).textContent = value == null ? '—' : money(value); $(id).className = value == null ? 'muted' : value < 0 ? 'negative' : 'positive'; }
      $('agent-book-note').textContent = `${book.note} Baseline: ${book.baselineAt ? new Date(book.baselineAt).toLocaleString() : 'waiting'}. ${book.accountDailyHalt ? 'A prior account-wide halt is retained in history; the active entry gate uses the agent loss halt.' : ''} ${book.agentDailyHalt ? 'Agent daily-loss halt is active.' : ''}`;
    }
    $('risk-scope-note').textContent = `${shared ? 'Agent daily P/L only, including estimated trading fees; external holdings and transfers are excluded.' : 'Account-wide daily equity change, including external holdings.'} A triggered halt lasts through the New York date; raising the ceiling does not clear it.`;
    $('mode').textContent = s.mode.toUpperCase(); $('mode').className = `pill ${s.mode === 'live' ? 'negative' : ''}`;
    $('clock').textContent = `${time(s.now)} ${s.mode === 'demo' ? 'SIMULATION' : 'LOCAL DISPLAY'}`;
    $('state-text').textContent = s.paused ? 'New entries paused. Position management remains active.' : s.ready ? 'Account gates clear. Strategies wait for qualifying setups and fresh data.' : `Entries blocked: ${s.issues.map(label).join(', ') || 'initializing'}.`;
    $('live-state').textContent = $('state-text').textContent;
    $('warnings').hidden = !s.warnings.length;
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
    $('workers').innerHTML = s.workers.map(w => `<div class="worker"><div><strong>${escape(label(w.strategy))}</strong><small>${number(w.evaluated)} rule checks · ${number(w.matched)} matches · ${number(w.noSetup)} no setup · ${w.pending} queued</small></div><span class="${w.enabled === false ? 'muted' : w.alive ? 'positive' : 'negative'}">${w.enabled === false ? 'OFF' : w.alive ? 'RUNNING' : 'STOPPED'}</span></div>`).join('');
    $('gates').innerHTML = `<div class="gate"><span>Account & reconciliation</span><span class="${s.ready ? 'positive' : 'amber'}">${s.ready ? 'CLEAR' : 'BLOCKED'}</span></div><div class="gate"><span>Operator permission</span><span>${s.paused ? 'PAUSED' : 'ENABLED'}</span></div><div class="gate"><span>Daily loss ceiling · ${escape(s.limits.scope ?? 'account')}</span><span>${money(s.limits.dailyLoss)}</span></div>` + s.issues.map(i => `<div class="amber">${escape(label(i))}</div>`).join('');
    $('feeds').textContent = Object.entries(s.feeds).map(([k, v]) => `${k}: ${label(v.status)}${v.providerAgeMs != null ? ` · last received ${v.lastKind} timestamp ${new Date(v.providerTimestamp).toLocaleString()} (${(v.providerAgeMs / 1000).toFixed(1)}s behind receipt)` : ''}`).join(' · ');
    $('positions-count').textContent = `${s.positions.length} positions`;
    const micro = (s.microstructure ?? []).filter(m => m.observations);
    $('microstructure').innerHTML = micro.map(m => `<tr><td>${escape(m.symbol)}</td><td>${(m.imbalance * 100).toFixed(1)}%</td><td>${m.normalizedOfi.toFixed(2)}</td><td>${m.micropriceSkewBps.toFixed(2)} bps</td><td>${m.observations}</td></tr>`).join('') || empty(5, 'Waiting for fresh quotes with bid and ask sizes. Synthetic bars are insufficient.');
    $('pairs').innerHTML = (s.pairs ?? []).map(p => `<div class="worker"><div><strong>${escape(p.pair)}</strong><small>Prior-window beta ${p.beta.toFixed(3)}</small></div><span class="${Math.abs(p.zscore) >= 2 ? 'amber' : 'muted'}">z ${p.zscore.toFixed(2)}</span></div>`).join('') || '<p class="muted">Requires 61 aligned one-minute observations.</p>';
    $('positions').innerHTML = s.positions.map(p => `<tr><td>${escape(p.symbol)}</td><td>${number(p.qty)}</td><td>${money(p.entryPrice)}</td><td>${money(p.marketValue)}</td><td class="${p.unrealized >= 0 ? 'positive' : 'negative'}">${money(p.unrealized)}</td><td>${escape(p.management?.exitReason ? label(p.management.exitReason) : p.management ? 'Monitoring' : 'External / unmanaged')}${p.management?.excursion?`<small>Observed peak net: ${money(p.management.campaignExcursion?.peakNet ?? p.management.excursion.peakNet)} · profit trigger: ${(p.management.addFloor ?? p.management.excursion.floor)?quotePrice(p.management.addFloor ?? p.management.excursion.floor):'not armed'}</small>`:''}</td></tr>`).join('') || empty(6, 'No positions. Waiting for qualified entries.');
    $('candidates').innerHTML = s.candidates.map(c => `<tr><td>${time(c.ts)}</td><td>${escape(c.symbol)}<small>${escape(label(c.strategy))}</small></td><td class="${c.status === 'approved' ? 'positive' : 'muted'}">${escape(c.status)}</td><td>${c.model?.quality != null ? `${Math.round(c.model.quality * 100)} / 100 · ${escape(c.model.regime)}` : escape(c.model?.error ?? c.model?.mode ?? 'pending')}</td><td>${escape(label(c.reason ?? (c.status === 'approved' ? 'allocation accepted' : 'entry checks pending')))}</td></tr>`).join('') || empty(5, 'No setup has qualified yet. Warming up and observing is normal.');
    $('events').innerHTML = s.events.slice(0, 18).map(e => `<div class="event"><time>${time(e.ts)}</time><p>${escape(label(e.type))}<small class="muted"> ${escape(e.data.reason ?? e.data.action ?? e.data.symbol ?? '')}</small></p></div>`).join('');
    $('orders').innerHTML = s.orders.map(o => `<tr><td>${time(o.ts)}</td><td>${escape(o.symbol)}</td><td>${escape(o.kind)}</td><td>${number(o.qty)} / ${number(o.filledQty)}</td><td class="${['unknown', 'submitting'].includes(o.status) ? 'amber' : ''}">${escape(label(o.status))}</td><td class="code">${escape(o.id)}</td></tr>`).join('') || empty(6, 'No order intents recorded.');
    $('updated').textContent = `Updated ${time(Date.now())} · Broker sync ${s.lastReconcile ? time(s.lastReconcile) : 'pending'}`;
}
