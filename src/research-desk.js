import { hash, idFor, nyDate, positive } from './util.js';
import { eligibleEquities } from './equity-universe.js';
import { analyzeNews, newsDigest } from './news-analysis.js';
import { CARRY_STRATEGY, closingPattern, favorableNews, overnightAllocation, adverseNews } from './overnight-policy.js';

const text=(value,max)=>String(value??'').replace(/<[^>]*>/g,' ').replace(/[\x00-\x1f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
export function normalizeNews(row, now) {
  const publishedAt=Date.parse(row.created_at),updatedAt=Date.parse(row.updated_at??row.created_at);
  if(!/^[\w-]{1,100}$/.test(String(row.id))||!Number.isFinite(publishedAt)||!Number.isFinite(updatedAt)||publishedAt>now+1000||updatedAt>now+1000||now-publishedAt>48*3600000||!Array.isArray(row.symbols))return null;
  const symbols=[...new Set(row.symbols.filter(s=>/^[A-Z][A-Z0-9.]{0,9}$/.test(s)))].slice(0,40);
  const headline=text(row.headline,500),summary=text(row.summary,1800),source=text(row.source,80);
  if(!symbols.length||!headline)return null;
  let url=null;try{const u=new URL(row.url);if(u.protocol==='https:')url=u.href;}catch{}
  const result={id:String(row.id),symbols,headline,summary,source,url,publishedAt,updatedAt,observedAt:now};
  result.digest=hash({id:result.id,symbols,headline,summary,source,publishedAt,updatedAt});return result;
}
export function screenClosingStock(symbol, snapshot, session, now, cfg) {
  const day=snapshot?.dailyBar, prior=snapshot?.prevDailyBar;
  if(!day||!prior||![day.c,day.h,day.l,day.v,prior.c,prior.v].every(positive)||!Number.isFinite(Date.parse(day.t))||!Number.isFinite(Date.parse(prior.t))||nyDate(Date.parse(day.t))!==session.date||nyDate(Date.parse(prior.t))>=session.date)return null;
  const p=day.c, liquidity=prior.c*prior.v, location=(p-day.l)/Math.max(day.h-day.l,.01), change=p/prior.c-1;
  const fraction=Math.min(1,Math.max(.1,(Math.min(now,session.close)-session.open)/(session.close-session.open))), relativeVolume=day.v/(prior.v*fraction);
  if(p<Math.max(2,cfg.universe.minPrice)||p>cfg.maxPosition||liquidity<Math.max(5000000,cfg.universe.minDailyDollarVolume)||location<.65||change<0||change>.15||relativeVolume<1)return null;
  return {symbol,price:p,liquidity,location,change,relativeVolume,score:location*40+Math.min(relativeVolume,4)*10+Math.min(change*100,10),session:session.date};
}
export class ResearchDesk {
  constructor(engine, fetchFn=fetch, wait=ms=>new Promise(r=>setTimeout(r,ms))) {
    this.engine=engine;this.fetch=fetchFn;this.wait=wait;this.busy=false;this.lastNewsAttempt=0;this.lastScanAttempt=0;
    this.articles=engine.store.get('newsArticles',[]);
    this.state=engine.store.get('researchDesk',{watchlist:[],scans:{},patterns:[],newsAt:0,newsComplete:false});
    this.views=engine.store.get('newsViews',{});
  }
  relevant(symbol, now=this.engine.clock()) { return this.articles.filter(a=>a.symbols.includes(symbol)&&a.publishedAt<=now&&a.observedAt<=now&&now-a.publishedAt<=36*3600000).sort((a,b)=>b.publishedAt-a.publishedAt||a.id.localeCompare(b.id)).slice(0,4); }
  currentView(symbol, now=this.engine.clock()) {
    const view=this.views[symbol], articles=this.relevant(symbol,now);
    return view&&articles.length&&view.digest===newsDigest(symbol,articles,this.engine.cfg)?view:null;
  }
  watchSymbols() {
    const s=this.engine.schedule?.state();if(!s?.calendarFresh)return [];
    return this.state.watchlist.filter(r=>r.plan!=='avoid'&&r.expiresAt>this.engine.clock()&&(r.targetSession===s.date||s.today&&this.engine.clock()>=s.today.close-45*60000&&r.sourceSession===s.date)).slice(0,10).map(r=>r.symbol);
  }
  snapshot() { return {...this.state,policy:this.engine.cfg.overnight,watchlist:this.state.watchlist.map(r=>({...r,news:this.currentView(r.symbol),stale:r.expiresAt<=this.engine.clock()})),scanning:this.busy,allocation:overnightAllocation(this.engine),model:{configured:!!this.engine.cfg.jevKey&&this.engine.cfg.jevMode!=='off',callsToday:this.engine.store.get('newsModelCalls:'+nyDate(this.engine.clock()),0),dailyLimit:this.engine.cfg.desk.maxModelCallsPerDay},
    note:'Closing-strength and company-news research prepares the next exchange session. News classification is not a return forecast. Long-only paper/shadow carry entries use fresh price confirmation, GTC brackets, a shared allocation cap and a maximum holding deadline; stops cannot prevent overnight gaps.'}; }
  save() { if(!this.engine.stopped){this.engine.store.set('researchDesk',this.state);this.engine.store.set('newsViews',this.views);} }
  async poll() {
    const e=this.engine,now=e.clock();if(this.busy||e.stopped||!e.cfg.desk.enabled)return;
    this.busy=true;
    try {
      const schedule=e.schedule?.state(now);
      if(!schedule?.calendarFresh){this.state.error='calendar_unavailable';return;}
      if(now-this.lastNewsAttempt>=e.cfg.desk.newsPollMs){this.lastNewsAttempt=now;try{await this.collectNews();this.state.newsError=null;}catch(error){this.state.newsError=/^news_\w+$/.test(error.message)?error.message:'news_unavailable';}}
      if(e.stopped)return;
      const preclose=schedule.today&&now>=schedule.today.close-45*60000&&now<schedule.today.close;
      const session=preclose?schedule.today:schedule.last, phase=preclose?'preclose':'postclose';
      if(session&&(preclose||now>=session.close+e.cfg.desk.closeScanDelayMs)&&!this.state.scans[session.date+':'+phase]&&now-this.lastScanAttempt>300000) {
        this.lastScanAttempt=now;try{await this.scanClose(session,phase);this.state.scanError=null;}catch(error){this.state.scanError=/^close_scan_\w+$/.test(error.message)?error.message:'close_scan_unavailable';}
      }
      if(e.stopped)return;
      // Closing-session and off-hours research only; avoid spending the day's
      // news classification budget on every intraday headline.
      if(!schedule.equityTracking||preclose)await this.reviewNews();
      this.buildWatchlist();this.state.error=null;
    } catch(error) {this.state.error=/^(news|close_scan)_\w+$/.test(error.message)?error.message:'research_desk_unavailable';}
    finally{this.busy=false;this.save();}
  }
  async collectNews() {
    const e=this.engine,now=e.clock(), found=new Map(this.articles.filter(a=>now-a.publishedAt<=48*3600000).map(a=>[a.id,a]));
    // Re-read the window so revisions to yesterday's articles invalidate a thesis.
    const start=now-36*3600000;
    this.state.newsComplete=false;
    let token=null,complete=false;
    // Bounded all-ticker intake. If the response exceeds this bound, surface
    // incomplete coverage and disable new carry entries until a complete poll.
    for(let page=0;page<60;page++) {
      if(e.stopped)return;
      const q=new URLSearchParams({start:new Date(start).toISOString(),end:new Date(now).toISOString(),limit:'50',sort:'desc',include_content:'false',...(token?{page_token:token}:{})});
      const r=await this.fetch('https://data.alpaca.markets/v1beta1/news?'+q,{headers:{'APCA-API-KEY-ID':e.cfg.key,'APCA-API-SECRET-KEY':e.cfg.secret},redirect:'error',signal:AbortSignal.timeout(10000)});
      if(!r.ok){this.state.newsComplete=false;throw new Error('news_http_'+r.status);}
      const body=await r.json();if(!Array.isArray(body.news)||body.news.length>50)throw new Error('news_invalid');
      for(const raw of body.news){const row=normalizeNews(raw,e.clock());if(!row)continue;const prior=found.get(row.id);if(!prior||row.updatedAt>prior.updatedAt||row.digest!==prior.digest){found.set(row.id,row);e.store.event('news_observed',row,row.observedAt);}}
      token=body.next_page_token;if(!token){complete=true;break;}await this.wait(1000);
    }
    if(e.stopped)return;
    this.articles=[...found.values()].sort((a,b)=>b.publishedAt-a.publishedAt).slice(0,5000);
    e.store.set('newsArticles',this.articles);this.state.newsAt=e.clock();this.state.newsComplete=complete;this.state.articleCount=this.articles.length;
  }
  async scanClose(session,phase) {
    const e=this.engine, symbols=eligibleEquities(e.assets), rows=[];
    if(!symbols.length)throw new Error('close_scan_no_assets');
    this.state.scanProgress={session:session.date,phase,scanned:0,total:symbols.length};
    for(let i=0;i<symbols.length;i+=200) {
      if(e.stopped)return;
      // Low-rate research snapshots, separate from the fast data stream.
      const q=new URLSearchParams({symbols:symbols.slice(i,i+200).join(','),feed:e.cfg.feed});
      const response=await this.fetch('https://data.alpaca.markets/v2/stocks/snapshots?'+q,{headers:{'APCA-API-KEY-ID':e.cfg.key,'APCA-API-SECRET-KEY':e.cfg.secret},redirect:'error',signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw new Error('close_scan_http_'+response.status);
      const snapshots=await response.json();if(!snapshots||typeof snapshots!=='object'||Array.isArray(snapshots))throw new Error('close_scan_invalid');
      for(const symbol of symbols.slice(i,i+200)){const row=screenClosingStock(symbol,snapshots[symbol],session,e.clock(),e.cfg);if(row)rows.push(row);}
      this.state.scanProgress.scanned=Math.min(symbols.length,i+200);if(i+200<symbols.length)await this.wait(1000);
    }
    const pool=rows.sort((a,b)=>b.score-a.score||a.symbol.localeCompare(b.symbol)).slice(0,60);
    const end=Math.min(Math.floor(e.clock()/60000)*60000,session.close), bars=pool.length?await e.stockHistory.bars(pool.map(r=>r.symbol),end-60*60000,end,'1Min',{research:true}):new Map();
    if(e.stopped)return;
    this.state.patterns=pool.map(r=>({...r,pattern:closingPattern(bars.get(r.symbol)??[],session,end),observedAt:e.clock()}));
    this.state.sourceSession=session.date;this.state.scanAt=e.clock();this.state.scans[session.date+':'+phase]=e.clock();
    this.state.scans=Object.fromEntries(Object.entries(this.state.scans).filter(([,at])=>e.clock()-at<14*86400000));
    e.store.event('closing_research',{session:session.date,phase,at:e.clock(),eligibleAssets:symbols.length,screened:rows.length,patterns:this.state.patterns},e.clock());
  }
  async reviewNews() {
    const e=this.engine,now=e.clock(), eligible=new Set(eligibleEquities(e.assets)),priority=[...Object.keys(e.managed),...this.state.patterns.map(r=>r.symbol),...this.articles.flatMap(a=>a.symbols)];
    let calls=0;
    for(const symbol of [...new Set(priority)].filter(s=>eligible.has(s))) {
      if(e.stopped||calls>=4)break;
      const schedule=e.schedule.state(now), used=e.store.get('newsModelCalls:'+nyDate(now),0);
      if(schedule.today&&now<schedule.today.open&&used>=4||schedule.regular&&used>=16)break;
      const articles=this.relevant(symbol,now);if(!articles.length)continue;
      const current=this.currentView(symbol,now);if(current&&!current.reason&&now-current.at<86400000||current?.reason&&now-current.at<300000)continue;
      const result=await analyzeNews(e.jev,symbol,articles,now);if(e.stopped)return;
      if(result.requested)calls++;
      this.views[symbol]=result;
      if(result.reason&&!result.requested){this.state.modelReason=result.reason;break;}
      this.state.modelReason=result.reason??null;
    }
    this.views=Object.fromEntries(Object.entries(this.views).filter(([,v])=>now-v.at<48*3600000));
  }
  buildWatchlist() {
    const e=this.engine, now=e.clock(), schedule=e.schedule.state(now), target=schedule.today&&now<schedule.today.close&&this.state.sourceSession!==schedule.today.date?schedule.today:schedule.next;
    if(!target)return;
    const symbols=[...new Set([...this.state.patterns.map(r=>r.symbol),...Object.keys(this.views)])];
    this.state.watchlist=symbols.map(symbol=>{
      const p=this.state.patterns.find(r=>r.symbol===symbol&&[schedule.today?.date,schedule.last?.date].includes(r.session)), news=this.currentView(symbol,now), negative=adverseNews(news,now);
      const favorable=favorableNews(news,now), score=(p?.pattern?.score??p?.score??0)+(favorable?70:0)-(negative?200:0);
      return {symbol,plan:negative?'avoid':favorable&&p?.pattern?.matched?'price_and_news':favorable?'news_watch':p?.pattern?.matched?'price_watch':'research_only',score,pattern:p?.pattern??null,news,sourceSession:p?.session??this.state.sourceSession,targetSession:target.date,expiresAt:target.close,
        articles:this.relevant(symbol).map(a=>({id:a.id,headline:a.headline,url:a.url,source:a.source,publishedAt:a.publishedAt})),
        reason:negative?'Adverse news or an explicit event hazard':favorable&&p?.pattern?.matched?'Material favorable news and sustained closing strength':favorable?'Favorable news; fresh price confirmation required':p?.pattern?.matched?'Closing strength; news confirmation unavailable':'Insufficient combined evidence'};
    }).sort((a,b)=>b.score-a.score||a.symbol.localeCompare(b.symbol));
    this.state.watchlist=[...this.state.watchlist.filter(r=>r.plan!=='avoid').slice(0,30),...this.state.watchlist.filter(r=>r.plan==='avoid').slice(0,10)];
  }
  verifiedCandidate(c,now) {
    const e=this.engine,news=this.currentView(c.symbol,now),s=e.schedule.state(now);
    const pattern=closingPattern(e.features.history.get(c.symbol)??[],s.today,now);
    return this.state.newsComplete&&now>=this.state.newsAt&&now-this.state.newsAt<30*60000&&this.state.sourceSession===s.date&&favorableNews(news,now)&&pattern?.matched&&pattern.at===c.features?.patternAt&&news.digest===c.features?.newsDigest&&c.holdingPolicy.exitBy===e.schedule.holdingDeadline(c.ts,e.cfg.overnight.sessions);
  }
  async onBar(b) {
    const e=this.engine,now=e.clock(),schedule=e.schedule?.state(now);
    if(!e.strategyControls.enabled(CARRY_STRATEGY)||!schedule?.carryWindow||!e.cfg.overnight.enabled||!this.state.patterns.some(r=>r.symbol===b.symbol))return;
    const news=this.currentView(b.symbol,now),pattern=closingPattern(e.features.history.get(b.symbol)??[],schedule.today,now);
    if(!pattern?.matched||!favorableNews(news,now))return;
    const q=e.quotes.get(b.symbol);if(!q)return;
    const distance=Math.max(pattern.atr*1.5,q.ask*.01);if(distance>q.ask*.03)return;
    const exitBy=e.schedule.holdingDeadline(now,e.cfg.overnight.sessions);if(!positive(exitBy))return;
    const c={id:idFor('c',[CARRY_STRATEGY,b.symbol,schedule.date,pattern.at,news.digest]),symbol:b.symbol,strategy:CARRY_STRATEGY,ts:now,expires:now+5000,reference:q.ask,stop:q.ask-distance,target:q.ask+2*distance,maxHold:exitBy-now,
      features:{version:pattern.at,patternAt:pattern.at,newsDigest:news.digest,regime:'trend'},holdingPolicy:{type:'carry',version:'close-news-carry-1',exitBy,sessions:e.cfg.overnight.sessions,news,pattern,sourceSession:schedule.date},status:'discovered'};
    await e.submitCandidate(c);
  }
  enforceAllocation(now) {
    const e=this.engine, allocation=overnightAllocation(e);
    if(!allocation.breached){if(allocation.available)this.state.allocationAlert=null;return;}
    for(const o of e.pending().filter(o=>o.kind==='entry'&&o.holdingPolicy?.type==='carry')){o.entryDisableRequested=true;e.store.order(o);}
    let projected=allocation.held;
    for(const p of allocation.positions.sort((a,b)=>b.value-a.value)) {
      if(projected<=allocation.cap)break;
      const m=e.managed[p.symbol];if(m&&m.entryId===p.entryId)m.exitReason||='carry_allocation_reduction';
      projected-=p.value;
    }
    e.store.set('managed',e.managed);
    this.state.allocationAlert={at:now,exposure:allocation.exposure,cap:allocation.cap,reason:'Exposure above the carry cap. New buys blocked; reductions execute in the next regular session.'};
  }
}
