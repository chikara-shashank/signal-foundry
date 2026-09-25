import {createHash} from 'node:crypto';
import {readFileSync,createReadStream,openSync,writeSync,closeSync,writeFileSync,existsSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {CONDITION_VERSION,tradeEligibility,quoteEligibility,tradingHalt,providerTime} from './momentum-conditions.js';

const sha=x=>createHash('sha256').update(x).digest('hex');
const symbolOK=s=>typeof s==='string'&&/^[A-Z][A-Z0-9.]{0,9}$/.test(s);
const evidence=e=>e&&/^https:\/\//.test(e.sourceUrl??'')&&/^[a-f0-9]{64}$/.test(e.sha256??'');
const validDate=d=>typeof d==='string'&&/^\d{4}-\d\d-\d\d$/.test(d)&&Number.isFinite(Date.parse(d))&&new Date(Date.parse(d)).toISOString().slice(0,10)===d;
const factNames=new Set(['listing','tradable','float','previousClose','volumeBaseline','news','tickSize','roundLot','splitBasis']);
export function normalizationContractHash(){
  return sha(['src/momentum-normalize.js','src/momentum-conditions.js','src/momentum-recorder.js'].map(p=>p+'\n'+readFileSync(new URL('../'+p,import.meta.url),'utf8')).join('\n'));
}
export function validateContext(context){
  const s=context?.session;
  if(context?.schemaVersion!==1||!['diagnostic','primary'].includes(context.mode)||!s||!validDate(s.date)||!validDate(s.nextDate)||!(s.nextDate>s.date)||![s.open,s.close].every(Number.isSafeInteger)||s.close<=s.open||s.close-s.open>390*60000||s.open%60000||s.close%60000||!evidence(context.calendarEvidence))throw new Error('Invalid calendar/context evidence');
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const parts=Object.fromEntries(formatter.formatToParts(s.open).map(p=>[p.type,p.value]));
  if(`${parts.year}-${parts.month}-${parts.day}`!==s.date||`${parts.hour}:${parts.minute}`!=='09:30')throw new Error('Calendar open must be 09:30 New York on session date');
  if(!Array.isArray(context.metadata))throw new Error('Metadata timeline required (may be empty)');
  let last=-Infinity;
  for(const row of context.metadata){
    if(!symbolOK(row.symbol)||!Number.isFinite(row.now)||row.now<last||!row.facts||typeof row.facts!=='object')throw new Error('Invalid metadata receipt order');
    last=row.now;
    for(const [name,f] of Object.entries(row.facts)){
      if(!factNames.has(name)||!f||!Number.isFinite(f.availableAt)||!Number.isFinite(f.effectiveAt)||f.availableAt>row.now||f.effectiveAt>row.now||!evidence(f.evidence))throw new Error('Metadata requires causal field evidence');
      if(name==='float'&&f.value!==null&&(!(f.value>0)||!Number.isFinite(f.value)||f.unit!=='shares'))throw new Error('Float must be verified shares, never dollars');
      if(name==='roundLot'&&f.value!==null&&(!Number.isSafeInteger(f.value)||f.value<=0||f.unit!=='shares'))throw new Error('Invalid round lot');
      if(name==='tickSize'&&f.value!==null&&(!(f.value>0)||!Number.isFinite(f.value)))throw new Error('Invalid tick size');
      if(name==='splitBasis'&&f.value===true&&f.sessionDate!==s.date)throw new Error('Split-basis review must identify this session');
      if(name==='volumeBaseline'&&f.value!==null&&(f.sessions!==30||!(f.lastSession<s.date)||!(f.value>0)||f.convention!=='regular_session_eligible_volume'))throw new Error('Invalid prior regular-session volume baseline');
      if(name==='news'&&f.classification==='issuer_or_sec_material'&&(!f.taxonomyVersion||!f.reviewedBy||!/^https:\/\//.test(f.sourceUrl??'')))throw new Error('Material news requires reviewed taxonomy and source');
    }
  }
  return context;
}

// Receipt-ordered adapter; no backfill, sorting, historical reclassification or
// conversion of a REST snapshot into an original tick observation.
export class MomentumNormalizer {
  constructor(context,emit){
    this.context=validateContext(context);this.emit=emit;this.metaIndex=0;this.facts=new Map();this.last=-Infinity;this.header=null;this.subscribed=false;this.ended=false;this.frames=0;this.sequence=0;this.digest=createHash('sha256');this.issues=[];this.issueCounts={};this.counts={};this.coverage=false;this.lastHeartbeat=null;this.lastMarket=null;this.endTime=null;this.haltTimes=new Map();
  }
  output(event){this.counts[event.kind]=(this.counts[event.kind]??0)+1;this.emit(event);}
  issue(reason,now,symbol){
    this.issueCounts[reason]=(this.issueCounts[reason]??0)+1;
    if(this.issues.length<1000)this.issues.push({reason,now,...(symbol?{symbol}:{})});
    this.output(symbol?{kind:'invalid',symbol,now,reason}:{kind:'gap',now,reason});
    if(!symbol)this.coverage=false;
  }
  metadataUntil(now){
    while(this.metaIndex<this.context.metadata.length&&this.context.metadata[this.metaIndex].now<=now){
      const row=this.context.metadata[this.metaIndex++],facts={...(this.facts.get(row.symbol)??{}),...row.facts};this.facts.set(row.symbol,facts);
      this.output({kind:'metadata',symbol:row.symbol,now:Math.max(row.now,this.start),facts:{...row.facts,splitBasisVerified:facts.splitBasis?.value===true}});
    }
  }
  accept(row){
    if(this.ended)throw new Error('Data after recording footer');
    if(!this.header){
      if(row.kind!=='raw_stream_header'||row.source!=='alpaca_sip_websocket'||row.normalized!==false||row.quoteSizeUnits!=='round_lots'||!Array.isArray(row.symbols)||!row.symbols.length||row.symbols.some(s=>s!=='*'&&!symbolOK(s))||(row.symbols.includes('*')&&row.symbols.length!==1)||![row.startedAtLocal,row.clockOffsetMs,row.clockUncertaintyMs].every(Number.isFinite)||row.clockUncertaintyMs<0)throw new Error('Require an original Alpaca SIP stream header');
      this.header=row;this.start=row.startedAtLocal+row.clockOffsetMs;this.last=this.start;
      if(row.schemaVersion===2)this.digest.update(JSON.stringify(row)+'\n');
      const potential=this.context.mode==='primary'&&row.schemaVersion===2&&row.symbols[0]==='*'&&row.completeUniverseRequested===true&&this.start+row.clockUncertaintyMs<=this.context.session.open-330*60000&&row.clockUncertaintyMs<=100;
      const {date,nextDate,open,close}=this.context.session;
      this.output({kind:'session',now:this.start,date,nextDate,open,close,coverageFrom:this.start,coverageComplete:potential,completeUniverse:potential,source:'recorded',dataContractSha256:normalizationContractHash()});
      this.metadataUntil(this.start);return;
    }
    const now=row.receivedAt??row.now;
    if(!Number.isFinite(now)||now<this.last)throw new Error('Raw receipt clock moved backward');
    this.metadataUntil(now);this.last=now;
    if(this.header.schemaVersion===2&&row.kind!=='raw_stream_end'){
      if(row.sequence!==++this.sequence)throw new Error('Raw sequence gap');
      this.digest.update(JSON.stringify(row)+'\n');
    }
    if(row.kind==='raw_subscription'){
      if(this.subscribed)throw new Error('Unexpected resubscription');
      this.subscribed=['trades','quotes','statuses'].every(k=>this.header.symbols.every(s=>row.channels?.[k]?.includes(s)));
      if(!this.subscribed)throw new Error('Incomplete stream subscription');
      const full=this.context.mode==='primary'&&this.header.schemaVersion===2&&this.header.symbols[0]==='*'&&this.header.completeUniverseRequested===true&&now+this.header.clockUncertaintyMs<=this.context.session.open-330*60000&&this.header.clockUncertaintyMs<=100;
      // Coverage begins only at acknowledgement, not socket creation. The
      // runner updates the existing session without resetting capital/state.
      this.coverage=full;this.output({kind:'coverage',now,coverageFrom:now,completeUniverse:full,coverageComplete:full});
      this.lastHeartbeat=now;
      if(!full)this.issue('diagnostic_or_incomplete_start',now);
      return;
    }
    if(row.kind==='raw_heartbeat'){
      if(!this.subscribed)throw new Error('Heartbeat before subscription');
      if(now-this.lastHeartbeat>3000||!Number.isFinite(row.clockDriftMs)||Math.abs(row.clockDriftMs)>100)this.issue('heartbeat_or_clock_gap',now);
      const beginning=this.context.session.open-330*60000;
      if(this.coverage&&now>=beginning&&now<=this.context.session.close&&now-Math.max(this.lastMarket??beginning,beginning)>10000)this.issue('marketwide_stream_silent',now);
      this.lastHeartbeat=now;this.output({kind:'tick',now});return;
    }
    if(row.kind==='raw_stream_end'){
      this.ended=true;this.endTime=now;
      if(this.header.schemaVersion===2&&(row.sequence!==this.sequence||row.sha256!==this.digest.digest('hex')))this.issue('recording_integrity_mismatch',now);
      if(!this.subscribed||row.subscribed!==true||row.frames!==this.frames||row.reason!=='bounded_capture_complete')this.issue('recording_incomplete',now);
      if(now<this.context.session.close)this.issue('recording_ended_before_close',now);
      if(this.header.schemaVersion!==2||this.lastHeartbeat===null||now-this.lastHeartbeat>3000)this.issue('missing_final_heartbeat',now);
      this.output({kind:'tick',now});return;
    }
    if(row.kind!=='raw_market_event'||!this.subscribed)throw new Error('Unexpected raw event');
    this.frames++;this.lastMarket=now;const m=row.message;
    if(!m||!symbolOK(m.S)||!['t','q','s','c','x'].includes(m.T)||(this.header.symbols[0]!=='*'&&!this.header.symbols.includes(m.S)))throw new Error('Invalid raw market event');
    const symbol=m.S;let time;try{time=providerTime(m.t);}catch{this.issue('invalid_provider_time',now,symbol);return;}
    const base={symbol,now,...time,providerTimestamp:m.t,tape:m.z,conditions:m.c??null};
    if(m.T==='s'){
      const prior=this.haltTimes.get(symbol);
      if(time.ts>now||now-time.ts>3000||(prior&&BigInt(time.timestampNs)<prior)){this.issue('stale_or_reversed_status',now,symbol);this.output({kind:'halt',...base,active:null});return;}
      this.haltTimes.set(symbol,BigInt(time.timestampNs));this.output({kind:'halt',...base,active:tradingHalt(m.z,m.sc),status:m.sc,reason:m.rc});return;
    }
    if(m.T==='c'||m.T==='x'){this.output({kind:m.T==='c'?'correction':'cancel',...base});return;}
    if(m.T==='t'){
      const eligibility=tradeEligibility(m.z,m.c);
      if(!eligibility.known){this.issue('unknown_trade_condition',now,symbol);return;}
      if(!(typeof m.i==='string'&&/^\d+$/.test(m.i)||Number.isSafeInteger(m.i)&&m.i>=0)||typeof m.x!=='string'||!m.x||!Number.isSafeInteger(m.s)||m.s<=0||!Number.isFinite(m.p)||m.p<=0){this.issue('invalid_trade_fields',now,symbol);return;}
      this.output({kind:'trade',...base,id:`${m.z}:${m.x}:${m.i}`,price:m.p,size:m.s,eligible:eligibility.price||eligibility.volume,priceEligible:eligibility.price,volumeEligible:eligibility.volume});return;
    }
    const lot=this.facts.get(symbol)?.roundLot;
    const knownLot=lot&&lot.availableAt<=now&&lot.effectiveAt<=time.ts&&time.ts-lot.effectiveAt<=86400000&&lot.unit==='shares'&&Number.isSafeInteger(lot.value)&&lot.value>0;
    const validSizes=Number.isSafeInteger(m.bs)&&m.bs>0&&Number.isSafeInteger(m.as)&&m.as>0;
    const bidSize=knownLot&&validSizes?m.bs*lot.value:null,askSize=knownLot&&validSizes?m.as*lot.value:null;
    this.output({kind:'quote',...base,bid:m.bp,ask:m.ap,bidSize,askSize,eligible:!!knownLot&&validSizes&&Number.isSafeInteger(bidSize)&&Number.isSafeInteger(askSize)&&quoteEligibility(m.z,m.c),normalizationReason:!knownLot?'missing_round_lot':null});
  }
  finish(){
    if(!this.header)throw new Error('Empty raw tape');
    if(!this.ended)this.issue('missing_recording_footer',this.last);
    return {schemaVersion:1,mode:this.context.mode,conditionVersion:CONDITION_VERSION,dataContractSha256:normalizationContractHash(),frames:this.frames,events:this.counts,coverageComplete:this.coverage&&this.ended&&this.endTime>=this.context.session.close,issues:this.issues,issueCounts:this.issueCounts,metadataRowsApplied:this.metaIndex,metadataRowsAfterCapture:this.context.metadata.length-this.metaIndex,clockUncertaintyMs:this.header.clockUncertaintyMs,limitations:['Calendar and metadata evidence hashes require independent review; hash presence is not verification.','A complete socket capture is not proof against upstream omissions. Status begins unknown until an explicit trading status arrives.']};
  }
}

export async function normalizeMomentumTape(input,contextPath,output){
  const contextText=readFileSync(contextPath,'utf8'),context=JSON.parse(contextText),rawHash=createHash('sha256'),outputHash=createHash('sha256');
  validateContext(context);
  if(existsSync(output+'.manifest.json'))throw new Error('Output manifest already exists');
  const fd=openSync(output,'wx');let report,lineNumber=0;
  const normalizer=new MomentumNormalizer(context,event=>{const line=JSON.stringify(event)+'\n';writeSync(fd,line);outputHash.update(line);});
  try{
    for await(const line of createInterface({input:createReadStream(input),crlfDelay:Infinity})){
      lineNumber++;rawHash.update(line+'\n');if(!line.trim())throw new Error('Blank raw line');normalizer.accept(JSON.parse(line));
    }
    report=normalizer.finish();
  }catch(error){
    if(Number.isFinite(normalizer.last))normalizer.output({kind:'gap',now:normalizer.last,reason:'normalization_aborted'});
    throw new Error(`Normalization failed at line ${lineNumber}: ${error.message}. Partial output is not certified.`);
  }finally{closeSync(fd);}
  Object.assign(report,{rawSha256:rawHash.digest('hex'),contextSha256:sha(contextText),normalizedSha256:outputHash.digest('hex')});
  writeFileSync(output+'.manifest.json',JSON.stringify(report,null,2)+'\n',{flag:'wx'});return report;
}
