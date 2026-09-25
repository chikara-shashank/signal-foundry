import {scan} from './momentum-scanner.js';
import {Pullback} from './momentum-pullback.js';
import {MomentumPortfolio} from './momentum-portfolio.js';

// A causal, broker-free runner for normalized, receipt-ordered research tapes.
// Provider adapters must resolve trade conditions and size units before import.
export class MomentumResearch {
  constructor(options={}){
    this.portfolio=new MomentumPortfolio(options);this.symbols=new Map();this.now=-Infinity;
    this.session=null;this.coverage=false;this.selected=new Set();this.lastScan=-Infinity;
    this.scans=[];this.signals=[];this.errors=[];this.eventCount=0;this.source=null;this.allCoverage=true;this.dataContractSha256=null;
    this.audit=options.audit??(()=>{});this.scanCount=0;this.rejections={};
  }
  state(symbol){
    if(!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol))throw new Error('Invalid symbol');
    if(!this.symbols.has(symbol))this.symbols.set(symbol,{symbol,meta:{},volume:0,pv:0,rthVolume:0,lastTrade:null,lastVolume:null,bar:null,pattern:null,healthy:this.coverage,idsAtStamp:new Set(),lastTradeTs:-Infinity,lastTradeNs:null});
    return this.symbols.get(symbol);
  }
  rescan(now,force=false){
    if(!force&&now-this.lastScan<1000)return;
    this.lastScan=now;
    const snapshots=[...this.symbols.values()].map(s=>({...s.meta,symbol:s.symbol,observedAt:now,sessionDate:this.session.date,
      cumulativeVolume:{value:s.volume,effectiveAt:s.lastVolume?.ts??now,availableAt:s.lastVolume?.now??now},
      lastTrade:s.lastTrade?{value:s.lastTrade.price,effectiveAt:s.lastTrade.ts,availableAt:s.lastTrade.now}:null,
      feedHealthy:this.coverage&&s.healthy,halted:this.portfolio.halted.get(s.symbol)}));
    const result=scan(snapshots,now);this.selected=new Set(result.selected.map(x=>x.symbol));
    this.scanCount++;for(const r of result.rejected)this.rejections[r.reason]=(this.rejections[r.reason]??0)+1;
    const row={now,...result};this.audit({kind:'scan',...row});this.scans.push(row);if(this.scans.length>100)this.scans.shift();
  }
  on(e){
    if(!Number.isFinite(e.now)||e.now<this.now)throw new Error('Tape must retain monotonic receipt order');
    this.now=e.now;this.eventCount++;
    if(e.kind==='session'){
      if(![e.open,e.close,e.coverageFrom].every(Number.isFinite)||e.close<=e.open||e.open%60000||e.close%60000||!['recorded','synthetic'].includes(e.source))throw new Error('Invalid session contract');
      if(this.source&&this.source!==e.source)throw new Error('Mixed synthetic and recorded tape');
      if(e.source==='recorded'&&!/^[a-f0-9]{64}$/.test(e.dataContractSha256??''))throw new Error('Recorded tape requires its normalization/data-contract hash');
      if(this.dataContractSha256&&this.dataContractSha256!==e.dataContractSha256)throw new Error('Data contract changed within tape');
      this.dataContractSha256=e.dataContractSha256??null;
      this.source=e.source;this.session=e;this.coverage=e.completeUniverse===true&&e.coverageComplete===true&&e.coverageFrom<=e.open-330*60000&&e.now<=e.open-330*60000;
      this.allCoverage&&=this.coverage;
      this.symbols.clear();this.selected.clear();this.lastScan=-Infinity;this.portfolio.session(e,e.now);return;
    }
    if(!this.session)throw new Error('Tape must start with an explicit session');
    this.portfolio.tick(e.now);
    if(e.kind==='coverage'){
      this.coverage&&=e.completeUniverse===true&&e.coverageComplete===true&&Number.isFinite(e.coverageFrom)&&e.coverageFrom<=this.session.open-330*60000&&e.now<=this.session.open-330*60000;
      this.allCoverage&&=this.coverage;
      for(const s of this.symbols.values())s.healthy&&=this.coverage;
      return;
    }
    if(e.kind==='gap'){
      this.coverage=false;this.allCoverage=false;
      for(const s of this.symbols.values()){s.healthy=false;s.pattern?.resetPattern();this.portfolio.halt(s.symbol,null,e.now);}
      this.errors.push({now:e.now,reason:'feed_gap',detail:e.reason??'unknown'});this.rescan(e.now,true);return;
    }
    if(e.kind==='tick'){this.rescan(e.now);return;}
    const s=this.state(e.symbol);
    if(e.kind==='invalid'){
      s.healthy=false;s.pattern?.resetPattern();this.portfolio.halt(e.symbol,null,e.now);
      this.errors.push({now:e.now,symbol:e.symbol,reason:e.reason??'invalid_provider_data'});this.rescan(e.now,true);return;
    }
    if(e.kind==='metadata'){
      if(!e.facts||typeof e.facts!=='object')throw new Error('Invalid metadata');
      // Field-level availability is checked by the scanner; never rewrite it.
      s.meta={...s.meta,...e.facts};
      const t=s.meta.tickSize;
      if(t&&Number.isFinite(t.value)&&t.value>0&&t.availableAt<=e.now&&t.effectiveAt<=e.now&&(!s.pattern||s.pattern.tickSize!==t.value))s.pattern=new Pullback(this.session.open,this.session.close,t.value);
      this.rescan(e.now,true);return;
    }
    if(e.kind==='halt'){
      if(![true,false,null].includes(e.active))throw new Error('Invalid halt state');
      this.portfolio.halt(e.symbol,e.active,e.now);if(e.active!==false)s.pattern?.resetPattern();this.rescan(e.now,true);return;
    }
    if(e.kind==='quote'){this.portfolio.quote(e,e.now,e.now>=this.session.open&&e.now<this.session.close&&e.ts>=this.session.open&&e.ts<this.session.close);return;}
    if(['correction','cancel'].includes(e.kind)){
      // No retroactive revision of an already-observed signal is allowed.
      s.healthy=false;s.pattern?.resetPattern();this.portfolio.halt(e.symbol,null,e.now);this.errors.push({now:e.now,symbol:e.symbol,reason:'trade_revision_requires_reconstruction'});this.rescan(e.now,true);return;
    }
    if(e.kind!=='trade')throw new Error(`Unsupported normalized event ${e.kind}`);
    if(e.eligible!==true||![e.ts,e.price,e.size].every(Number.isFinite)||e.ts>e.now||e.now-e.ts>3000||e.price<=0||e.size<=0||!e.id){
      // Excluded condition codes are not gaps; missing/invalid timestamps are.
      if(e.eligible===true){s.healthy=false;s.pattern?.resetPattern();this.portfolio.halt(e.symbol,null,e.now);this.errors.push({now:e.now,symbol:e.symbol,reason:'invalid_or_delayed_trade'});}
      return;
    }
    const ns=e.timestampNs===undefined?BigInt(Math.trunc(e.ts))*1000000n:BigInt(e.timestampNs);
    if(ns/1000000n!==BigInt(Math.trunc(e.ts)))throw new Error('Inconsistent trade timestamp precision');
    if(e.ts<s.lastTradeTs||(s.lastTradeNs!==null&&ns<s.lastTradeNs)){s.healthy=false;s.pattern?.resetPattern();this.portfolio.halt(e.symbol,null,e.now);this.errors.push({now:e.now,symbol:e.symbol,reason:'out_of_order_trade'});return;}
    if(e.ts>s.lastTradeTs)s.idsAtStamp.clear();
    if(s.idsAtStamp.has(String(e.id)))return;
    s.idsAtStamp.add(String(e.id));s.lastTradeTs=e.ts;s.lastTradeNs=ns;
    if(e.ts<this.session.open-330*60000||e.ts>=this.session.close)return;
    const priceEligible=e.priceEligible??e.eligible,volumeEligible=e.volumeEligible??e.eligible;
    if(volumeEligible){s.volume+=e.size;s.lastVolume=e;}
    if(priceEligible)s.lastTrade=e;
    if(e.ts>=this.session.open){
      const ts=Math.floor(e.ts/60000)*60000;
      if(s.bar&&ts>s.bar.ts){
        if(s.pattern&&s.bar.open!==null)s.pattern.bar(s.bar,e.now,s.rthVolume?s.pv/s.rthVolume:NaN);
        s.bar=null;
      }
      if(priceEligible&&volumeEligible){s.pv+=e.price*e.size;s.rthVolume+=e.size;}
      if(!s.bar)s.bar={ts,open:null,high:null,low:null,close:null,volume:0};
      if(priceEligible){
        if(s.bar.open===null){s.bar.open=e.price;s.bar.high=e.price;s.bar.low=e.price;}
        s.bar.high=Math.max(s.bar.high,e.price);s.bar.low=Math.min(s.bar.low,e.price);s.bar.close=e.price;
      }
      if(volumeEligible)s.bar.volume+=e.size;
      this.rescan(e.now);
      if(priceEligible&&this.selected.has(e.symbol)&&s.healthy&&this.portfolio.halted.get(e.symbol)===false){
        const signal=s.pattern?.trigger(e,e.now),q=this.portfolio.quotes.get(e.symbol);
        if(signal){
          const tick=s.pattern.tickSize,limit=q?Math.ceil((q.ask+tick-1e-10)/tick)*tick:NaN;
          const valid=this.portfolio.quoteUsable.get(e.symbol)===true&&q&&e.now-q.ts<=250&&q.receivedAt<=e.now&&q.ask-q.bid<=Math.min(.03,.2*(limit-signal.stop))+1e-10;
          const result={symbol:e.symbol,now:e.now,...signal,limit,tickSize:tick,accepted:false};
          if(valid)result.accepted=this.portfolio.reserve(result,e.now);else result.reason='quote_or_spread';
          this.signals.push(result);
        }
      }
    }else this.rescan(e.now);
  }
  report(){
    const portfolio=this.portfolio.report();
    return {schemaVersion:1,source:this.source,dataContractSha256:this.dataContractSha256,eventCount:this.eventCount,coverageComplete:this.allCoverage,signals:this.signals,scanCount:this.scanCount,rejectionCounts:this.rejections,recentScans:this.scans,dataErrors:this.errors,portfolio,
      validationEligible:this.source==='recorded'&&this.allCoverage&&!this.errors.length&&portfolio.completeLiquidation&&portfolio.days.length>=120&&portfolio.closedTrades.length>=200,
      limitations:['Research simulation only; no broker orders. Synthetic tapes do not establish profitability.',
        'Quote depth is a proxy: each distinct bid price offers at most 10% of its displayed size per exit order, less size already consumed. Repeated snapshots do not invent replenishment.',
        'Missing metadata is rejected. Full-universe and 04:00 coverage are required for primary evaluation. Trade corrections fail closed for that symbol for the session.',
        'Broker-native order semantics, queue position, market impact, tick-regime data and cancel races still need execution calibration. Open positions retain capital and are not liquidated at invented prices.']};
  }
}
