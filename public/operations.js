const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const label = v => String(v ?? '').replaceAll('_', ' ');
const n = v => Number(v ?? 0).toLocaleString('en-US', { maximumFractionDigits: 4 });
const usd = v => Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 });
const time = v => new Date(v).toLocaleTimeString('en-US', { hour12: false });
const value = v => v == null ? 'unavailable' : typeof v === 'boolean' ? v ? 'yes' : 'no' : typeof v === 'number' ? n(v) : String(v);
const condition = c => `${c.name}: ${value(c.actual)} ${c.operator} ${value(c.target)}${c.unit ? ' ' + c.unit : ''}`;

export class OperationsView {
  constructor(api) {
    this.api = api; this.cursor = 0; this.rows = []; this.sequence = 0; this.live = true;
    for (const id of ['log-category', 'log-symbol']) $(id).addEventListener('change', () => this.resetLog());
    $('log-search').addEventListener('input', () => this.renderLog());
    $('log-freeze').addEventListener('click', () => {
      this.live = !this.live; $('log-freeze').textContent = this.live ? 'Freeze log view' : 'Resume latest events';
      if (this.live) this.resetLog();
      $('log-state').textContent = this.live ? 'Following events' : 'View frozen · engine continues running';
    });
  }
  resetLog() { this.cursor = 0; this.rows = []; this.logGeneration = (this.logGeneration ?? 0) + 1; this.renderLog(); }
  clear() { this.sequence++; this.session = null; this.resetLog(); }
  async refresh(status, symbol) {
    const sequence = ++this.sequence;
    try {
      const d = await this.api(`/api/insights?symbol=${encodeURIComponent(symbol)}`);
      if (sequence !== this.sequence) return;
      if (this.session !== d.sessionId) { this.session = d.sessionId; this.resetLog(); }
      const universe = status.market.map(m => m.symbol).join(',');
      if (this.universe !== universe) {
        const selected = $('log-symbol').value; this.universe = universe;
        $('log-symbol').innerHTML = '<option value="">All instruments</option>' + status.market.map(m => `<option>${esc(m.symbol)}</option>`).join('');
        if (status.market.some(m => m.symbol === selected)) $('log-symbol').value = selected;
      }
      this.render(d, status); await this.refreshLog();
    } catch (e) { if (sequence === this.sequence) $('decision-why').textContent = `Decision telemetry unavailable: ${e.message}. The engine must run v1.3.`; }
  }
  render(d, s) {
    const c = d.counts;
    $('run-identity').textContent = d.mode === 'demo' ? 'DEMO PREVIEW · SYNTHETIC PRICES · SIMULATED TRADES'
      : d.mode === 'paper' ? 'ALPACA PAPER ACCOUNT · REAL PRICES · PAPER MONEY'
      : d.mode === 'shadow' ? 'REAL PRICES · LOCAL SIMULATED TRADES' : 'LIVE ACCOUNT · REAL MONEY';
    $('run-explanation').textContent = d.mode === 'demo'
      ? 'This preview generates artificial prices and advances simulation time faster than wall-clock time. It is separate from your Alpaca app on port 8080.'
      : 'Numerical workers detect setups. Jev evaluates setup context when enabled. The portfolio coordinator checks risk and submits orders; the broker reports fills.';
    $('demo-app-link').hidden = d.mode !== 'demo' || location.port === '8080';
    const stages = [
      ['Rule checks', c.checks, 'One strategy × one instrument snapshot'],
      ['Unique setups', c.candidates, 'Conditions met; duplicate signals removed'],
      ['Jev requests', c.modelRequests, d.jev.mode === 'off' ? 'OFF · classification skipped' : d.jev.mode === 'shadow' ? 'SHADOW · observes, does not veto' : 'FILTER · context must pass'],
      ['Risk approved', c.riskApproved, `${n(c.riskRejected)} blocked by entry checks`],
      ['Submissions', c.submissions, 'Entry and exit submission attempts'],
      ['Orders with fills', c.filledOrders, 'Observed fills; acceptance alone is excluded'],
    ];
    $('execution-funnel').innerHTML = stages.map(([name, count, detail]) => `<article><span>${name}</span><strong>${n(count)}</strong><small>${esc(detail)}</small></article>`).join('');
    $('counter-scope').textContent = `Market intake this run: ${n(c.quotesAccepted)} accepted quotes · ${n(c.quotesRejected)} rejected quotes. Since engine restart at ${new Date(d.startedAt).toLocaleString()}. ${d.note}`;
    $('trade-history-summary').textContent = `${n(d.journal.filledBuys)} filled buy orders · ${n(d.journal.filledSells)} filled sell/protective orders in the retained journal · ${s.positions.length} currently open positions. These totals include earlier runs.`;
    $('decision-why').textContent = d.why;
    $('decision-symbol').textContent = d.symbol;
    $('scan-heading').textContent = `Latest strategy checks · ${d.symbol}`;
    const scans = $('scan-matrix');
    const existing = new Map([...scans.children].map(el => [el.dataset.strategy, el]));
    for (const report of d.reports) {
      let row = existing.get(report.strategy);
      if (!row) { row = document.createElement('details'); row.dataset.strategy = report.strategy; row.className = 'scan-row'; scans.append(row); }
      const w = d.workers.find(w => w.strategy === report.strategy);
      const stamp = report.ts ? `${time(report.ts)} ${d.mode === 'demo' ? 'simulation' : ''}` : 'Not evaluated yet';
      const markup = `<summary><span><strong>${esc(label(report.strategy))}</strong><small>${esc(report.reason)}</small></span><span class="${report.matched ? 'positive' : 'muted'}">${report.checks.length ? `${report.passed}/${report.checks.length} met` : 'WAITING'}<small>${esc(stamp)}</small></span></summary><div class="scan-checks">${report.checks.map(check => `<div class="${check.pass ? 'positive' : 'amber'}"><span>${check.pass ? '✓' : '○'}</span><span>${esc(condition(check))}</span></div>`).join('') || '<p>Context is not ready. No strategy decision has been recorded for this instrument.</p>'}<p class="muted">Worker this run: ${n(w?.evaluated)} completed checks · ${n(w?.matched)} matches · ${n(w?.noSetup)} no setup · ${n(w?.errors)} errors.</p></div>`;
      if (row.innerHTML !== markup) row.innerHTML = markup;
    }
    $('no-setup-reasons').textContent = d.topReasons.length ? 'Most frequent unmet conditions this run: ' + d.topReasons.map(r => `${label(r.strategy)} / ${r.reason} (${n(r.count)})`).join(' · ') : 'No unmet-condition counts recorded yet.';
    const j = d.jev, last = j.last;
    $('jev-state').textContent = j.state; $('jev-role').textContent = j.description;
    $('jev-activity-counts').textContent = `${n(j.requests)} request attempts · ${n(j.succeeded)} valid responses · ${n(j.failed)} errors · ${n(j.skipped)} skipped setup checks · ${n(j.busy)} in flight`;
    $('jev-mode-detail').textContent = `${j.model} · ${j.mode.toUpperCase()} · request counters reset with this engine process`;
    const vals = [['Coherence', last?.coherence, j.minCoherence], ['Context quality', last?.quality, j.minQuality]];
    $('jev-results').innerHTML = vals.map(([name, actual, threshold]) => `<div><span>${name}</span><strong>${actual == null ? '—' : n(actual)}</strong><small>Filter threshold ≥ ${n(threshold)}</small></div>`).join('') + `<div><span>Observed regime</span><strong>${esc(last?.regime ?? '—')}</strong><small>Disorderly context fails filtering</small></div>`;
    $('jev-last').textContent = last ? `${last.symbol} · ${label(last.strategy)} · ${time(last.ts)} · ${last.requested ? last.error ? label(last.error) : `context ${last.pass ? 'passed' : 'declined'}` : `no API request: ${last.error ? label(last.error) : 'Jev disabled'}`}${last.latencyMs == null ? '' : ` · ${Math.round(last.latencyMs)}ms`}${last.cost == null ? '' : ` · estimated usage cost ${usd(last.cost)}`}` : 'No setup has reached Jev in this engine run.';
  }
  async refreshLog() {
    if (!this.live) return;
    const generation = this.logGeneration, sequence = this.sequence;
    const p = new URLSearchParams({ after: this.cursor, category: $('log-category').value, symbol: $('log-symbol').value, limit: 200 });
    try {
      const page = await this.api(`/api/activity?${p}`);
      if (generation !== this.logGeneration || sequence !== this.sequence || !this.live) return;
      if (page.reset) this.rows = [];
      const ids = new Set(this.rows.map(e => e.id));
      this.rows.push(...page.events.filter(e => !ids.has(e.id))); this.rows = this.rows.slice(-500); this.cursor = page.cursor;
      this.renderLog(); $('log-state').textContent = `${page.hasMore ? 'Loading newer events' : 'Following events'} · ${this.rows.length} retained in this view`;
    } catch (e) { $('log-state').textContent = `Log disconnected: ${e.message}`; }
  }
  renderLog() {
    const search = $('log-search').value.toLowerCase().trim(), pane = $('live-log'), wasAtBottom = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 40;
    const rows = this.rows.filter(e => `${e.type} ${JSON.stringify(e.data)}`.toLowerCase().includes(search));
    const existing = new Map([...pane.children].map(el => [el.dataset.id, el]));
    rows.forEach((e, i) => {
      const d = e.data;
      let message = label(e.type);
      if (e.type === 'scan_summary') message = `No setup · ${d.passed}/${d.total} conditions met · ${d.failedCheck ? condition(d.failedCheck) : d.reason}`;
      if (e.type === 'candidate_detected') message = `Setup matched at ${usd(d.price)}; evaluating next stage`;
      if (e.type === 'candidate_rejected') message = `${d.stage} blocked entry · ${label(d.reason)}${d.blockers?.length ? ' · ' + d.blockers.map(label).join(', ') : ''}`;
      if (e.type === 'model_result') message = !d.requested ? `Jev skipped · ${label(d.error ?? 'mode off')}` : d.error ? `Jev error · ${label(d.error)}` : `Jev context ${d.pass ? 'passed' : 'declined'} · coherence ${n(d.coherence)}, quality ${n(d.quality)}, ${d.regime} · ${d.mode}`;
      if (e.type === 'order_submitting') message = `Submitting ${d.kind} intent · ${n(d.qty)} quantity`;
      if (e.type === 'order') message = `${label(d.kind)} order · ${label(d.status)}`;
      if (e.type === 'broker_update') message = `Alpaca reported ${label(d.status)} · ${label(d.side ?? '')} · ${n(d.qty)} cumulative filled · awaiting coordinator reconciliation`;
      if (e.type === 'fill') message = `${String(d.side ?? 'unknown side').toUpperCase()} fill observed · ${n(d.qty)} cumulative quantity at average ${usd(d.price)}`;
      if (e.type === 'quote_rejected') message = `Quote rejected · ${label(d.reason)}${d.ageMs == null ? '' : ` · ${(d.ageMs / 1000).toFixed(2)}s age`}`;
      if (e.type === 'control') message = `Operator requested ${label(d.action)}`;
      if (e.type === 'risk_settings_changed') message = `Daily loss ceiling changed from ${usd(d.previousDailyLoss)} to ${usd(d.dailyLoss)}`;
      if (e.type === 'fault') message = `Engine gate blocked · ${label(d.reason)}`;
      const id = String(e.id), node = existing.get(id) ?? document.createElement('details'); node.dataset.id = id; node.className = `log-row log-${e.category}`;
      if (!existing.has(id)) node.innerHTML = `<summary><time>${time(e.ts)}</time><span class="log-category">${esc(e.category)}</span><span><strong>${esc(d.symbol ?? 'ENGINE')}${d.strategy ? ' / ' + esc(label(d.strategy)) : ''}</strong><span>${esc(message)}</span></span></summary><p>${esc(d.note ?? '')}</p><code>${esc(d.candidateId ?? d.orderId ?? d.id ?? '')}</code>`;
      if (pane.children[i] !== node) pane.insertBefore(node, pane.children[i] ?? null);
    });
    while (pane.children.length > rows.length) pane.lastElementChild.remove();
    $('log-empty').hidden = rows.length > 0;
    if (wasAtBottom && this.live) pane.scrollTop = pane.scrollHeight;
  }
}
