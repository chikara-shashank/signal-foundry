import { $, number, escape, label } from './dashboard-format.js';

export function renderCryptoSignals(s) {
  const signals = s.cryptoSignals;
  $('crypto-signals-panel').hidden = !signals || !s.market.some(m => m.symbol.includes('/'));
  if (!signals) return;
  $('crypto-signal-total').textContent = `${number(signals.detected)} detected · ${number(signals.approved)} risk approved`;
  for (const [id, key] of [['waiting', 'waiting'], ['expired', 'expired'], ['spread', 'spreadBlocked'], ['cost', 'costBlocked']]) {
    $(`crypto-signal-${id}`).textContent = number(signals[key]);
  }
  $('crypto-signal-pending').innerHTML = signals.pending.map(c => `<li><strong>${escape(c.symbol)}</strong> · ${escape(label(c.strategy))} · ${Math.max(0, Math.ceil((c.expires-s.now)/1000))}s left</li>`).join('');
  const ready = s.assetReadiness?.crypto;
  $('crypto-signal-state').textContent = s.paused ? 'New entries paused.' : !s.ready ? 'Account checks are blocking new entries.'
    : ready?.ready ? 'Fresh crypto quotes available. Each signal must pass its own entry checks.'
    : (ready?.blockers ?? []).map(label).join(' · ') || 'Waiting for crypto data.';
  $('crypto-signal-note').textContent = `Since this restart: ${number(signals.waited)} signals needed a fresh quote; ${number(signals.otherBlocked)} blocked by other checks. Waiting keeps the original signal deadline. Fees, spread and risk limits still apply.`;
}
