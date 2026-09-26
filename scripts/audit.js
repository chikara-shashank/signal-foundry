import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const directories = ['src', 'public', 'scripts', 'test', 'docs', 'deploy', 'fixtures', '.github'];
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
const files = directories.flatMap(dir => walk(join(root, dir)));
const modules = files.filter(file => file.endsWith('.js'));
const source = new Map(modules.map(file => [file, readFileSync(file, 'utf8')]));
const short = file => relative(root, file).replaceAll('\\', '/');
const occurrences = (text, word) => [...text.matchAll(new RegExp(`\\b${word.replaceAll('$', '\\$')}\\b`, 'g'))].length;
const graph = new Map(), missingImports = [], unusedImports = [];

for (const [file, text] of source) {
  const edges = [];
  // Static imports, relative dynamic imports and worker URLs. Public asset
  // loading is additionally exercised by dashboard-assets.test.js.
  for (const match of text.matchAll(/['"](\.\.?\/[^'"\s]+\.js)['"]/g)) {
    const target = resolve(dirname(file), match[1]); edges.push(target);
    if (!existsSync(target)) missingImports.push({ file: short(file), target: match[1] });
  }
  graph.set(file, edges);
  for (const match of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    for (const binding of match[1].split(',')) {
      const name = binding.trim().split(/\s+as\s+/).at(-1);
      if (name && occurrences(text, name) === 1) unusedImports.push({ file: short(file), name });
    }
  }
}
const all = [...source].filter(([file]) => file !== fileURLToPath(import.meta.url)).map(([, text]) => text).join('\n');
const singleUseExports = [...source].flatMap(([file, text]) => [...text.matchAll(/export\s+(?:async\s+)?(?:const|let|function|class)\s+(\w+)/g)]
  .filter(match => occurrences(all, match[1]) === 1).map(match => ({ file: short(file), name: match[1] })));
const reachable = new Set();
function visit(file) { if (reachable.has(file)) return; reachable.add(file); for (const target of graph.get(file) ?? []) visit(target); }
// Every command is independently executable; tests and worker entrypoints are
// intentionally retained even when they are not imported by the HTTP server.
for (const file of modules.filter(file => /[/\\](scripts|test)[/\\]/.test(file))) visit(file);
visit(join(root, 'src/main.js')); visit(join(root, 'src/strategy-worker.js')); visit(join(root, 'public/app.js'));
const digest = new Map();
for (const file of files) {
  const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (!digest.has(hash)) digest.set(hash, []);
  digest.get(hash).push(short(file));
}
const report = {
  scannedFiles: files.length, javascriptModules: modules.length,
  missingImports, unreachableModules: modules.filter(file => !reachable.has(file)).map(short),
  unusedImports, singleUseExports, duplicateFiles: [...digest.values()].filter(group => group.length > 1),
  scope: 'Conservative static audit. Dynamic dispatch and externally invoked commands require review; absence of findings is not proof that every branch is exercised. Secrets, journals, backups and Git metadata are excluded.',
};
console.log(JSON.stringify(report, null, 2));
if (missingImports.length || report.unreachableModules.length) process.exitCode = 1;
