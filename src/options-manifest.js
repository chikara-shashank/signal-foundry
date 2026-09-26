import { readFileSync } from 'node:fs';
import { hash } from './util.js';
export const OPTIONS_CODE_HASH = hash(['options-policy.js','options-context.js','options-pricing.js','options-structure.js','options-condor.js','options-strategies.js','options-state.js','options-replay.js','options-manifest.js','options-data.js','options-lab.js','options-tape.js','store.js','util.js','broker-budget.js'].map(file => [file, readFileSync(new URL(file, import.meta.url), 'utf8').replaceAll('\r\n', '\n')]));
