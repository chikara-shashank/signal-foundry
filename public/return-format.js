export const pct = n => Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}%` : '—';
export const cash = n => Number.isFinite(n) ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : '—';
export const date = ts => ts == null ? 'Time unavailable' : new Date(ts).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
export const tone = n => !Number.isFinite(n) || Math.abs(n) < 1e-9 ? 'neutral' : n > 0 ? 'positive' : 'negative';
export const color = n => !Number.isFinite(n) || Math.abs(n) < 1e-9 ? '#abc1d0' : n > 0 ? '#80ddb0' : '#ff8794';
