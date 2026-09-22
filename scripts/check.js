import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
function walk(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : []); }
let failed = false;
for (const file of ['src', 'scripts', 'test', 'public'].flatMap(walk)) { const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' }); if (r.status) { failed = true; console.error(file, r.stderr); } }
if (failed) process.exit(1); console.log('All JavaScript files passed syntax validation.');
