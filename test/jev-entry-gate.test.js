import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { Jev } from '../src/jev.js';
import { jevEntryGate } from '../src/jev-entry-gate.js';

const response = () => ({ model:'jev-1.13.0',answers:{coherence:{type:'noul',noul:.9},regime:{type:'choice',choice:'trend',probabilities:{trend:.9,range:.05,disorderly:.05},confidence:.85},quality:{type:'score',score:3.8,probabilities:{0:0,1:0,2:0,3:.2,4:.8},confidence:.8}},usage:{input_tokens:1200} });
async function reviewed(mode='filter') {
  const f=await fixture();f.cfg.jevMode=mode;f.engine.jev=new Jev(f.cfg,f.store,async()=>({ok:true,json:async()=>response()}));
  const c=f.prepare();c.model=await f.engine.jev.evaluate(c,f.now());return {...f,c};
}
test('final entry reservation requires a captured approval and records its audit reference',async()=>{
  const f=await reviewed();try{await f.engine.enter(f.c);assert.equal(f.store.orders().length,1);assert.equal(f.store.orders()[0].jevApproval.traceId,f.c.model.traceId);}finally{f.store.close();}
});
test('shadow approvals and an arbitrary pass flag cannot authorize filter-mode entries',async()=>{
  for(const mode of ['shadow','missing']){
    const f=await reviewed(mode==='shadow'?'shadow':'filter');try{
      f.cfg.jevMode='filter';if(mode==='missing')f.c.model={pass:true,requested:true,mode:'filter'};
      await f.engine.enter(f.c);assert.equal(f.store.orders().length,0);assert.equal(f.c.reason,'jev_approval_required');
    }finally{f.store.close();}
  }
});
test('approval cannot be reused for altered levels, another candidate or after its deadline',async()=>{
  for(const change of [f=>f.c.target++,f=>f.c.id='another-candidate',f=>f.advance(10000)]){
    const f=await reviewed();try{change(f);assert.equal(jevEntryGate(f.engine,f.c).ok,false);}finally{f.store.close();}
  }
});
test('current thresholds are enforced again and unavailable responses fail closed',async()=>{
  const f=await reviewed();try{
    f.cfg.jevCoherence=.95;await f.engine.enter(f.c);assert.equal(f.c.reason,'model_filter');assert.equal(f.store.orders().length,0);
    f.c.model.error='model_timeout';assert.equal(jevEntryGate(f.engine,f.c).ok,false);
  }finally{f.store.close();}
});
test('session submission and an unsupported instrument cannot bypass mandatory review',async()=>{
  const f=await fixture();try{
    f.cfg.jevMode='filter';const c=f.prepare();f.store.db.prepare('DELETE FROM candidates').run();
    await f.engine.submitCandidate(c);assert.equal(c.reason,'jev_setup_review_required');assert.equal(f.store.orders().length,0);
    c.strategy='operator_paper_test';c.model={pass:true};assert.equal(jevEntryGate(f.engine,c).reason,'jev_setup_review_required');
    c.strategy='paper_put_debit';assert.equal(jevEntryGate(f.engine,c).reason,'jev_setup_review_required');
  }finally{f.store.close();}
});
