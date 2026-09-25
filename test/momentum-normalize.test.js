import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,unlinkSync,rmdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {tradeEligibility,quoteEligibility,tradingHalt,providerTime} from '../src/momentum-conditions.js';
import {MomentumNormalizer,normalizeMomentumTape,validateContext} from '../src/momentum-normalize.js';
import {MomentumResearch} from '../src/momentum-research.js';
import {MomentumPortfolio} from '../src/momentum-portfolio.js';
import {MomentumData,exchangeTime} from '../src/momentum-data.js';

// Invented records; never an empirical market capture or profitability test.
const open=Date.parse('2026-09-24T13:30:00Z'),start=open-330*60000;
const evidence={sourceUrl:'https://example.invalid/fixture',sha256:'a'.repeat(64)};
const fact=(value,now=start)=>({value,effectiveAt:now,availableAt:now,evidence});
const context=()=>({schemaVersion:1,mode:'primary',session:{date:'2026-09-24',nextDate:'2026-09-25',open,close:open+390*60000},calendarEvidence:evidence,metadata:[{symbol:'TEST',now:start,facts:{roundLot:{...fact(100),unit:'shares'}}}]});
function tape(messages,{ack=start,header={},reason='bounded_capture_complete',end=messages.at(-1)?.receivedAt??ack}={}){
  const rows=[{kind:'raw_stream_header',schemaVersion:2,source:'alpaca_sip_websocket',symbols:['*'],startedAtLocal:start,clockOffsetMs:0,clockUncertaintyMs:10,quoteSizeUnits:'round_lots',completeUniverseRequested:true,normalized:false,...header},{kind:'raw_subscription',receivedAt:ack,channels:{trades:['*'],quotes:['*'],statuses:['*']}},...messages];
  rows.slice(1).forEach((r,i)=>r.sequence=i+1);
  const sha256=createHash('sha256').update(rows.map(x=>JSON.stringify(x)+'\n').join('')).digest('hex');
  rows.push({kind:'raw_stream_end',now:end,subscribed:true,frames:messages.filter(x=>x.kind==='raw_market_event').length,sequence:rows.length-1,sha256,reason});return rows;
}
const trade=(when,c=['@'],more={})=>({kind:'raw_market_event',receivedAt:when+1,message:{T:'t',S:'TEST',z:'C',x:'Q',i:'9007199254740993',p:4,s:100,c,t:new Date(when).toISOString(),...more}});
const quote=(when,more={})=>({kind:'raw_market_event',receivedAt:when+1,message:{T:'q',S:'TEST',z:'C',bp:4,ap:4.01,bs:3,as:2,c:['R'],t:new Date(when).toISOString(),...more}});
function normalized(rows,c=context()){const events=[],n=new MomentumNormalizer(c,e=>events.push(e));rows.forEach(r=>n.accept(r));return {events,report:n.finish()};}

