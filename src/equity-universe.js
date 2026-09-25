import { Features } from './features.js';
import { assess } from './strategies.js';
import { BAR_STRATEGIES } from './strategy-registry.js';
import { hash, isCrypto, nyDate, sleep, validateQuote } from './util.js';

export function eligibleEquities(assets) {
  return [...assets].filter(([s,a]) => a.tradable && a.assetClass === 'us_equity' && a.status === 'active' &&
    ['NYSE','NASDAQ','AMEX','ARCA','BATS','NYSEARCA'].includes(a.exchange) && /^[A-Z][A-Z0-9.]{0,9}$/.test(s)).map(([s])=>s).sort();
}

// Full-universe screening is inexpensive. Exact setups use completed history in stage two.
// Daily-average minute volume is a discovery proxy, never the strategy's relative-volume feature.
export function screenSnapshot(symbol, s, cfg, now) {
  const p=cfg.universe, q=s?.latestQuote, b=s?.minuteBar, day=s?.dailyBar, prev=s?.prevDailyBar;
  const quote={ts:Date.parse(q?.t),bid:q?.bp,ask:q?.ap};
  const reject=reason=>({symbol,eligible:false,reason});
  if(!validateQuote(quote,now,cfg.maxQuoteAge)||!(q.bs>0&&q.as>0))return reject('stale_or_invalid_quote');
  if(!b||!Number.isFinite(Date.parse(b.t))||now-Date.parse(b.t)>120000||Date.parse(b.t)+60000>now+1000||
      ![b.c,b.o,b.h,b.l,b.v,day?.c,day?.h,day?.l,day?.v,prev?.c,prev?.v].every(x=>Number.isFinite(x)&&x>0))return reject('missing_or_stale_bars');
  if(!Number.isFinite(Date.parse(day.t))||!Number.isFinite(Date.parse(prev.t))||now-Date.parse(prev.t)>7*86400000||nyDate(Date.parse(day.t))!==nyDate(now)||nyDate(Date.parse(prev.t))>=nyDate(now))return reject('wrong_session');
  if(quote.ask<p.minPrice||quote.ask>Math.min(p.maxPrice,cfg.maxPosition))return reject('price_or_position_cap');
  const spreadBps=(quote.ask-quote.bid)/((quote.ask+quote.bid)/2)*10000;
  if(spreadBps>cfg.maxSpread)return reject('spread');
  if(prev.c*prev.v<p.minDailyDollarVolume||b.c*b.v<p.minMinuteDollarVolume)return reject('liquidity');
  const volumeProxy=b.v/(prev.v/390), change=b.c/prev.c-1, location=(b.c-day.l)/Math.max(day.h-day.l,.01);
  const activity=Math.log1p(volumeProxy)+Math.log1p(b.c*b.v/100000), recovery=(b.c-b.l)/Math.max(b.h-b.l,.01);
  const scores={range_breakout:activity+2*location+Math.max(0,change)*20,
    failed_breakout:activity+2*recovery+Math.max(0,-change)*10,
    trend_pullback:activity+Math.max(0,change)*20, vwap_reversion:activity+Math.max(0,-change)*20,
    volatility_expansion:activity+2*location, order_flow_continuation:activity};
  return {symbol,eligible:true,quoteAt:quote.ts,price:quote.ask,spreadBps,minuteDollarVolume:b.c*b.v,priorDailyDollarVolume:prev.c*prev.v,volumeProxy,change,scores};
}

export function contextShortlist(rows, strategies, limit, offset=0) {
  if(!rows.length)return [];
  const ids=strategies.filter(s=>s!=='noise_area'), lists=(ids.length?ids:['range_breakout']).map(s=>[...rows].sort((a,b)=>(b.scores[s]??0)-(a.scores[s]??0)||a.symbol.localeCompare(b.symbol)));
  const selected=new Map(), slots=Math.max(1,Math.floor(limit*.8));
  for(let i=0;selected.size<slots&&i<rows.length;i++)for(const list of lists){if(selected.size>=slots)break;selected.set(list[i].symbol,list[i]);}
  const alphabet=[...rows].sort((a,b)=>a.symbol.localeCompare(b.symbol));
  for(let i=0;selected.size<limit&&i<alphabet.length;i++){const row=alphabet[(offset+i)%alphabet.length];selected.set(row.symbol,row);}
  return [...selected.values()];
}

