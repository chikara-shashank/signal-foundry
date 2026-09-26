import { fixture } from '../test/helpers.js';
import { OptionsLab } from '../src/options-lab.js';

/** Isolated, deterministic visual fixture. Never loads .env or a provider. */
export async function designFixture() {
  const f = await fixture({ EQUITY_SYMBOLS: 'SPY,QQQ,NVDA,AMD,PLTR,MSFT', ACCOUNT_POLICY: 'shared', MAX_GROSS_USD: '5000', DAILY_LOSS_USD: '2000' });
  const end = Date.parse('2026-09-25T18:42:00Z');
  f.advance(end - f.now()); f.engine.operatorPause = true;
  f.engine.optionsLab = new OptionsLab(f.engine, null);
  const setup = [
    ['SPY', 657.21, .58, false], ['QQQ', 579.64, -.32, false],
    ['NVDA', 172.48, .83, false], ['AMD', 158.32, 1.14, true],
    ['PLTR', 149.63, -.61, true], ['MSFT', 519.44, .76, true],
  ];
  for (const [i, [symbol, price, change, closed]] of setup.entries()) {
    const start = end - (48 - i * 5) * 60000, close = closed ? start + 17 * 60000 : end;
    const id = `illustration-${symbol}`, qty = i === 0 ? 2 : 4;
    const strategy = i % 2 ? 'failed_breakout' : 'range_breakout';
    f.store.order({ id, symbol, kind: 'entry', strategy, status: 'filled', ts: start - 1000, filledAt: start, filledQty: qty, qty, fillPrice: price, fee: 0, feeRateBps: 0 });
    if (closed) f.store.order({ id: id + '-exit', entryId: id, symbol, kind: 'exit', status: 'filled', ts: close - 1000, filledAt: close, filledQty: qty, qty, fillPrice: price * (1 + change / 100), fee: 0 });
    else {
      f.engine.managed[symbol] = { entryId: id, strategy, openedAt: start, stop: price * .987, target: price * 1.025, maxHold: 3600000 };
      f.engine.positions.push({ symbol, qty, entryPrice: price, marketValue: qty * price * (1 + change / 100), unrealized: qty * price * change / 100 });
    }
    for (let j = 0; j < 120; j++) {
      const ts = end - (120 - j) * 60000, open = price * (1 - .003 + j * .000032 + Math.sin(j / 7 + i) * .0009);
      const value = open + Math.cos(j * .8 + i) * price * .00045;
      const bar = { symbol, ts, open, close: value, high: Math.max(open, value) + price * .00055, low: Math.min(open, value) - price * .00045, volume: 48000 + Math.round((1 + Math.sin(j / 4)) * 25000) };
      f.store.bar(bar);
      const features = f.engine.features.add(bar, end);
      if (features) f.engine.snapshots.set(symbol, features);
    }
    f.engine.quotes.set(symbol, { symbol, ts: end, bid: price * (1 + change / 100), ask: price * (1 + change / 100) + .02 });
    for (let ts = start + 10000; ts < close; ts += 10000) {
      const fraction = (ts - start) / (close - start), value = change * fraction + .22 * Math.sin(fraction * 5) * (1 - fraction);
      f.store.tradeMark(id, { ts, returnPct: value, net: qty * price * value / 100, qty, capital: qty * price, bid: price * (1 + value / 100), quoteAt: ts });
    }
  }
  for (let i = 0; i < 180; i++) {
    const ts = end - (180 - i) * 60000, dailyPnl = i * .73 + 8 * Math.sin(i / 14) - 18;
    for (const type of ['equity', 'agent_equity']) f.store.event(type, { dailyPnl, unrealized: dailyPnl * .18 }, ts);
  }
  f.engine.portfolio.positions = f.engine.positions;
  Object.assign(f.engine.portfolio.state, { valid: true, conflicts: [], dailyPnl: 112.38, unrealized: 19.84, managedGross: 4310.62, externalGross: 0, cashAvailable: 5689.38, baselineAt: end - 180 * 60000, note: 'Illustrative design data. No account connection or trading.' });
  f.engine.account = { ...f.engine.account, equity: 10112.38, cash: 5789.38, ts: end };
  f.engine.dailyPnl = 112.38; f.engine.lastReconcile = Date.now(); f.engine.lastLoop = Date.now();
  f.store.set('managed', f.engine.managed);
  return f;
}