test('Tape-specific trade rules separate volume from prices and reject unknown combinations',()=>{
  assert.deepEqual(tradeEligibility('C',['@','I']),{known:true,price:false,volume:true});
  assert.equal(tradeEligibility('A',['B']).price,false);assert.equal(tradeEligibility('C',['B']).price,true);
  assert.equal(tradeEligibility('A',[' ','F']).price,true);assert.equal(tradeEligibility('C',['@','T']).price,true);
  assert.deepEqual(tradeEligibility('C',['@','M']),{known:true,price:false,volume:false});
  for(const c of [[],['?'],['E'],['8']])assert.equal(tradeEligibility('C',c).known,false);
  assert.equal(quoteEligibility('C',['R','N']),false);assert.equal(quoteEligibility('A',['R']),true);
});
test('Status uses trading resumption, never quotation resumption or a reason code',()=>{
  assert.equal(tradingHalt('C','Q'),true);assert.equal(tradingHalt('C','T'),false);assert.equal(tradingHalt('C','T3'),null);
  assert.equal(tradingHalt('A','2'),true);assert.equal(tradingHalt('B','3'),false);assert.equal(tradingHalt('A','E'),null);
});
test('Adapter preserves nanoseconds and exact IDs, scales only evidenced quote lots',()=>{
  const rows=tape([trade(open,['@'],{t:'2026-09-24T13:30:00.000000123Z'}),quote(open+1)]);
  const {events}=normalized(rows),t=events.find(x=>x.kind==='trade'),q=events.find(x=>x.kind==='quote');
  assert.equal(t.id,'C:Q:9007199254740993');assert.equal(t.timestampNs,String(BigInt(open)*1000000n+123n));assert.equal(q.askSize,200);assert.equal(q.bidSize,300);assert.equal(q.eligible,true);
  const c=context();c.metadata=[];
  assert.equal(normalized(rows,c).events.find(x=>x.kind==='quote').eligible,false);
  assert.throws(()=>providerTime('2026-02-30T12:00:00Z'),/Invalid/);
});
test('Late float/news cannot be backdated, and dollar public-float values are rejected',()=>{
  const c=context();c.metadata.push({symbol:'TEST',now:open+1000,facts:{float:{...fact(123456,open+1000),unit:'shares'}}});
  const events=normalized(tape([trade(open),trade(open+2000, ['@'],{i:2})]),c).events;
  assert.ok(events.findIndex(x=>x.kind==='metadata'&&x.facts.float)>events.findIndex(x=>x.kind==='trade'));
  c.metadata[1].facts.float.availableAt=open+2000;assert.throws(()=>validateContext(c),/causal/);
  c.metadata[1].facts.float.availableAt=open+1000;c.metadata[1].facts.float.unit='USD';assert.throws(()=>validateContext(c),/shares/);
});
test('Truncation, mutation and missing sequence records never certify a recording',()=>{
  const good=tape([trade(open)]),tampered=structuredClone(good);tampered[2].message.p=100;
  assert.ok(normalized(tampered).report.issues.some(x=>x.reason==='recording_integrity_mismatch'));
  assert.ok(normalized(good.slice(0,-1)).report.issues.some(x=>x.reason==='missing_recording_footer'));
  const skipped=structuredClone(good);skipped[2].sequence++;assert.throws(()=>normalized(skipped),/sequence gap/);
  assert.throws(()=>normalized([{kind:'capture_header',source:'alpaca_sip_rest'}]),/original Alpaca/);
});
test('Acknowledgement after 04:00 and uncertain clocks fail primary coverage',()=>{
  for(const options of [{ack:start+1},{header:{clockUncertaintyMs:101}},{header:{schemaVersion:1}}]){
    const {events,report}=normalized(tape([trade(open)],options));
    assert.equal(events.find(x=>x.kind==='coverage').coverageComplete,false);assert.equal(report.coverageComplete,false);
  }
});
test('Heartbeat gaps and stale resumption cannot reopen a safe execution path',()=>{
  const heartbeat={kind:'raw_heartbeat',now:open,clockDriftMs:0};
  const status={kind:'raw_market_event',receivedAt:open+5000,message:{T:'s',S:'TEST',z:'C',sc:'T',t:new Date(open).toISOString()}};
  const {events,report}=normalized(tape([heartbeat,status],{end:open+5001}));
  assert.ok(report.issues.some(x=>x.reason==='heartbeat_or_clock_gap'));assert.equal(events.find(x=>x.kind==='halt').active,null);
});
test('Complete continuous wildcard capture qualifies operational coverage; local heartbeats alone do not',()=>{
  function run(withMarket){
    const c=context(),n=new MomentumNormalizer(c,()=>{}),hash=createHash('sha256');let sequence=0,frames=0;
    const initial=tape([],{ack:start-1000,header:{startedAtLocal:start-1000}}).slice(0,2);
    function send(row){if(row.kind!=='raw_stream_header')row.sequence=++sequence;hash.update(JSON.stringify(row)+'\n');n.accept(row);}
    initial.forEach(send);
    for(let now=start;now<=c.session.close;now+=1000){
      if(withMarket&&(now-start)%5000===0){const row=trade(now-1,['@'],{i:String(frames+1)});send(row);frames++;}
      send({kind:'raw_heartbeat',now,clockDriftMs:0});
    }
    n.accept({kind:'raw_stream_end',now:c.session.close,reason:'bounded_capture_complete',subscribed:true,frames,sequence,sha256:hash.digest('hex')});return n.finish();
  }
  assert.equal(run(true).coverageComplete,true);
  const silent=run(false);assert.equal(silent.coverageComplete,false);assert.equal(silent.issueCounts.marketwide_stream_silent,1);
});
test('Odd-lot volume changes scanner/bar volume but not OHLC, trigger price or VWAP',()=>{
  const r=new MomentumResearch();r.on({kind:'session',now:start,date:'2026-09-24',nextDate:'2026-09-25',open,close:open+390*60000,coverageFrom:start,coverageComplete:true,completeUniverse:true,source:'synthetic'});
  const t={kind:'trade',symbol:'TEST',now:open,ts:open,price:4,size:100,id:'a',eligible:true,priceEligible:true,volumeEligible:true};r.on(t);
  r.on({...t,now:open+1,ts:open+1,id:'b',price:1000,size:10,priceEligible:false});
  const s=r.state('TEST');assert.equal(s.volume,110);assert.equal(s.bar.volume,110);assert.equal(s.bar.high,4);assert.equal(s.lastTrade.price,4);assert.equal(s.pv/s.rthVolume,4);
});
test('Within-millisecond trade and quote reversals are detected',()=>{
  const r=new MomentumResearch();r.on({kind:'session',now:start,date:'2026-09-24',nextDate:'2026-09-25',open,close:open+390*60000,coverageFrom:start,coverageComplete:true,completeUniverse:true,source:'synthetic'});
  const t={kind:'trade',symbol:'TEST',now:open+1,ts:open,price:4,size:100,id:'a',eligible:true,timestampNs:String(BigInt(open)*1000000n+900n)};r.on(t);r.on({...t,id:'b',timestampNs:String(BigInt(open)*1000000n+100n)});
  assert.equal(r.state('TEST').healthy,false);assert.equal(r.report().dataErrors[0].reason,'out_of_order_trade');
  const p=new MomentumPortfolio(),q={symbol:'TEST',ts:open,bid:4,ask:4.01,bidSize:100,askSize:100,eligible:true,timestampNs:t.timestampNs};p.quote(q,open+1);p.quote({...q,bid:3,timestampNs:String(BigInt(open)*1000000n+100n)},open+1);
  assert.equal(p.quotes.get('TEST').bid,4);assert.equal(p.quoteUsable.get('TEST'),false);
});
test('Trade revisions and delayed trades cancel pending entries before arrival',()=>{
  for(const kind of ['correction','cancel','trade']){
    const r=new MomentumResearch();r.on({kind:'session',now:start,date:'2026-09-24',nextDate:'2026-09-25',open,close:open+390*60000,coverageFrom:start,coverageComplete:true,completeUniverse:true,source:'synthetic'});
    r.on({kind:'halt',symbol:'TEST',now:open,active:false});assert.equal(r.portfolio.reserve({symbol:'TEST',limit:4.01,stop:3.9,tickSize:.01},open),true);
    r.on({kind,symbol:'TEST',now:open+500,ts:open-4000,price:4,size:100,id:'late',eligible:true});
    r.on({kind:'quote',symbol:'TEST',now:open+1000,ts:open+1000,bid:4,ask:4.01,bidSize:10000,askSize:10000,eligible:true});
    assert.equal(r.portfolio.pending.size,0);assert.equal(r.portfolio.positions.size,0);
  }
});
test('Normalization CLI library writes auditable hashes and refuses output replacement',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'sf-normalize-'));t.after(()=>{for(const f of readdirSync(dir))unlinkSync(join(dir,f));rmdirSync(dir);});
  const raw=join(dir,'raw.jsonl'),ctx=join(dir,'context.json'),out=join(dir,'events.jsonl');
  writeFileSync(raw,tape([trade(open),quote(open+1)]).map(x=>JSON.stringify(x)+'\n').join(''));writeFileSync(ctx,JSON.stringify(context()));
  const report=await normalizeMomentumTape(raw,ctx,out);assert.match(report.normalizedSha256,/^[a-f0-9]{64}$/);assert.equal(report.coverageComplete,false);
  const engine=new MomentumResearch();readFileSync(out,'utf8').trim().split('\n').forEach(x=>engine.on(JSON.parse(x)));assert.equal(engine.report().validationEligible,false);
  await assert.rejects(normalizeMomentumTape(raw,ctx,out),/already exists|EEXIST/);
});
test('Exchange calendar converts DST and early closes without a fixed UTC offset',()=>{
  assert.equal(new Date(exchangeTime('2026-09-24','09:30')).toISOString(),'2026-09-24T13:30:00.000Z');
  assert.equal(new Date(exchangeTime('2026-12-24','13:00')).toISOString(),'2026-12-24T18:00:00.000Z');
});
test('Aborted normalization poisons partial output instead of leaving a usable primary tape',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'sf-abort-'));t.after(()=>{for(const f of readdirSync(dir))unlinkSync(join(dir,f));rmdirSync(dir);});
  const raw=join(dir,'raw.jsonl'),ctx=join(dir,'context.json'),out=join(dir,'events.jsonl');
  const rows=tape([trade(open)]);writeFileSync(raw,rows.slice(0,2).map(x=>JSON.stringify(x)+'\n').join('')+'invalid-json\n');writeFileSync(ctx,JSON.stringify(context()));
  await assert.rejects(normalizeMomentumTape(raw,ctx,out),/Normalization failed/);
  const last=JSON.parse(readFileSync(out,'utf8').trim().split('\n').at(-1));assert.equal(last.kind,'gap');assert.equal(last.reason,'normalization_aborted');
});
test('Metadata preparation counts only completed regular-session bars and keeps float unknown',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'sf-prepare-'));t.after(()=>{for(const f of readdirSync(dir))unlinkSync(join(dir,f));rmdirSync(dir);});
  const dates=Array.from({length:30},(_,i)=>new Date(Date.UTC(2026,7,i+1)).toISOString().slice(0,10));
  const calendar=[...dates.map(date=>({date,open:'09:30',close:'16:00'})),{date:'2026-09-24',open:'09:30',close:'16:00',settlement_date:'2026-09-25'}];
  const bars=dates.flatMap(date=>[{t:new Date(exchangeTime(date,'09:29')).toISOString(),v:99999},{t:new Date(exchangeTime(date,'09:30')).toISOString(),v:100},{t:new Date(exchangeTime(date,'16:00')).toISOString(),v:99999}]);
  const data=new MomentumData({key:'fixture',secret:'fixture',now:()=>open,fetchFn:async url=>({ok:true,json:async()=>url.includes('/clock')?{timestamp:new Date(open).toISOString()}:url.includes('/calendar')?calendar:url.includes('/assets/')?{symbol:'TEST',tradable:true}:url.includes('/bars?')?{bars,next_page_token:null}:{news:[]}})});
  const report=await data.prepare(dir,'2026-09-24',['TEST']),ctx=JSON.parse(readFileSync(join(dir,'context.json')));
  assert.equal(report.qualified,0);assert.equal(ctx.metadata[1].facts.volumeBaseline.value,100);assert.equal(ctx.metadata.some(x=>x.facts.float),false);validateContext(ctx);
});
