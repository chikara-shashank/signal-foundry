import { writeFileSync } from 'node:fs';
const rows = [], start = Date.parse('2026-09-22T13:30:00Z'); let price = 100;
for (let i = 0; i < 180; i++) {
  const ts = start + i * 60000, open = price, phase = i % 48;
  price *= 1 + (phase < 30 ? .0008 : phase < 35 ? -.0015 : phase < 39 ? .0025 : -.0005);
  const quote = (now, p) => ({ kind: 'quote', symbol: 'SPY', now, ts: now, bid: p * .9998, ask: p * 1.0002 });
  rows.push(quote(ts + 60000, price));
  rows.push({ kind: 'bar', symbol: 'SPY', now: ts + 60000, ts, open, high: Math.max(open, price) * 1.0004, low: Math.min(open, price) * .9996, close: price, volume: phase >= 35 && phase < 39 ? 2500 : 1000 });
  rows.push(quote(ts + 61000, price));
}
writeFileSync('fixtures/synthetic.jsonl', rows.map(x => JSON.stringify(x)).join('\n') + '\n');
console.log('Generated deterministic synthetic fixture. It is not real historical market data.');
