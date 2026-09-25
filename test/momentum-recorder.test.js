import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {recordMomentumStream} from '../src/momentum-recorder.js';
test('Raw recorder preserves large IDs and conditions without writing credentials',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'sf-momentum-rec-')),path=join(dir,'tape.jsonl');
  t.after(()=>{unlinkSync(path);rmdirSync(dir);});
  class Socket extends EventTarget {
    constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('open')));}
    close(){}
    send(value){const x=JSON.parse(value);queueMicrotask(()=>{
      if(x.action==='auth')this.dispatchEvent(new MessageEvent('message',{data:'[{"T":"success","msg":"authenticated"}]'}));
      else {
        this.dispatchEvent(new MessageEvent('message',{data:'[{"T":"subscription","trades":["TEST"],"quotes":["TEST"],"statuses":["TEST"]}]'}));
        this.dispatchEvent(new MessageEvent('message',{data:'[{"T":"t","S":"TEST","i":9007199254740993,"p":4.5,"s":100,"c":["@"],"t":"2026-09-24T15:00:00.123456789Z"}]'}));
        this.dispatchEvent(new Event('close'));
      }
    });}
  }
  await assert.rejects(recordMomentumStream({key:'fixture-api-key',secret:'fixture-api-secret',symbols:['TEST'],path,seconds:1,clockOffsetMs:0,clockUncertaintyMs:0,Socket}),{message:'stream_disconnected_coverage_gap'});
  const raw=readFileSync(path,'utf8');assert.ok(!raw.includes('fixture-api'));const rows=raw.trim().split('\n').map(JSON.parse);
  const trade=rows.find(x=>x.kind==='raw_market_event');assert.equal(trade.message.i,'9007199254740993');assert.deepEqual(trade.message.c,['@']);assert.equal(rows.at(-1).reason,'stream_disconnected_coverage_gap');
});
