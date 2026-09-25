import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.js';
import { OptionsTape } from '../src/options-tape.js';
import { freshOptionsState, optionsRecord, advanceOptions, replayOptions } from '../src/options-lab.js';
import { createBackup, verifyBackup } from '../src/recovery.js';
import { Workers } from '../src/workers.js';
import { accountWriterLock } from '../src/account-writer-lock.js';
import { fixture } from './helpers.js';
import { strategyManifest } from '../src/strategy-manifest.js';
import { normalizeActivity } from '../src/accounting.js';
import { amendFeeSchedule, verifyRegistration } from '../src/momentum-validation.js';
import { FEE_SCHEDULE, FEE_SCHEDULE_HASH, robinhoodEquityFee } from '../src/momentum-fees.js';
import { createDashboard } from '../src/server.js';
import { Engine } from '../src/engine.js';

const close=async f=>{clearTimeout(f.engine.streamReconcile);await f.engine.mutex.tail;f.store.close();};
const frame=(now=Date.parse('2026-09-25T14:00Z'))=>({schema:1,source:'alpaca_opra',stockFeed:'sip',now,clockUncertaintyMs:0,marketOpen:false,session:null,quotes:{},contracts:{},spots:{},contexts:{}});
const addFrame=(s,at)=>{const before=s.get('optionsLab',freshOptionsState()),f=frame(at),next=structuredClone(before);advanceOptions(next,f,false);s.saveOptionsFrame(optionsRecord(before,f,false,!before.lastAt),next);};
const sign=body=>({...body,sha256:createHash('sha256').update(JSON.stringify(body)).digest('hex')});

test('wrong account identity cannot consume persisted exit triggers during startup',async()=>{
  const f=await fixture();
  try{
    const triggers={stop:{symbol:'SPY',entryId:'prior',reason:'stop'}};
    f.store.set('exitTriggers',triggers);f.store.set('managed',{SPY:{entryId:'prior'}});
    const next=new Engine({...f.cfg,mode:'shadow'},f.store,f.broker,f.engine.workers,f.now);
    await assert.rejects(next.init(),/Database belongs/);assert.deepEqual(f.store.get('exitTriggers'),triggers);assert.equal(f.store.get('managed').SPY.exitReason,undefined);
  }finally{await close(f);}
});

