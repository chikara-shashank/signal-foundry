import { optionLegs } from '../src/options-structure.js';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { resolve, join } from 'node:path';
import { OptionsData } from '../src/options-data.js';
import { OPTIONS_STRATEGIES, scanOptions } from '../src/options-strategies.js';
import { freshOptionsState, advanceOptions, optionsSummary, replayOptions, replayOptionsStress, optionsRecord } from '../src/options-lab.js';

const args = process.argv.slice(2), command = args.shift();
const value = (key, fallback) => { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1]; };
try {
  if (['replay','stress-replay'].includes(command)) {
    const paths = args.filter(x => !x.startsWith('--'));
    if (!paths.length) throw new Error('Usage: options-research.js replay tape1.jsonl [tape2.jsonl ...]');
    const expand=path=>statSync(path).isDirectory()?readdirSync(path).sort().flatMap(x=>expand(join(path,x))):/\.(jsonl|json\.gz)$/.test(path)?[path]:[];
    const records = paths.flatMap(expand).flatMap(path => (path.endsWith('.gz')?gunzipSync(readFileSync(path)).toString('utf8'):readFileSync(path,'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse));
    console.log(JSON.stringify(command==='stress-replay'?replayOptionsStress(records):replayOptions(records), null, 2));
  } else if (['scan', 'record'].includes(command)) {
    const out = resolve(value('--out', 'work/options-' + Date.now())), seconds = Number(value('--seconds', '60'));
    const universe = value('--symbols', 'SPY,QQQ').split(','), enabled = value('--strategies', OPTIONS_STRATEGIES.map(s => s.id).join(',')).split(',');
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600 || enabled.some(id => !OPTIONS_STRATEGIES.some(s => s.id === id))) throw new Error('Require 1–3600 seconds and installed strategy IDs');
    mkdirSync(out, { recursive: true });
    const tape = join(out, 'tape.jsonl');
    if (existsSync(tape)) throw new Error('Output tape already exists; choose a new directory');
    const data = new OptionsData({ key: process.env.ALPACA_KEY, secret: process.env.ALPACA_SECRET });
    const state = freshOptionsState(); state.enabled = Object.fromEntries(OPTIONS_STRATEGIES.map(s => [s.id, enabled.includes(s.id)]));
    const deadline = Date.now() + seconds * 1000; let observations = 0, scan;
    do {
      const watched = [...state.positions, ...state.pending].flatMap(p => optionLegs(p).map(l=>l.contract));
      const frame = await data.capture(universe, watched);
      appendFileSync(tape, JSON.stringify(optionsRecord(state, frame, true, observations === 0)) + '\n');
      advanceOptions(state, frame); scan = scanOptions(frame, enabled); observations++;
      writeFileSync(join(out, 'scan.json'), JSON.stringify({ at: new Date(frame.now).toISOString(), marketOpen: frame.marketOpen, contracts: Object.keys(frame.contracts).length,
        quotes: Object.keys(frame.quotes).length, contexts: frame.contexts, ...scan }, null, 2));
      if (command === 'scan' || Date.now() + 30000 >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, 30000));
    } while (Date.now() < deadline);
    const report = { ...optionsSummary(state), observations, out };
    writeFileSync(join(out, 'summary.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ out, observations, mode: report.mode, closedTrades: state.trades.length, positions: state.positions.length, pending: state.pending.length, candidates: scan.candidates.length, rejected: scan.rejected, validation: report.validation }, null, 2));
  } else throw new Error('Usage: options-research.js scan|record --out directory [--seconds 60] [--symbols SPY,QQQ] | replay tape.jsonl');
} catch (error) {
  console.error(/^options_|^Usage:|^Require |^Output tape/.test(error.message) ? error.message : 'Options research failed; check data entitlement, credentials, file paths and connection.');
  process.exitCode = 1;
}
