import { validateResearchRecord } from './research-evidence.js';

export class ResearchJournal {
  constructor(store) {
    this.store=store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS research_records (
      id TEXT PRIMARY KEY, symbol TEXT NOT NULL, available_at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS research_record_time ON research_records(available_at);
      CREATE TABLE IF NOT EXISTS research_jobs (id TEXT PRIMARY KEY, symbol TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS research_calls (id TEXT PRIMARY KEY, at INTEGER NOT NULL, stage TEXT NOT NULL, evidence_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS research_invalidations (record_id TEXT PRIMARY KEY, at INTEGER NOT NULL, reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS research_coverage (at INTEGER PRIMARY KEY, available INTEGER NOT NULL);`);
  }
  append(record) {
    validateResearchRecord(record);
    // Content-addressed immutable rows; retries cannot replace past evidence.
    return this.store.db.prepare('INSERT OR IGNORE INTO research_records VALUES(?,?,?,?)').run(record.id,record.symbol,record.availableAt,JSON.stringify(record)).changes>0;
  }
  records(limit=80) { return this.store.db.prepare('SELECT data FROM research_records ORDER BY available_at DESC,rowid DESC LIMIT ?').all(limit).map(r=>JSON.parse(r.data)); }
  job(id) { const r=this.store.db.prepare('SELECT data FROM research_jobs WHERE id=?').get(id);return r?JSON.parse(r.data):null; }
  saveJob(job) { this.store.db.prepare('INSERT INTO research_jobs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(job.id,job.symbol,JSON.stringify(job)); }
  latestJobs(limit=10) { return this.store.db.prepare('SELECT data FROM research_jobs ORDER BY rowid DESC LIMIT ?').all(limit).map(r=>JSON.parse(r.data)); }
  invalidate(id,at,reason) { this.store.db.prepare('INSERT OR IGNORE INTO research_invalidations VALUES(?,?,?)').run(id,at,reason); }
  invalidations() { return this.store.db.prepare('SELECT record_id recordId,at,reason FROM research_invalidations').all(); }
  request(id,at,stage,evidenceId) { this.store.db.prepare('INSERT INTO research_calls VALUES(?,?,?,?)').run(id,at,stage,evidenceId); }
  coverage(at,available) { this.store.db.prepare('INSERT INTO research_coverage VALUES(?,?) ON CONFLICT(at) DO UPDATE SET available=excluded.available').run(at,Number(available)); }
  latestCoverage() { return this.store.db.prepare('SELECT at,available FROM research_coverage ORDER BY at DESC LIMIT 1').get()??null; }
}
