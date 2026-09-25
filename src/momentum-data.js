import {mkdirSync,writeFileSync,appendFileSync,openSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function exchangeTime(date,time){
  if(!/^\d{4}-\d\d-\d\d$/.test(date)||!/^\d\d:\d\d$/.test(time))throw new Error('Invalid exchange time');
  const utc=Date.parse(`${date}T${time}:00Z`);
  const fmt=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const parts=Object.fromEntries(fmt.formatToParts(utc).map(p=>[p.type,p.value]));
  const shown=Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00Z`);
  return utc+(utc-shown);
}

// Read-only, fixed Alpaca hosts. Credentials are only used in authentication headers.
export class MomentumData {
  constructor({key,secret,fetchFn=fetch,now=()=>Date.now()}){
    if(!key||!secret)throw new Error('Alpaca credentials required');
    this.headers={'APCA-API-KEY-ID':key,'APCA-API-SECRET-KEY':secret};this.fetch=fetchFn;this.now=now;this.offset=null;
  }
  async get(host,path){
    if(!['https://paper-api.alpaca.markets','https://data.alpaca.markets'].includes(host)||!path.startsWith('/')||path.includes('://'))throw new Error('Unapproved data URL');
    const startedAt=this.now();
    const r=await this.fetch(host+path,{method:'GET',headers:this.headers,redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!r.ok)throw new Error(`market_data_http_${r.status}`);
    const body=await r.json(),receivedAtLocal=this.now();
    return {startedAtLocal:startedAt,receivedAtLocal,receivedAt:this.offset===null?null:receivedAtLocal+this.offset,body};
  }
  async clock(){
    const x=await this.get('https://paper-api.alpaca.markets','/v2/clock'),provider=Date.parse(x.body.timestamp);
    if(!Number.isFinite(provider))throw new Error('Invalid provider clock');
    this.offset=provider-(x.startedAtLocal+x.receivedAtLocal)/2;
    return {...x,offsetMs:this.offset,uncertaintyMs:(x.receivedAtLocal-x.startedAtLocal)/2};
  }
  async discover(dir){
    mkdirSync(dir,{recursive:true});const clock=await this.clock();
    const assets=await this.get('https://paper-api.alpaca.markets','/v2/assets?status=active&asset_class=us_equity');
    if(!Array.isArray(assets.body))throw new Error('Invalid asset catalog');
    const candidates=assets.body.filter(a=>a.tradable&&['NASDAQ','NYSE','AMEX','ARCA','BATS'].includes(a.exchange)&&/^[A-Z][A-Z0-9.]{0,9}$/.test(a.symbol));
    const snapshots={};let batches=0;
    for(let i=0;i<candidates.length;i+=500){
      const symbols=candidates.slice(i,i+500).map(a=>a.symbol),x=await this.get('https://data.alpaca.markets',`/v2/stocks/snapshots?feed=sip&symbols=${encodeURIComponent(symbols.join(','))}`);
      Object.assign(snapshots,x.body);writeFileSync(join(dir,`snapshot-${batches++}.json`),JSON.stringify(x),{flag:'wx'});
    }
    const rows=candidates.flatMap(a=>{
      const x=snapshots[a.symbol],price=x?.latestTrade?.p,previous=x?.prevDailyBar?.c;
      if(!(price>=1&&price<=20&&previous>0&&price/previous>=1.1))return [];
      const excludedType=/warrant|\brights?\b|\bunits?\b|preferred|depositary|\bETF\b|\bETN\b|\bfund\b|\btrust\b/i.test(a.name);
      return [{symbol:a.symbol,name:a.name,price,gainPct:(price/previous-1)*100,spread:x.latestQuote?x.latestQuote.ap-x.latestQuote.bp:null,
        preliminaryType:excludedType?'excluded_by_name':'needs_verified_common_share_classification',float:null,qualified:false,
        missing:['verified_float','verified_security_type','split_basis','30_session_volume_baseline','material_catalyst_classification','complete_receipt_tape','point_in_time_tick_and_lot_rules','continuous_halt_status','04_00_session_coverage'],
        quoteSizeUnits:'provider_round_lots_not_shares'}];
    }).sort((a,b)=>b.gainPct-a.gainPct||a.symbol.localeCompare(b.symbol));
    const symbols=rows.filter(x=>x.preliminaryType!=='excluded_by_name').slice(0,20).map(x=>x.symbol);
    let news=null;try{news=await this.get('https://data.alpaca.markets',`/v1beta1/news?limit=50&include_content=false&symbols=${encodeURIComponent(symbols.join(','))}`);}catch(error){news={error:error.message};}
    writeFileSync(join(dir,'assets.json'),JSON.stringify(assets),{flag:'wx'});
    writeFileSync(join(dir,'news.json'),JSON.stringify(news),{flag:'wx'});
    const report={schemaVersion:1,purpose:'read_only_data_readiness_not_trade_signals',clock:{providerTime:clock.body.timestamp,offsetMs:clock.offsetMs,uncertaintyMs:clock.uncertaintyMs},
      assets:assets.body.length,requested:candidates.length,snapshots:Object.keys(snapshots).length,batches,screened:rows.length,qualified:0,newsCount:news.body?.news?.length??0,
      rows,recordingSymbols:symbols.slice(0,5),warnings:['Current catalog only: not a historical point-in-time universe. Snapshot batches arrive at different times.',
        'Name-based exclusions are preliminary and never certify common-share status. Float is unknown, not zero.',
        'News availability is recorded at retrieval. Publication times alone do not prove historical availability.',
        'Daily snapshot volume is not substituted for cumulative 04:00 volume or a 30-session denominator.']};
    writeFileSync(join(dir,'readiness.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});return report;
  }
  async sample(symbols,seconds,path){
    if(!symbols.length||symbols.length>20||symbols.some(s=>!/^[A-Z][A-Z0-9.]{0,9}$/.test(s))||!Number.isInteger(seconds)||seconds<1||seconds>60)throw new Error('Require 1-20 symbols and a 1-60 second sample');
    const fd=openSync(path,'wx');closeSync(fd);const clock=await this.clock();
    appendFileSync(path,JSON.stringify({kind:'capture_header',source:'alpaca_sip_rest',symbols,completeTickCoverage:false,completeUniverse:false,quoteSizeUnits:'round_lots',clockOffsetMs:clock.offsetMs,clockUncertaintyMs:clock.uncertaintyMs})+'\n');
    const end=this.now()+seconds*1000;let observations=0;
    while(this.now()<end){
      const x=await this.get('https://data.alpaca.markets',`/v2/stocks/snapshots?feed=sip&symbols=${encodeURIComponent(symbols.join(','))}`);
      appendFileSync(path,JSON.stringify({kind:'snapshot_sample',...x})+'\n');observations++;
      if(this.now()<end)await new Promise(resolve=>setTimeout(resolve,1000));
    }
    return {path,observations,symbols,completeTickCoverage:false};
  }
  async prepare(dir,date,symbols){
    if(!/^\d{4}-\d\d-\d\d$/.test(date)||!symbols.length||symbols.length>5||new Set(symbols).size!==symbols.length||symbols.some(s=>!/^[A-Z][A-Z0-9.]{0,9}$/.test(s)))throw new Error('Require a session date and 1-5 unique symbols');
    mkdirSync(dir,{recursive:true});await this.clock();
    const start=new Date(Date.parse(date+'T00:00:00Z')-70*86400000).toISOString().slice(0,10),end=new Date(Date.parse(date+'T00:00:00Z')+7*86400000).toISOString().slice(0,10);
    const calendar=await this.get('https://paper-api.alpaca.markets',`/v2/calendar?start=${start}&end=${end}`);
    if(!Array.isArray(calendar.body))throw new Error('Invalid calendar');
    const target=calendar.body.find(x=>x.date===date),prior=calendar.body.filter(x=>x.date<date).slice(-30);
    if(!target||prior.length!==30||!target.settlement_date)throw new Error('Require a trading day and 30 prior sessions');
    const session={date,nextDate:target.settlement_date,open:exchangeTime(date,target.open),close:exchangeTime(date,target.close)};
    if(exchangeTime(prior.at(-1).date,prior.at(-1).close)>calendar.receivedAt)throw new Error('Prior sessions are not complete');
    writeFileSync(join(dir,'calendar.json'),JSON.stringify(calendar,null,2),{flag:'wx'});
    const calendarEvidence={sourceUrl:'https://paper-api.alpaca.markets/v2/calendar',sha256:digest(calendar)};
    const sessions=new Map(prior.map(x=>[x.date,{open:exchangeTime(x.date,x.open),close:exchangeTime(x.date,x.close)}]));
    const metadata=[],review=[];
    for(const symbol of symbols){
      const asset=await this.get('https://paper-api.alpaca.markets',`/v2/assets/${symbol}`);
      writeFileSync(join(dir,`${symbol}-asset.json`),JSON.stringify(asset,null,2),{flag:'wx'});
      if(asset.body.symbol!==symbol)throw new Error('Unexpected asset symbol');
      const evidence={sourceUrl:`https://paper-api.alpaca.markets/v2/assets/${symbol}`,sha256:digest(asset)};
      metadata.push({symbol,now:asset.receivedAt,facts:{tradable:{value:asset.body.tradable===true,effectiveAt:asset.receivedAt,availableAt:asset.receivedAt,evidence}}});
      const base=`/v2/stocks/${symbol}/bars?timeframe=1Min&feed=sip&adjustment=raw&asof=-&sort=asc&limit=10000&start=${encodeURIComponent(new Date(sessions.get(prior[0].date).open).toISOString())}&end=${encodeURIComponent(new Date(sessions.get(prior.at(-1).date).close).toISOString())}`;
      let token=null,lastTs=-Infinity,receivedAt=null,pages=0;const seen=new Set(),volumes=new Map(),raw=[];
      do {
        if(pages++>=100||token&&seen.has(token))throw new Error('Historical bars pagination did not terminate');
        if(token)seen.add(token);
        const response=await this.get('https://data.alpaca.markets',base+(token?'&page_token='+encodeURIComponent(token):''));raw.push(response);receivedAt=response.receivedAt;
        if(!Array.isArray(response.body.bars))throw new Error('Invalid historical bars');
        for(const bar of response.body.bars){
          const ts=Date.parse(bar.t),d=new Date(ts).toISOString().slice(0,10),hours=sessions.get(d);
          if(!Number.isFinite(ts)||ts<=lastTs||!Number.isSafeInteger(bar.v)||bar.v<0)throw new Error('Historical bars must be ordered, unique and valid');
          lastTs=ts;if(hours&&ts>=hours.open&&ts<hours.close)volumes.set(d,(volumes.get(d)??0)+bar.v);
        }
        token=response.body.next_page_token??null;
      }while(token);
      writeFileSync(join(dir,`${symbol}-prior-minute-bars.json`),JSON.stringify(raw),{flag:'wx'});
      const complete=prior.every(d=>volumes.has(d.date));
      if(complete){
        const value=[...volumes.values()].reduce((a,b)=>a+b,0)/30;
        if(value>0)metadata.push({symbol,now:receivedAt,facts:{volumeBaseline:{value,sessions:30,lastSession:prior.at(-1).date,convention:'regular_session_eligible_volume',effectiveAt:sessions.get(prior.at(-1).date).close,availableAt:receivedAt,evidence:{sourceUrl:'https://data.alpaca.markets'+base,sha256:digest(raw)}}}});
      }
      const news=await this.get('https://data.alpaca.markets',`/v1beta1/news?symbols=${symbol}&limit=50&include_content=false`);
      writeFileSync(join(dir,`${symbol}-news.json`),JSON.stringify(news,null,2),{flag:'wx'});
      review.push({symbol,qualified:false,priorSessionsWithBars:volumes.size,baselineConstructed:complete,newsForReview:news.body.news?.length??0,
        missing:['verified_common_share_type','float_shares_with_source','split_consistent_previous_close','corporate_action_review','material_news_review','venue_tick_size','round_lot_shares','initial_halt_state'],
        note:'Tradability expires after 60 seconds. Refresh during collection; no timeless broker eligibility is inferred.'});
    }
    const context={schemaVersion:1,mode:'diagnostic',session,calendarEvidence,metadata};
    writeFileSync(join(dir,'context.json'),JSON.stringify(context,null,2)+'\n',{flag:'wx'});
    const report={purpose:'bounded_pilot_metadata_preparation',date,symbols,qualified:0,review,contextPath:join(dir,'context.json'),warnings:['Historical bars were first retrieved now. They cannot establish earlier decision availability.','Raw split-unadjusted prior volumes require corporate-action review before use. A missing prior session rejects the baseline.','Regular-session minute volumes include [open, close); closing-auction timestamp conventions require calibration.','News is a bounded review queue, not an exhaustive classified catalyst feed. No float or share-class guesses are supplied.']};
    writeFileSync(join(dir,'readiness.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});return report;
  }
}
