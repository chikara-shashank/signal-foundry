import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { hash } from '../src/util.js';
import { validateReviewBundle } from '../src/recorded-research.js';
import { researchInputDigest } from '../src/research-evidence.js';

const [path,out]=process.argv.slice(2);
if(!path||!out)throw new Error('Usage: research-export.js journal.sqlite research.json (read-only export)');
const db=new DatabaseSync(path,{readOnly:true});
try {
  db.exec('BEGIN');
  const has=name=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const records=has('research_records')?db.prepare('SELECT data FROM research_records ORDER BY available_at,rowid').all().map(r=>JSON.parse(r.data)):[];
  const recordIds=new Set(records.map(r=>r.id));
  const invalidations=has('research_invalidations')?db.prepare('SELECT record_id recordId,at,reason FROM research_invalidations').all().filter(r=>recordIds.has(r.recordId)):[];
  const spending=new Map(db.prepare('SELECT * FROM spending').all().map(r=>[r.id,r]));
  const archived=has('model_reviews')?db.prepare('SELECT data FROM model_reviews ORDER BY ts').all():[];
  const recent=db.prepare('SELECT data FROM model_traces ORDER BY ts').all();
  const traces=[...new Map([...recent,...archived].map(r=>{const t=JSON.parse(r.data);return [t.id,t];})).values()];
  const models=traces.filter(t=>t.requested&&t.candidateKey&&t.input&&t.thresholds&&Number.isFinite(t.completedAt)&&t.status!=='inflight').map(t=>({
    candidateKey:t.candidateKey,requestedAt:t.ts,availableAt:t.completedAt,pass:t.pass===true,model:t.model,rubricVersion:t.rubricVersion,
    inputDigest:researchInputDigest(t.input),thresholds:t.thresholds,quality:t.quality,coherence:t.coherence,regime:t.regime,error:t.error??null,costUsd:spending.get(t.id)?.actual??spending.get(t.id)?.reserved??NaN}));
  const charges=has('research_calls')?db.prepare('SELECT id,at,stage FROM research_calls ORDER BY at').all().map(r=>({...r,costUsd:spending.get(r.id)?.actual??spending.get(r.id)?.reserved??NaN})):[];
  const coverageTimeline=has('research_coverage')?db.prepare('SELECT at,available FROM research_coverage ORDER BY at').all().map(r=>({...r,available:Boolean(r.available)})):[];
  const body={schema:1,exportedAt:Date.now(),records,models,invalidations,charges,coverageTimeline,
    coverage:{legacyOrIncompleteModelTracesExcluded:traces.filter(t=>t.requested).length-models.length,
      note:'New model reviews, research records, invalidations and costs survive event pruning. Legacy/UI-only traces may be unavailable. No market tape is synthesized from chart bars.'}};
  const bundle={...body,digest:hash(body)};validateReviewBundle(bundle);
  writeFileSync(out,JSON.stringify(bundle,null,2)+'\n',{flag:'wx'});db.exec('COMMIT');
  console.log(JSON.stringify({out,records:records.length,models:models.length,charges:charges.length,digest:bundle.digest}));
} finally {db.close();}
