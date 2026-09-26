/** Runs only inside generated, broker-free design-study frames. */
export async function hydrateDesignPreview(payload) {
  const { modules, data, designId } = payload;
  const urls = new Map();
  function moduleUrl(name) {
    if (urls.has(name)) return urls.get(name);
    const code = modules[name].replace(/from\s+(['"])(\.\/[^'"]+\.js)\1/g, (_, quote, path) => `from ${quote}${moduleUrl(path.slice(2))}${quote}`);
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' })); urls.set(name, url); return url;
  }
  const [designModule, tabsModule, panelsModule, chartModule, accountModule, tradeModule, statusModule] = await Promise.all([
    'dashboard-design.js', 'dashboard-tabs.js', 'performance-panels.js', 'chart.js', 'account-performance.js', 'trade-performance.js', 'dashboard-status.js',
  ].map(name => import(moduleUrl(name))));
  const $ = id => document.getElementById(id);
  const api = async (path, body) => {
    if (body) throw new Error('Design preview cannot place orders or change account settings.');
    const url = new URL(path, 'https://design.invalid');
    if (url.pathname === '/api/performance') return structuredClone(data.accounts[url.searchParams.get('scope') === 'account' ? 'account' : 'agent']);
    if (url.pathname === '/api/trade-performance') return structuredClone(data.returns[Number(url.searchParams.get('interval') ?? 1)]);
    throw new Error('This design study shows the Live and Performance views.');
  };
  const designer = new designModule.DashboardDesign({ persist: false, preview: true }); designer.apply(designId, false);
  document.addEventListener('dashboard-design-change', () => window.parent.postMessage({ type: 'design-selected', id: document.documentElement.dataset.design }, '*'));
  const panels = new panelsModule.PerformancePanels();
  const tabs = new tabsModule.DashboardTabs(() => { panels.show(tabs.active); }, { history: false });
  const price = new chartModule.TradingChart($('price-chart'), $('chart-tooltip'), () => {});
  const account = new accountModule.AccountPerformanceView(api), trades = new tradeModule.TradePerformanceView(api);
  $('login').hidden = true; $('main').hidden = false;
  statusModule.renderStatus(data.status); account.setStatus(data.status);
  $('mode').textContent = 'DESIGN STUDY'; $('clock').textContent = '14:42 ET / ILLUSTRATIVE';
  $('warnings').hidden = false; $('warnings').textContent = 'Illustrative data · no account connection · trading controls disabled';
  $('live-state').textContent = 'Design study. Layout, hierarchy and chart treatments only.';
  $('data-source').textContent = 'Market overview'; $('data-explanation').textContent = 'Illustrative quotes and completed one-minute bars. No provider requests.';
  $('connection-badges').innerHTML = '<span class="connection-tag">US equities / 1m</span><span class="connection-tag">6 instruments</span>';
  $('chart-symbol').innerHTML = '<option>SPY</option>'; $('chart-price').textContent = '$661.02'; $('chart-reference-label').textContent = 'MIDPOINT · REFERENCE';
  $('chart-quote').textContent = 'Illustrative quote · 14:42:00 ET'; $('chart-mode').textContent = 'DESIGN STUDY'; $('chart-state').textContent = 'One-minute observations';
  $('quote-bid').textContent = '$661.01'; $('quote-ask').textContent = '$661.03'; $('quote-spread').textContent = '$0.02 / 0.3 bps';
  $('position-pnl').textContent = '+$7.62'; $('position-pnl').className = 'positive'; $('position-pnl-basis').textContent = '2 units · illustrative bid mark';
  $('chart-summary').textContent = '120 completed bars · 1m'; $('push-state').textContent = 'Static design illustration'; $('chart-note').textContent = 'Chart components match the working dashboard; values are fictional.';
  $('tape-source').textContent = 'ILLUSTRATION';
  const events = [['14:39:12', 'NVDA', 'Buy fill', '$172.48', 'positive'], ['14:37:08', 'AMD', 'Exit fill', '$160.12', 'positive'], ['14:35:42', 'PLTR', 'Exit fill', '$148.72', 'negative'], ['14:32:01', 'QQQ', 'Buy fill', '$579.64', 'positive'], ['14:30:05', 'SPY', 'Buy fill', '$657.21', 'positive']];
  $('trade-tape').innerHTML = events.map(([time, symbol, action, value, tone]) => `<div class="tape-row"><span class="${tone}">${action === 'Buy fill' ? '▲' : '▼'}</span><span><strong>${symbol} / ${action}</strong><small>Illustrative recorded fill</small></span><span class="tape-time">${time}<small>${value}</small></span></div>`).join('');
  $('trade-detail').innerHTML = '<span class="eyebrow">EXECUTION CONTEXT</span><p>Range breakout / SPY</p><dl><dt>Entry</dt><dd>$657.21</dd><dt>Quantity</dt><dd>2 units</dd><dt>State</dt><dd>Monitoring</dd><dt>Source</dt><dd>Illustrative fixture</dd></dl>';
  $('latency-cards').innerHTML = ['Feed / 38ms', 'Browser / 12ms', 'Canvas / 0.7ms', 'Worker / 6ms', 'Jev / —', 'Broker / —'].map(text => `<div><span>${text.split(' / ')[0]}</span><strong>${text.split(' / ')[1]}</strong><small>Illustrative timing</small></div>`).join('');
  $('latency-note').textContent = 'Design illustration; these are not measurements of your engine.';
  $('updated').textContent = 'Design collection / v1.16';
  for (const button of document.querySelectorAll('[data-action], #disconnect, #paper-test, #save-risk')) button.disabled = true;
  for (const button of document.querySelectorAll('[data-interval]')) button.disabled = true;
  for (const tab of document.querySelectorAll('[data-tab]')) if (!['live', 'performance'].includes(tab.dataset.tab)) { tab.disabled = true; tab.title = 'This study previews Live and Performance. All views work in the real dashboard.'; }
  // No form in this artifact may submit, including via Enter.
  document.addEventListener('submit', event => { if (event.target.method !== 'dialog') event.preventDefault(); });
  document.addEventListener('click', event => {
    const anchor = event.target.closest('a');
    if (anchor && !['#view-live', '#view-performance', '#trade-return-panel'].includes(anchor.getAttribute('href'))) event.preventDefault();
  }, true);
  $('chart-in').addEventListener('click', () => price.zoom(-1)); $('chart-out').addEventListener('click', () => price.zoom(1));
  $('chart-back').addEventListener('click', () => price.pan(1)); $('chart-forward').addEventListener('click', () => price.pan(-1));
  $('chart-follow').addEventListener('click', () => price.reset());
  $('chart-signals').addEventListener('change', event => { price.showSignals = event.target.checked; price.draw(); });
  $('chart-averages').addEventListener('change', event => { price.showAverages = event.target.checked; price.draw(); });
  price.update(data.chart); await account.refresh(); await trades.refresh(true);
  document.documentElement.dataset.previewReady = 'true';
  window.parent.postMessage({ type: 'design-ready', id: designId }, '*');
}
