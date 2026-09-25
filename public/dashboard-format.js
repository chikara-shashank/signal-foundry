export const $ = id => document.getElementById(id);
export const money = n => n == null ? '—' : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
export const number = n => Number(n ?? 0).toLocaleString('en-US', { maximumFractionDigits: 6 });
export const quotePrice = n => Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });
export const time = t => new Date(t).toLocaleTimeString('en-US', { hour12: false });
export const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const label = s => String(s).replaceAll('_', ' ');
export const empty = (n, text) => `<tr><td colspan="${n}" class="empty">${escape(text)}</td></tr>`;