test('outbox survives export interruption, validates file contents and rejects chain edits',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'sf-tape-')),s=new Store();s.lease(Date.now());
  try{
    addFrame(s);const tape=new OptionsTape(s,dir),mark=s.markOptionExport.bind(s);let first=true;
    s.markOptionExport=n=>{if(first){first=false;throw new Error('interrupted');}return mark(n);};
    await tape.flush();assert.equal(s.optionArchiveStatus().pending,1);assert.equal(tape.error,'options_archive_write_failed');
    await tape.flush();assert.equal(tape.error,null);assert.equal(s.optionArchiveStatus().pending,0);
    addFrame(s,Date.parse('2026-09-25T14:01Z'));
    const rows=s.db.prepare('SELECT * FROM options_outbox ORDER BY sequence').all().map(r=>Store.decodeOptionRecord(r.data));
    assert.equal(replayOptions(rows).lastAt,Date.parse('2026-09-25T14:01Z'));
    const edited=structuredClone(rows);edited[1].allowNew=true;assert.throws(()=>replayOptions(edited),/record_integrity/);
    assert.throws(()=>replayOptions([rows[1]]),/checkpoint_required/);
    s.db.prepare('UPDATE options_outbox SET exported=0 WHERE sequence=1').run();
    await writeFile(join(dir,'2026-09-25','000000000001.json.gz'),'broken');await tape.flush();assert.ok(tape.error);assert.equal(s.optionArchiveStatus().pending,2);
  }finally{s.close();await rm(dir,{recursive:true,force:true});}
});
test('verified SQLite backup contains atomic options state and preserves the $2000 override',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'sf-backup-')),s=new Store(join(dir,'source.sqlite'));s.lease(Date.now());
  try{
    s.set('dailyLossOverride',2000);addFrame(s);const file=join(dir,'backup.sqlite');
    await createBackup(s,file);const result=await verifyBackup(file);assert.equal(result.dailyLossOverride,2000);assert.equal(result.optionsFrames,1);
    const bytes=await readFile(file);bytes[120]^=1;await writeFile(file,bytes);await assert.rejects(verifyBackup(file),/digest_mismatch/);
  }finally{s.close();await rm(dir,{recursive:true,force:true});}
});
test('failed worker does not discard other signals; restart budget is bounded and close cancels recovery',async()=>{
  const created=[];
  const w=new Workers(['broken','healthy'],{restartBaseMs:1,maxRestarts:2,factory:strategy=>{
    const worker=new EventEmitter();worker.postMessage=({id})=>queueMicrotask(()=>strategy==='broken'?worker.emit('error',new Error('crash')):worker.emit('message',{id,candidate:{strategy,priority:1},assessment:{}}));
    worker.terminate=async()=>{worker.emit('exit');};created.push(worker);return worker;
  }});
  try{
    const first=await w.evaluate({},0,['broken','healthy']);assert.deepEqual(first.map(x=>x.strategy),['healthy']);
    await new Promise(r=>setTimeout(r,10));assert.equal(w.status()[0].alive,true);
    await w.evaluate({},0,['broken']);await new Promise(r=>setTimeout(r,10));await w.evaluate({},0,['broken']);
    assert.equal(w.status()[0].alive,false);assert.equal(w.status()[0].restarts,2);assert.equal(w.status()[0].restartAt,null);
  }finally{await w.close();}
  assert.equal(created.length,4);
});
test('account writer lock rejects another process-equivalent writer even with a different data directory',async()=>{
  const id='test-account-'+process.pid,lock=await accountWriterLock(id,'paper');
  try{await assert.rejects(accountWriterLock(id,'paper'),/Another engine/);}finally{await lock.close();}
  const next=await accountWriterLock(id,'paper');await next.close();
});
test('manifest changes with risk or enabled strategies, and filtered scorecards exclude other versions',async()=>{
  const f=await fixture();
  try{
    const first=strategyManifest(f.engine,'range_breakout');f.engine.dailyLossLimit=2000;const second=strategyManifest(f.engine,'range_breakout');assert.notEqual(first.experimentId,second.experimentId);
    for(const [id,experiment,pnl] of [['old',first,1],['new',second,-2]])f.store.order({id,kind:'entry',symbol:'SPY',strategy:'range_breakout',ts:f.now(),qty:1,filledQty:1,fillPrice:100,status:'filled',experiment,legs:[{brokerId:id+'-exit',filledQty:1,fillPrice:100+pnl,fee:0,status:'filled'}]});
    const result=f.engine.strategyControls.snapshot({experimentId:second.experimentId});const row=result.strategies.find(s=>s.id==='range_breakout');assert.equal(row.closed,1);assert.ok(row.realizedNetPnl<0);assert.equal(row.qualification.liveEligible,false);
    f.engine.strategyControls.state.strategies.range_breakout.enabled=false;assert.notEqual(second.experimentId,strategyManifest(f.engine,'range_breakout').experimentId);
  }finally{await close(f);}
});
test('activities deduplicate, attach owned fees, surface assignments and suppress inconsistent economic P/L',async()=>{
  const f=await fixture({OPERATING_COST_PER_DAY_USD:'1'});
  try{
    f.store.order({id:'owned',brokerId:'broker',kind:'entry',symbol:'SPY',strategy:'range_breakout',ts:f.now(),qty:2,filledQty:2,fillPrice:100,status:'filled'});
    const rows=[{id:'f',activity_type:'FILL',transaction_time:new Date(f.now()).toISOString(),order_id:'broker',qty:'1',price:'100',side:'buy'}, {id:'fee',activity_type:'FEE',date:'2026-09-25',order_id:'broker',net_amount:'-0.21'}, {id:'assignment',activity_type:'OPASN',date:'2026-09-25',symbol:'QQQ'}].map(normalizeActivity);
    for(const row of [...rows,...rows])f.store.activity(row);f.engine.accounting.reconcileFees();const s=f.engine.accounting.snapshot();
    assert.equal(f.store.activities().length,3);assert.equal(f.store.orders()[0].fee,.21);assert.equal(s.mismatches.length,1);assert.equal(s.lifecycleEvents.length,1);assert.equal(s.knownEconomicNet,null);assert.equal(s.complete,false);
    const owned=f.store.orders()[0];owned.legs=[{brokerId:'leg',filledQty:0,fee:.12,feeSource:'broker_activity_provisional',status:'new'}];
    f.engine.merge(owned,{...owned,legs:[{brokerId:'leg',filledQty:0,status:'new'}]});assert.equal(f.store.orders()[0].legs[0].fee,.12);
    assert.throws(()=>normalizeActivity({id:'bad',activity_type:'FILL',date:'bad'}),/invalid_date/);
  }finally{await close(f);}
});
test('published fee changes require immutable amendment and retain original frozen rules',()=>{
  const old=sign({version:2,feeScheduleHash:'0'.repeat(64),codeSha256:'a'.repeat(64),sessionDates:['2026-10-01'],status:'registered_not_validated'});
  const revised=amendFeeSchedule(old,{reason:'Published exchange fee changed; reprice all sessions.',sourceUrl:'https://robinhood.com/us/en/support/articles/trading-fees-on-robinhood/'});
  verifyRegistration(revised);assert.equal(revised.feeScheduleHash,FEE_SCHEDULE_HASH);assert.deepEqual(revised.amendedFrom,old);
  const {sha256,...body}=revised;body.sessionDates=['2026-10-02'];assert.throws(()=>verifyRegistration(sign(body)),/changed frozen/);
  const duplicate=structuredClone(FEE_SCHEDULE);duplicate.schedules.push(duplicate.schedules[0]);assert.throws(()=>robinhoodEquityFee({side:'sell',qty:1,price:100,date:'2026-10-01'},duplicate),/ambiguous/);
  assert.equal(robinhoodEquityFee({side:'sell',qty:1,price:100,date:'2026-10-01'}).costAssumption,true);
});
test('strategy API validates date filters and separates readiness from liveness',async()=>{
  const f=await fixture(),server=createDashboard(f.engine,f.cfg);await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
  const headers={Authorization:'Bearer '+f.cfg.token};
  try{
    assert.equal((await fetch(url+'/api/strategies?from=2026-02-30',{headers})).status,400);
    assert.equal((await fetch(url+'/api/strategies?experimentId=legacy&from=2026-09-01&to=2026-10-01',{headers})).status,200);
    f.engine.protection.observedAt=0;
    assert.equal((await fetch(url+'/healthz')).status,200);assert.equal((await fetch(url+'/api/readiness',{headers})).status,503);
    assert.equal((await fetch(url+'/api/accounting')).status,401);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await close(f);}
});