export class EquityUniverse {
  constructor(engine, fetchFn=fetch, wait=sleep) {
    this.engine=engine;this.fetch=fetchFn;this.wait=wait;this.busy=false;this.lastAttempt=0;this.offset=0;
    this.state={mode:engine.cfg.universe.mode,state:'starting',lastCompleteAt:null,selected:[],note:'All eligible Alpaca-listed stocks and ETFs are screened. Exact strategy checks run on a rotating shortlist. Float metadata is unavailable; company-news research appears in Sessions & tomorrow’s watchlist.'};
    this.selectedAt=new Map();this.feed=null;
  }
  // Restore positions and the last subscribed set before the first broker reconciliation.
  restore() {
    const e=this.engine,saved=e.store.get('equityUniverse');
    const retained=saved?.symbols??e.cfg.equities;
    const pins=this.pins();if(pins.length>e.cfg.universe.streamLimit)throw new Error('universe_pins_exceed_stream_limit');
    e.cfg.equities=[...new Set([...pins,...retained])].slice(0,e.cfg.universe.streamLimit);e.cfg.symbols=[...e.cfg.equities,...e.cfg.crypto];e.realtime.trades.setSymbols(e.cfg.symbols);
  }
  validateRestoredAssets() {
    const e=this.engine,eligible=new Set(eligibleEquities(e.assets)),owned=new Set([...Object.keys(e.managed),...e.pending().map(o=>o.symbol)]);
    e.cfg.equities=e.cfg.equities.filter(s=>eligible.has(s)||owned.has(s));
    e.cfg.symbols=[...e.cfg.equities,...e.cfg.crypto];e.realtime.trades.setSymbols(e.cfg.symbols);
  }
  pins() {
    const e=this.engine;
    const owned=[...new Set([...Object.keys(e.managed),...e.pending().map(o=>o.symbol),
      ...(e.cfg.noiseSymbol&&(!e.assets.size||e.assets.get(e.cfg.noiseSymbol)?.tradable)?[e.cfg.noiseSymbol]:[])])].filter(s=>!isCrypto(s));
    return [...owned,...(e.desk?.watchSymbols()??[]).filter(s=>!owned.includes(s)&&e.assets.get(s)?.tradable).slice(0,Math.max(0,e.cfg.universe.streamLimit-owned.length))];
  }
  async primeWatchlist() {
    const e=this.engine,selected=[...new Set([...this.pins(),...e.cfg.equities])].slice(0,e.cfg.universe.streamLimit);
    await e.mutex.run(()=>{e.cfg.equities=selected;e.cfg.symbols=[...selected,...e.cfg.crypto];e.realtime.trades.setSymbols(e.cfg.symbols);this.state.subscriptionReady=false;});
    await this.feed?.setSymbols(selected);
  }
  entryReady(now) { return this.state.lastCompleteAt!=null && now-this.state.lastCompleteAt<=Math.max(900000,this.engine.cfg.universe.refreshMs*3) && this.state.subscriptionReady!==false; }
  selection(symbol) { return {scanId:this.state.scanId,scannedAt:this.state.lastCompleteAt,feed:this.engine.cfg.feed,row:this.state.selected.find(x=>x.symbol===symbol)??null}; }
  status() { return {...this.state,scanning:this.busy,streamed:this.engine.cfg.equities.length,streamLimit:this.engine.cfg.universe.streamLimit}; }
  async snapshots(symbols) {
    const e=this.engine,q=new URLSearchParams({symbols:symbols.join(','),feed:e.cfg.feed});
    const r=await this.fetch('https://data.alpaca.markets/v2/stocks/snapshots?'+q,{headers:{'APCA-API-KEY-ID':e.cfg.key,'APCA-API-SECRET-KEY':e.cfg.secret},redirect:'error',signal:AbortSignal.timeout(10000)});
    if(!r.ok)throw new Error('universe_http_'+r.status);
    const rows=await r.json();if(!rows||typeof rows!=='object'||Array.isArray(rows))throw new Error('universe_invalid_snapshots');
    return rows;
  }
  async poll(force=false) {
    const e=this.engine,p=e.cfg.universe,now=e.clock();
    if(e.schedule&&!e.schedule.state(now).equityTracking){this.state.state='scheduled_off';return;}
    if(this.busy||e.stopped||(!force&&(!e.session?.open||now-this.lastAttempt<p.refreshMs)))return;
    this.busy=true;this.lastAttempt=now;this.state.state='scanning';
    try {
      // Refresh the active asset master daily; retain broker metadata needed by sizing.
      if(this.assetDate&&this.assetDate!==nyDate(now))e.assets=await e.broker.assets();
      this.assetDate=nyDate(now);
      const symbols=eligibleEquities(e.assets),rows=[],rejections={};let returned=0;
      if(!symbols.length)throw new Error('universe_empty_asset_master');
      this.state={...this.state,eligibleAssets:symbols.length,scanned:0,scanStartedAt:now,feed:e.cfg.feed};
      for(let i=0;i<symbols.length;i+=200){
        if(e.stopped||e.schedule&&!e.schedule.state().equityTracking)return;
        const batch=symbols.slice(i,i+200),snapshots=await this.snapshots(batch);
        for(const symbol of batch){if(snapshots[symbol])returned++;const row=screenSnapshot(symbol,snapshots[symbol],e.cfg,e.clock());
          if(row.eligible)rows.push(row);else rejections[row.reason]=(rejections[row.reason]??0)+1;}
        this.state.scanned=Math.min(i+200,symbols.length);
        // At most 80 discovery HTTP calls/minute, leaving data capacity for history/options.
        if(i+200<symbols.length)await this.wait(750);
      }
      const strategies=e.strategyControls.enabledIds(),pool=contextShortlist(rows,strategies,p.candidateLimit,this.offset);
      this.offset+=Math.max(1,Math.ceil(p.candidateLimit*.2));
      const end=Math.floor(e.clock()/60000)*60000;
      if(e.schedule&&!e.schedule.state().equityTracking)return;
      const contextSymbols=[...new Set([...pool.map(x=>x.symbol),...this.pins()])];
      const history=contextSymbols.length?await e.stockHistory.bars(contextSymbols,end-150*60000,end):new Map();
      if(e.stopped||e.schedule&&!e.schedule.state().equityTracking)return;
      for(const row of pool){const features=new Features();let f=null;for(const b of history.get(row.symbol)??[])f=features.add(b,e.clock());
        const reports=f&&end-(f.bar.ts+60000)<=60000?strategies.filter(s=>BAR_STRATEGIES.includes(s)).map(s=>assess(s,f,e.clock()).assessment):[];
        row.matches=reports.filter(x=>x.matched).map(x=>x.strategy);row.contextReady=!!f&&end-(f.bar.ts+60000)<=60000;
        row.checks=reports.map(x=>({strategy:x.strategy,matched:x.matched,passed:x.passed,total:x.checks.length,reason:x.reason}));
        row.rank=row.matches.length*100+(reports.length?Math.max(...reports.map(x=>x.passed/x.checks.length))*10:0)+Math.max(...Object.values(row.scores));}
      pool.sort((a,b)=>b.rank-a.rank||a.symbol.localeCompare(b.symbol));
      const scanId=hash({at:now,assets:hash(symbols),pool:pool.map(x=>[x.symbol,x.rank]),policy:p,strategies});
      // Freeze entries atomically, then change subscriptions outside the order mutex.
      // Existing exits continue while the market-data server acknowledges the rotation.
      let pins,selected,added,removed;
      await e.mutex.run(()=>{
        if(e.stopped)return;
        pins=this.pins();if(pins.length>p.streamLimit)throw new Error('universe_pins_exceed_stream_limit');
        const eligible=new Set(rows.map(x=>x.symbol));
        const retained=e.cfg.equities.filter(s=>eligible.has(s)&&e.clock()-(this.selectedAt.get(s)??0)<p.minDwellMs);
        selected=[...new Set([...pins,...retained,...pool.map(x=>x.symbol)])].slice(0,p.streamLimit);
        if(!selected.length)throw new Error('universe_no_liquid_candidates');
        added=selected.filter(s=>!e.cfg.equities.includes(s));
        removed=e.cfg.equities.filter(s=>!selected.includes(s));
        e.store.transaction(()=>{for(const s of added){e.features.history.delete(s);e.snapshots.delete(s);e.backfill(s,history.get(s)??[],true);}});
        this.state.subscriptionReady=false;
        e.cfg.symbols=[...new Set([...e.cfg.equities,...selected,...e.cfg.crypto])];
        e.realtime.trades.setSymbols(e.cfg.symbols);
      });
      if(e.stopped)return;
      await this.feed?.setSymbols(selected);
      await e.mutex.run(()=>{
        if(e.stopped)return;
        e.cfg.equities=selected;e.cfg.symbols=[...selected,...e.cfg.crypto];
        e.realtime.trades.setSymbols(e.cfg.symbols);
        for(const s of removed){this.selectedAt.delete(s);for(const map of [e.features.history,e.snapshots,e.quotes,e.quoteHistory,e.quoteScans,e.microstructure.states,e.realtime.quoteReceived])map?.delete(s);
          for(const map of [e.observability.reports,e.observability.lastScanLog,e.observability.lastQuoteLog])for(const key of map.keys())if(key.startsWith(s+':'))map.delete(key);}
        for(const s of selected)if(!this.selectedAt.has(s))this.selectedAt.set(s,e.clock());
        const selectedRows=selected.map(symbol=>({...pool.find(x=>x.symbol===symbol)??rows.find(x=>x.symbol===symbol)??{symbol},pinned:pins.includes(symbol)}));
        this.state={...this.state,state:'ready',subscriptionReady:true,error:null,lastCompleteAt:e.clock(),scanId,assetHash:hash(symbols),
          returnedSnapshots:returned,passedScreen:rows.length,contextChecked:pool.length,rejections,selected:selectedRows};
        e.store.set('equityUniverse',{symbols:selected,scanId,at:e.clock()});
        e.store.event('universe_scan',{...this.status(),added,removed},e.clock());
      });
    } catch(error){this.state.state='degraded';this.state.error=/^universe_\w+$/.test(error.message)?error.message:'universe_history_or_subscription_failed';
      if(!e.stopped)e.store.event('universe_scan_failed',{reason:this.state.error},e.clock());
    } finally {this.busy=false;}
  }
}
