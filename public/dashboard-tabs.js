/** Accessible, hash-addressable views. Tab changes never control the engine. */
export class DashboardTabs {
  constructor(onChange, { history: useHistory = true } = {}) {
    this.onChange = onChange;
    this.useHistory = useHistory;
    this.buttons = [...document.querySelectorAll('[role="tab"][data-tab]')];
    this.panels = [...document.querySelectorAll('.dashboard-view[role="tabpanel"]')];
    this.active = null;
    this.route(false);
    for (const button of this.buttons) {
      button.addEventListener('click', () => this.navigate(`view-${button.dataset.tab}`));
      button.addEventListener('keydown', event => {
        const index = this.buttons.indexOf(button), count = this.buttons.length;
        const next = { ArrowRight: (index + 1) % count, ArrowLeft: (index + count - 1) % count, Home: 0, End: count - 1 }[event.key];
        if (next == null) return;
        event.preventDefault(); this.buttons[next].focus(); this.buttons[next].click();
      });
    }
    document.addEventListener('click', event => {
      const link = event.target.closest('a[href^="#"]');
      if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button) return;
      const id = this.decode(link.hash.slice(1));
      if (!document.getElementById(id)?.closest('.dashboard-view')) return;
      event.preventDefault(); this.navigate(id);
    });
    window.addEventListener('hashchange', () => this.route());
  }
  decode(value) { try { return decodeURIComponent(value); } catch { return ''; } }
  navigate(id) {
    const hash = `#${encodeURIComponent(id)}`;
    if (this.useHistory && location.hash !== hash) history.pushState(null, '', hash);
    this.route(true, id);
  }
  route(notify = true, requestedId) {
    const id = requestedId ?? this.decode(location.hash.slice(1)), anchor = document.getElementById(id);
    const target = anchor?.closest('.dashboard-view') ?? this.panels[0];
    const next = target.id.replace('view-', ''), changed = next !== this.active;
    this.active = next;
    for (const panel of this.panels) panel.hidden = panel !== target;
    for (const button of this.buttons) {
      const selected = button.dataset.tab === next;
      button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
    }
    if (document.activeElement?.closest('.dashboard-view')?.hidden) target.focus({ preventScroll: true });
    this.anchor = anchor;
    if (notify && changed) this.onChange(next);
    this.revealAnchor();
  }
  revealAnchor() {
    if (!this.anchor || document.getElementById('main').hidden) return;
    const anchor = this.anchor; this.anchor = null;
    requestAnimationFrame(() => anchor.scrollIntoView({ block: 'start' }));
  }
}
