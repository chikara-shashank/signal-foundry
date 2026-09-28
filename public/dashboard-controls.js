import { $, money, label } from './dashboard-format.js';

/** Operator controls keep their state across tabs and ordinary status refreshes. */
export class DashboardControls {
  constructor(api, refresh, getSymbol, invalidatePerformance) {
    Object.assign(this, { api, refresh, getSymbol, invalidatePerformance, paperRequest: null });
    this.clear();
    document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', async () => {
      const action = button.dataset.action;
      if (action === 'flatten' && !confirm('Pause entries and request closure of all positions managed by this engine? Orders may fill at a loss.')) return;
      if (action === 'reset_drawdown_brake' && !confirm('Reset the drawdown brake? New entries resume, and the current P/L becomes the new high-water mark.')) return;
      button.disabled = true;
      try { await this.api('/api/control', { action, ...(action === 'flatten' ? { confirmation: 'FLATTEN_MANAGED_POSITIONS' } : {}) }); $('action-message').textContent = `${label(action)} requested. Inspect order states for completion.`; await this.refresh(); }
      catch (e) { $('action-message').textContent = e.message; }
      finally { button.disabled = false; }
    }));
    $('paper-test').addEventListener('click', async () => {
      if (this.status?.mode !== 'paper') return;
      if (!this.paperRequest && !confirm(`Send an Alpaca PAPER test for ${this.getSymbol()}? Maximum one share or $25 crypto, subject to risk limits. The engine attempts to exit after 60 seconds.`)) return;
      this.paperRequest ??= { symbol: this.getSymbol(), requestId: crypto.randomUUID(), confirmation: 'PAPER_MONEY_ONLY' };
      $('paper-test').disabled = true;
      try {
        const result = await this.api('/api/paper-test', this.paperRequest);
        $('paper-test-result').textContent = `${label(result.status)} · ${label(result.reason ?? 'Intent recorded. Follow the execution tape for acknowledgment and fills.')}`;
        this.paperRequest = null; $('paper-test').textContent = 'Send paper test trade'; await this.refresh();
      } catch(e) { $('paper-test-result').textContent = `${e.message}. Outcome may be pending; retry checks the same request.`; $('paper-test').textContent = 'Check same paper test'; }
      finally { $('paper-test').disabled = false; }
    });
    $('daily-loss-input').addEventListener('input', () => { this.riskDirty = true; $('risk-result').textContent = 'Unsaved change'; });
    $('risk-form').addEventListener('submit', async e => {
      e.preventDefault(); if (this.riskSaving || this.riskExpected == null) return;
      this.riskSaving = true; $('save-risk').disabled = true;
      try {
        const result = await this.api('/api/risk-settings', { dailyLoss: Number($('daily-loss-input').value), expectedDailyLoss: this.riskExpected });
        this.riskExpected = result.dailyLoss; this.riskDirty = false; $('daily-loss-input').value = result.dailyLoss; this.invalidatePerformance();
        $('risk-result').textContent = `Saved ${money(result.dailyLoss)}. ${result.halted ? 'The daily halt remains active for ' + result.day + '.' : 'Applies immediately and survives restarts.'}`;
      } catch (error) { $('risk-result').textContent = error.message; if (this.status) this.riskExpected = this.status.limits.dailyLoss; }
      finally { this.riskSaving = false; $('save-risk').disabled = false; void this.refresh(); }
    });

  }
  clear() { this.status = null; this.riskDirty = false; this.riskSaving = false; this.riskExpected = null; }
  render(status) {
    this.status = status;
    if (!this.riskDirty && !this.riskSaving) { $('daily-loss-input').value = status.limits.dailyLoss; this.riskExpected = status.limits.dailyLoss; }
    $('risk-source').textContent = `${status.limits.dailyLossOverride ? 'Saved dashboard override' : 'Environment default'} · ${money(status.limits.dailyLoss)} active${status.limits.dailyLossHalted ? ' · HALTED FOR TODAY' : ''}. Changes persist across restarts.`;
    $('paper-test-panel').hidden = status.mode !== 'paper';
    const levels = status.riskLevels, brake = levels?.brake;
    $('reset-brake').hidden = !(levels?.mode === 'auto' && brake?.state === 'halted');
    $('risk-levels').textContent = levels?.mode !== 'auto' ? 'Automatic risk levels are off (RISK_LEVELS=off): every limit is the .env value.'
      : `Risk levels on, up to Level ${levels.max}. Limits in use ×${levels.portfolioMultiplier}; daily loss ceiling in effect ${money(status.limits.effectiveDailyLoss)}. `
        + `Drawdown brake ${label(brake.state)}: ${brake.drawdownPct.toFixed(1)}% of ${money(brake.budget)} (halves trade size at ${brake.halvePct}%, stops new entries at ${brake.haltPct}%).`;
  }
}
