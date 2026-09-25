import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createDashboard } from '../src/server.js';
import { testConfig } from './helpers.js';

test('dashboard serves its complete module graph while keeping private files inaccessible', async () => {
  const cfg = testConfig(), server = createDashboard({ clock: () => Date.now() }, cfg);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = await (await fetch(origin)).text();
    const assets = [...html.matchAll(/(?:src|href)="(\/[^"#]+\.(?:js|css))"/g)].map(m => m[1]);
    const seen = new Set();
    while (assets.length) {
      const path = assets.pop(); if (seen.has(path)) continue; seen.add(path);
      const response = await fetch(origin + path);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get('content-type'), /text\/(javascript|css)/);
      const source = await response.text();
      for (const match of source.matchAll(/from\s+['"](\.\/[^'"]+\.js)['"]/g)) assets.push(new URL(match[1], origin + path).pathname);
    }
    assert.ok(seen.has('/dashboard-tabs.js')); assert.ok(seen.has('/trade-return-chart.js'));
    for (const path of ['/.env', '/src/store.js', '/data/paper.sqlite', '/dashboard-tabs.js/../.env']) {
      assert.equal((await fetch(origin + path)).status, 401);
      assert.equal((await fetch(origin + path, { headers: { Authorization: `Bearer ${cfg.token}` } })).status, 404);
    }
  } finally { server.closeStreams(); await new Promise(resolve => server.close(resolve)); }
});
