const $ = id => document.getElementById(id);
const label = s => String(s ?? '—').replaceAll('_', ' ');
const stamp = ts => new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
const json = value => JSON.stringify(value, null, 2);

export class JevLog {
  constructor(api) {
    this.api = api; this.sequence = 0; this.selection = 0; this.rows = []; this.frozen = false; this.selected = null;
    $('jev-io-symbol').addEventListener('change', () => { this.reset(); void this.refresh(this.status); });
    $('jev-io-freeze').addEventListener('click', () => {
      this.frozen = !this.frozen; this.sequence++; this.selection++;
      $('jev-io-freeze').textContent = this.frozen ? 'Follow live I/O' : 'Freeze I/O view';
      $('jev-io-state').textContent = this.frozen ? 'VIEW FROZEN · TRADING UNCHANGED' : 'FOLLOWING';
      if (!this.frozen) void this.refresh(this.status);
    });
    $('jev-io-list').addEventListener('click', e => {
      const id = e.target.closest('[data-trace]')?.dataset.trace;
      if (!id) return; this.selected = id; this.paintRows(); void this.detail(id);
    });
    $('jev-io-latest').addEventListener('click', () => { this.selected = null; this.paintRows(); if (this.rows[0]) void this.detail(this.rows[0].id); });
  }
  reset() { this.sequence++; this.selection++; this.selected = null; this.rows = []; this.paintRows(); this.clearDetail(); }
  clearDetail() {
    $('jev-io-impact').textContent = 'Select a record to inspect the model input, parsed output and final entry decision.';
    $('jev-io-meta').textContent = ''; $('jev-io-capture').textContent = '';
    $('jev-io-input-title').textContent = 'Request body'; $('jev-io-input').textContent = 'No request selected.'; $('jev-io-output').textContent = 'No response selected.';
  }
  clear() { this.status = null; this.reset(); }
  async refresh(status) {
    if (!status) return; this.status = status;
    const universe = status.market.map(m => m.symbol).join(',');
    if ($('jev-io-symbol').dataset.universe !== universe) {
      const previous = $('jev-io-symbol').value;
      $('jev-io-symbol').replaceChildren(new Option('All instruments', ''), ...status.market.map(m => new Option(m.symbol, m.symbol)));
      $('jev-io-symbol').value = status.market.some(m => m.symbol === previous) ? previous : '';
      $('jev-io-symbol').dataset.universe = universe;
    }
    if (this.frozen) return;
    const sequence = ++this.sequence;
    try {
      const page = await this.api(`/api/jev-traces?limit=40&symbol=${encodeURIComponent($('jev-io-symbol').value)}`);
      if (sequence !== this.sequence || this.frozen) return;
      this.rows = page.rows;
      if (this.selected && !this.rows.some(r => r.id === this.selected)) this.selected = null;
      this.paintRows();
      const run = page.currentRunInView;
      $('jev-io-state').textContent = `FOLLOWING · ${page.mode.toUpperCase()}`;
      $('jev-io-summary').textContent = `${this.rows.length} recent records in this view · ${run?.requested ?? '—'} HTTP attempts from this run in this view · ${run?.skipped ?? '—'} skipped before HTTP. Run identity is independent of clock offsets. ${page.mode === 'shadow' ? 'Current shadow mode records classifications without vetoing entries.' : page.mode === 'filter' ? 'Current filter mode requires Jev to pass before automatic entry and risk checks.' : 'Jev is currently off.'}`;
      $('jev-io-note').textContent = `${page.note} Refreshes every 2 seconds. View controls do not pause the engine.`;
      if (this.rows.length) await this.detail(this.selected ?? this.rows[0].id);
      else this.clearDetail();
    } catch (e) { if (sequence === this.sequence) { $('jev-io-state').textContent = 'I/O LOG UNAVAILABLE'; $('jev-io-note').textContent = e.message; } }
  }
  paintRows() {
    const list = $('jev-io-list'), scroll = list.scrollTop, active = this.selected ?? this.rows[0]?.id;
    const existing = new Map([...list.children].map(node => [node.dataset.trace, node]));
    const nodes = this.rows.map(r => {
      const node = existing.get(r.id) ?? document.createElement('button'); node.type = 'button'; node.dataset.trace = r.id;
      node.className = 'jev-io-row'; node.setAttribute('aria-pressed', String(r.id === active));
      const text = `${stamp(r.ts)} · ${r.symbol} · ${label(r.strategy)}\n${r.mode ?? 'unknown mode'} · ${r.requested ? r.status : 'HTTP skipped'} · ${Number.isFinite(r.latencyMs) ? r.latencyMs.toFixed(0) + ' ms' : '— ms'} · ${label(r.decision.reason ?? r.decision.status)}`;
      if (node.textContent !== text) node.textContent = text;
      return node;
    });
    // Preserve focused rows and the operator's scroll position during polling.
    nodes.forEach((node, i) => { if (list.children[i] !== node) list.insertBefore(node, list.children[i] ?? null); });
    while (list.children.length > nodes.length) list.lastElementChild.remove();
    list.scrollTop = scroll; $('jev-io-empty').hidden = !!this.rows.length;
  }
  async detail(id) {
    const selection = ++this.selection;
    try {
      const t = await this.api(`/api/jev-trace?id=${encodeURIComponent(id)}`);
      if (selection !== this.selection || !this.status) return;
      const cost = Number.isFinite(t.cost) ? `$${t.cost.toFixed(7)} estimated` : t.requested ? 'Cost unknown; conservative budget reservation retained' : 'No model cost';
      $('jev-io-impact').textContent = `${t.decision.impact}. Entry: ${label(t.decision.status)}${t.decision.reason ? ' · ' + label(t.decision.reason) : ''}${t.decision.blockers?.length ? ' · ' + t.decision.blockers.map(label).join(', ') : ''}${t.decision.orderId ? ' · order ' + t.decision.orderId : ''}.`;
      $('jev-io-meta').textContent = `${stamp(t.ts)} · ${t.symbol} · ${label(t.strategy)} · ${t.mode} · ${t.model ?? 'model not retained'} · ${t.status} · rubric ${t.rubricVersion ?? 'historical'} · request window ${Number.isFinite(t.timeoutBudgetMs) ? t.timeoutBudgetMs + ' ms' : 'not recorded'} · HTTP ${t.httpStatus ?? 'not recorded'} · ${Number.isFinite(t.latencyMs) ? t.latencyMs.toFixed(1) + ' ms' : 'latency unavailable'} · ${cost}${t.error ? ' · ' + label(t.error) : ''}`;
      $('jev-io-capture').textContent = t.captureNote ?? (t.requested ? 'Exact JSON request body; validated response fields only. Authorization headers, credentials and unexpected provider fields are excluded.' : 'No HTTP request was sent. The skip reason above explains why.') + (t.thresholds ? ` Context thresholds: coherence ≥ ${t.thresholds.coherence}; normalized quality ≥ ${t.thresholds.quality}; excludes ${t.thresholds.excludedRegime}.` : '');
      $('jev-io-input-title').textContent = t.historicalContext ? 'Historical numerical context · original request unavailable' : 'Exact request body';
      const input = t.input ?? t.historicalContext;
      const inputText = input ? json(input) : 'No HTTP request was sent.';
      const outputText = t.output ? json(t.output) : t.status === 'inflight' ? 'Awaiting Jev response…' : t.status === 'interrupted' ? 'Process ended before a response was recorded. Billing outcome unknown.' : t.error ? `No validated response. ${label(t.error)}.` : 'No response.';
      if ($('jev-io-input').textContent !== inputText) $('jev-io-input').textContent = inputText;
      if ($('jev-io-output').textContent !== outputText) $('jev-io-output').textContent = outputText;
    } catch (e) { if (selection === this.selection) $('jev-io-impact').textContent = `Trace unavailable: ${e.message}`; }
  }
}
