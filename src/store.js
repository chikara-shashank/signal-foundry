import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export class Store {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bars (symbol TEXT NOT NULL, ts INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(symbol,ts));
      CREATE TABLE IF NOT EXISTS candidates (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, symbol TEXT NOT NULL, strategy TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, symbol TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, ts INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS spending (id TEXT PRIMARY KEY, month TEXT NOT NULL, reserved REAL NOT NULL, actual REAL, ts INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS model_traces (id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, ts INTEGER NOT NULL, symbol TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS model_trace_ts ON model_traces(ts);
      CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
      CREATE INDEX IF NOT EXISTS events_type_ts ON events(type,ts);
      CREATE INDEX IF NOT EXISTS candidate_ts ON candidates(ts);
      CREATE INDEX IF NOT EXISTS candidate_symbol_ts ON candidates(symbol,ts);
      CREATE INDEX IF NOT EXISTS order_symbol_ts ON orders(symbol,ts);
      CREATE INDEX IF NOT EXISTS order_status ON orders(status);`);
    this.owner = randomUUID();
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const v = fn(); this.db.exec('COMMIT'); return v; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  get(key, fallback = null) { const r = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key); return r ? JSON.parse(r.value) : fallback; }
  set(key, value) { this.db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  lease(now, ttl = 120000) {
    return this.transaction(() => {
      const prior = this.get('lease');
      if (this.heldLease && prior?.owner !== this.owner) throw new Error('Engine lease lost');
      if (prior && prior.owner !== this.owner && prior.until > now) throw new Error('Another engine owns this database');
      this.set('lease', { owner: this.owner, until: now + ttl });
      this.heldLease = true;
    });
  }
  assertLease(now = Date.now()) {
    const lease = this.get('lease');
    if (!lease || lease.owner !== this.owner || lease.until <= now) throw new Error('Engine lease lost');
  }
  release() { if (this.get('lease')?.owner === this.owner) this.set('lease', null); }
  event(type, data = {}, ts = Date.now()) { this.db.prepare('INSERT INTO events(ts,type,data) VALUES(?,?,?)').run(ts, type, JSON.stringify(data)); }
  events(limit = 100) { return this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit).map(x => ({ ...x, data: JSON.parse(x.data) })); }
  eventsOfType(type, since, limit = 5000) { return this.db.prepare('SELECT ts,data FROM events WHERE type=? AND ts>=? ORDER BY ts DESC LIMIT ?').all(type, since, limit).reverse().map(x => ({ ts: x.ts, ...JSON.parse(x.data) })); }
  activityPage(after, types, symbol, limit) {
    const latest = this.db.prepare('SELECT COALESCE(MAX(id),0) id FROM events').get().id;
    const reset = after > latest; if (reset) after = 0;
    const where = `type IN (${types.map(() => '?').join(',')})${symbol ? " AND json_extract(data,'$.symbol')=?" : ''}${after ? ' AND id>?' : ''}`;
    const args = [...types, ...(symbol ? [symbol] : []), ...(after ? [after] : []), limit];
    let rows = this.db.prepare(`SELECT id,ts,type,data FROM events WHERE ${where} ORDER BY id ${after ? 'ASC' : 'DESC'} LIMIT ?`).all(...args);
    if (!after) rows = rows.reverse();
    const hasMore = !!after && rows.length === limit && rows.at(-1).id < latest;
    return { events: rows.map(r => ({ ...r, data: JSON.parse(r.data) })), cursor: hasMore ? rows.at(-1).id : latest, hasMore, reset };
  }
  journalSummary() {
    const totals = this.db.prepare(`SELECT COUNT(*) intents,
      COALESCE(SUM(kind='entry' AND json_extract(data,'$.filledQty')>0),0) filledBuys,
      COALESCE(SUM(kind='exit' AND json_extract(data,'$.filledQty')>0),0) filledSells FROM orders`).get();
    const legs = this.db.prepare("SELECT COUNT(*) n FROM orders,json_each(orders.data,'$.legs') leg WHERE json_extract(leg.value,'$.filledQty')>0").get().n;
    return { ...totals, filledSells: totals.filledSells + legs };
  }
  bar(b) { return this.db.prepare('INSERT OR IGNORE INTO bars VALUES(?,?,?)').run(b.symbol, b.ts, JSON.stringify(b)).changes > 0; }
  bars(symbol, limit = 120) { return this.db.prepare('SELECT data FROM bars WHERE symbol=? ORDER BY ts DESC LIMIT ?').all(symbol, limit).reverse().map(x => JSON.parse(x.data)); }
  candidate(c) { return this.db.prepare('INSERT OR IGNORE INTO candidates VALUES(?,?,?,?,?,?)').run(c.id, c.ts, c.symbol, c.strategy, c.status ?? 'discovered', JSON.stringify(c)).changes > 0; }
  updateCandidate(c) { this.db.prepare('UPDATE candidates SET status=?,data=? WHERE id=?').run(c.status, JSON.stringify(c), c.id); }
  candidates(limit = 100) { return this.db.prepare('SELECT data FROM candidates ORDER BY ts DESC LIMIT ?').all(limit).map(x => JSON.parse(x.data)); }
  getCandidate(id) { const row = this.db.prepare('SELECT data FROM candidates WHERE id=?').get(id); return row ? JSON.parse(row.data) : null; }
  candidatesForSymbol(symbol, since, limit = 300) { return this.db.prepare('SELECT data FROM candidates WHERE symbol=? AND ts>=? ORDER BY ts DESC LIMIT ?').all(symbol, since, limit).map(x => JSON.parse(x.data)); }
  ordersForSymbol(symbol, limit = 500) { return this.db.prepare('SELECT data FROM orders WHERE symbol=? ORDER BY ts DESC LIMIT ?').all(symbol, limit).map(x => JSON.parse(x.data)); }
  order(o) { this.db.prepare('INSERT INTO orders VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data').run(o.id, o.symbol, o.kind, o.status, o.ts, JSON.stringify(o)); }
  orders() { return this.db.prepare('SELECT data FROM orders ORDER BY ts').all().map(x => JSON.parse(x.data)); }
  modelTrace(trace) {
    this.db.prepare('INSERT INTO model_traces VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(trace.id, trace.candidateId, trace.ts, trace.symbol, JSON.stringify(trace));
    this.db.prepare('DELETE FROM model_traces WHERE id IN (SELECT id FROM model_traces ORDER BY ts DESC LIMIT -1 OFFSET 3000)').run();
  }
  modelTraces(symbol = '', limit = 40) {
    return this.db.prepare(`SELECT data FROM model_traces ${symbol ? 'WHERE symbol=?' : ''} ORDER BY ts DESC LIMIT ?`).all(...(symbol ? [symbol, limit] : [limit])).map(x => JSON.parse(x.data));
  }
  modelTraceById(id) { const row = this.db.prepare('SELECT data FROM model_traces WHERE id=?').get(id); return row ? JSON.parse(row.data) : null; }
  recoverModelTraces(now) {
    this.db.prepare("UPDATE model_traces SET data=json_set(data,'$.status','interrupted','$.error','process_interrupted','$.recoveredAt',?) WHERE json_extract(data,'$.status')='inflight'").run(now);
  }
  historicalModels(symbol = '', limit = 40) {
    return this.db.prepare(`SELECT data FROM candidates WHERE (json_extract(data,'$.model.requested')=1 OR json_type(data,'$.model.answers')='object') ${symbol ? 'AND symbol=?' : ''} ORDER BY ts DESC LIMIT ?`).all(...(symbol ? [symbol, limit] : [limit])).map(x => JSON.parse(x.data));
  }
  spend(month) { return this.db.prepare('SELECT COALESCE(SUM(COALESCE(actual,reserved)),0) total FROM spending WHERE month=?').get(month).total; }
  reserveCost(id, month, cost, cap, ts) {
    return this.transaction(() => {
      if (this.spend(month) + cost > cap) return false;
      this.db.prepare('INSERT INTO spending VALUES(?,?,?,?,?)').run(id, month, cost, null, ts);
      return true;
    });
  }
  settleCost(id, actual) { this.db.prepare('UPDATE spending SET actual=? WHERE id=?').run(actual, id); }
  async backup(path) { await backup(this.db, path); }
  prune(before) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM bars WHERE ts<?').run(before);
      this.db.prepare('DELETE FROM events WHERE ts<?').run(before);
      this.db.prepare('DELETE FROM model_traces WHERE ts<?').run(before);
      // Orders, candidates and spending form the long-lived financial audit; never silently prune them.
    });
  }
  close() { this.db.close(); }
}
