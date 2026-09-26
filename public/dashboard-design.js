import { DESIGNS, DASHBOARD_THEMES, findDesign } from './design-catalog.js';
import { $, escape } from './dashboard-format.js';

const STORAGE_KEY = 'signal-foundry.dashboard-theme';
export class DashboardDesign {
  constructor({ persist = true, preview = false } = {}) {
    this.persist = persist;
    this.preview = preview;
    this.choices = preview ? DESIGNS : DASHBOARD_THEMES;
    this.dialog = $('design-dialog');
    this.dialog.classList.toggle('theme-dialog', !preview);
    if (preview) {
      $('design-title').textContent = 'Ten dashboard studies.';
      $('design-description').textContent = 'Explore every design with the same illustrative data.';
      $('design-previous').textContent = '‹'; $('design-next').textContent = '›';
      $('design-previous').setAttribute('aria-label', 'Previous dashboard design');
      $('design-next').setAttribute('aria-label', 'Next dashboard design');
      $('design-previous').removeAttribute('aria-pressed'); $('design-next').removeAttribute('aria-pressed');
    }
    $('design-choices').innerHTML = this.choices.map(design => `<button type="button" class="design-choice" data-design-choice="${design.id}" aria-pressed="false">
      <span class="design-mini" data-mini-theme="${design.theme}" data-mini-layout="${design.layout}" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
      <span class="design-choice-title"><span>${design.number}</span><strong>${design.name}</strong></span><small>${escape(design.detail)}</small><p>${escape(design.description)}</p>
    </button>`).join('');
    this.dialog.addEventListener('click', event => {
      const button = event.target.closest('[data-design-choice]');
      if (button) { this.apply(button.dataset.designChoice); this.dialog.close(); }
    });
    $('design-open').addEventListener('click', () => this.dialog.showModal());
    $('design-previous').addEventListener('click', () => preview ? this.step(-1) : this.apply('ledger'));
    $('design-next').addEventListener('click', () => preview ? this.step(1) : this.apply('copper'));
    let saved;
    try { if (persist) saved = localStorage.getItem(STORAGE_KEY); } catch { /* A private browser may disallow preferences. */ }
    this.apply(new URL(location.href).searchParams.get('design') ?? saved, false);
  }
  step(direction) {
    const index = this.choices.findIndex(design => design.id === this.current.id);
    this.apply(this.choices[(index + direction + this.choices.length) % this.choices.length].id);
  }
  apply(id, persist = true) {
    const requested = findDesign(id);
    this.current = this.choices.includes(requested) ? requested : findDesign();
    document.documentElement.dataset.design = this.current.id;
    document.documentElement.dataset.designTheme = this.current.theme;
    $('design-current').textContent = this.preview ? `${this.current.number} / ${this.current.name}` : this.current.name;
    $('design-open').setAttribute('aria-label', `Choose dashboard design. Current: ${this.current.name}`);
    for (const button of this.dialog.querySelectorAll('[data-design-choice]')) button.setAttribute('aria-pressed', String(button.dataset.designChoice === this.current.id));
    if (!this.preview) {
      $('design-previous').setAttribute('aria-pressed', String(this.current.theme === 'light'));
      $('design-next').setAttribute('aria-pressed', String(this.current.theme === 'dark'));
    }
    if (persist && this.persist) {
      try { localStorage.setItem(STORAGE_KEY, this.current.id); } catch { /* The current document still applies the design. */ }
      const url = new URL(location.href); url.searchParams.set('design', this.current.id); history.replaceState(null, '', url);
    }
    document.dispatchEvent(new Event('dashboard-design-change'));
  }
}
