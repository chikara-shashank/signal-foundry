import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename,dirname,join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { fixture,candidate } from './helpers.js';
import { researchEvidence,sealResearchRecord,RESEARCH_VERSION } from '../src/research-evidence.js';
import { validateReviewBundle } from '../src/recorded-research.js';

test('read-only export retains completed models, charges and invalidations after event pruning and refuses overwrite',async()=>{
  const f=await fixture(),directory=mkdtempSync(join(tmpdir(),'sf-research-export-'));
  try {
    const at=f.now(),evidence=researchEvidence(f.engine,'SPY',[{id:'a',digest:'v1',symbols:['SPY'],headline:'Fixture',summary:'Synthetic source',source:'fixture',publishedAt:at-2000,updatedAt:at-1000,observedAt:at}],at);
    const r=sealResearchRecord({version:RESEARCH_VERSION,symbol:'SPY',evidence,stage:'thesis',model:f.cfg.jevModel,availableAt:at,expiresAt:evidence.expiresAt,costUsd:.003,thesis:{pass:false,support:[],contrary:[]}});
    f.engine.researchContext.journal.append(r);f.engine.researchContext.journal.invalidate(r.id,at+1,'revised');
    f.store.reserveCost('research-attempt',new Date(at).toISOString().slice(0,7),.01,60,at);f.store.settleCost('research-attempt',.003);
    f.engine.researchContext.journal.request('research-attempt',at,'thesis',evidence.id);
    f.cfg.jevMode='shadow';f.cfg.jevKey='fixture';
    f.engine.jev.fetch=async()=>({ok:true,json:async()=>({model:f.cfg.jevModel,answers:{coherence:{type:'noul',noul:.95},regime:{type:'choice',choice:'trend',confidence:.95,probabilities:{trend:1,range:0,disorderly:0}},quality:{type:'score',score:4,confidence:.95,probabilities:{0:0,1:0,2:0,3:0,4:1}}},usage:{input_tokens:1000}})});
    await f.engine.jev.evaluate(candidate('SPY',at),at);
    f.store.prune(at+3600000);assert.equal(f.store.modelTraces().length,0);
    const database=join(directory,'backup.sqlite'),out=join(directory,'research.json');await f.store.backup(database);
    const command=fileURLToPath(new URL('../scripts/research-export.js',import.meta.url));
    execFileSync(process.execPath,[command,database,out],{stdio:'pipe'});
    const exported=JSON.parse(readFileSync(out,'utf8'));validateReviewBundle(exported);
    assert.equal(exported.records.length,1);assert.equal(exported.models.length,1);assert.equal(exported.invalidations.length,1);
    assert.equal(exported.charges[0].costUsd,.003);assert.equal(exported.models[0].costUsd,.000042);
    const original=readFileSync(out,'utf8');assert.throws(()=>execFileSync(process.execPath,[command,database,out],{stdio:'pipe'}));assert.equal(readFileSync(out,'utf8'),original);
    assert.ok(!original.includes('Bearer'));assert.ok(!original.includes('test-token-'));
  } finally {
    f.engine.stopped=true;clearTimeout(f.engine.streamReconcile);await f.engine.mutex.tail;f.store.close();
    assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(basename(directory).startsWith('sf-research-export-'));
    rmSync(directory,{recursive:true,force:true});
  }
});
