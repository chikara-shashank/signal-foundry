/** One set of charts, filters and request state shared by Live and Performance. */
export class PerformancePanels {
  constructor() {
    this.panels = [document.getElementById('trade-return-panel'), document.getElementById('account-performance-panel')];
  }
  show(view) {
    const host = document.getElementById(view === 'performance' ? 'history-performance' : 'live-performance');
    if (this.panels[0].parentElement !== host) host.append(...this.panels);
  }
}
