import { config } from './config.js';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { SimBroker } from './broker.js';
import { evaluate } from './strategies.js';
import { NoiseArea } from './noise-area.js';
import { hash, nyDate, isCrypto, terminal, floorStep } from './util.js';
import { RELEASE } from './release.js';
import { buildReport } from '../scripts/research.js';

export class ReplayBroker extends SimBroker {
  constructor(cfg,store,calendar,now,{latencyMs=1000,participation=.1}={}) {
    super(cfg,store);this.calendarRows=calendar.sessions;this.now=now;this.latencyMs=latencyMs;this.participation=participation;
    if(!Number.isFinite(latencyMs)||latencyMs<0||latencyMs>30000||!(participation>0&&participation<=.1))throw new Error('Invalid replay execution assumptions');
  }
  async clock(now){const s=this.calendarRows.find(x=>x.date===nyDate(now));return {open:!!s&&now>=s.open&&now<s.close,close:s?.close??now,ts:now};}
  async calendar(from,to){return this.calendarRows.filter(s=>s.date>=from&&s.date<=to);}
  onQuote(q) {
    this.quotes.set(q.symbol,q);
    let buyCapacity=Number.isFinite(q.askSize)?q.askSize*this.participation:0,sellCapacity=Number.isFinite(q.bidSize)?q.bidSize*this.participation:0;
    for(const o of Object.values(this.state.orders)) {
      if(o.symbol!==q.symbol||terminal(o.status))continue;
      const entry=o.kind==='entry',now=this.now();
      if(entry&&now>=(o.entryDeadline??o.ts+this.cfg.entryTtl)){o.status='expired';continue;}
      if(now<o.ts+this.latencyMs||q.ts<o.ts+this.latencyMs)continue;
      const price=(entry?q.ask:q.bid)*(1+(entry?1:-1)*this.cfg.slippage/10000);
      if(entry&&price>o.limit)continue;
      const feeRate=(isCrypto(o.symbol)?this.cfg.cryptoFee:this.cfg.equityFee)/10000;
      const capacity=entry?Math.min(buyCapacity,this.state.cash/(price*(1+feeRate))):Math.min(sellCapacity,this.state.positions[o.symbol]?.qty??0);
      const qty=floorStep(Math.min(o.qty-o.filledQty,capacity),isCrypto(o.symbol)?1e-8:1);if(!(qty>0))continue;
      const fee=qty*price*feeRate,old=o.filledQty;this.state.cash+=(entry?-1:1)*qty*price-fee;
      if(entry){const p=this.state.positions[o.symbol];this.state.positions[o.symbol]={symbol:o.symbol,qty:(p?.qty??0)+qty,entryPrice:((p?.qty??0)*(p?.entryPrice??0)+qty*price)/((p?.qty??0)+qty)};buyCapacity-=qty;}
      else{this.state.positions[o.symbol].qty-=qty;if(this.state.positions[o.symbol].qty<1e-9)delete this.state.positions[o.symbol];sellCapacity-=qty;}
      o.filledQty+=qty;o.fillPrice=(o.fillPrice*old+price*qty)/o.filledQty;o.fee=(o.fee??0)+fee;o.filledAt=q.ts;o.status=o.filledQty>=o.qty-1e-8?'filled':'partially_filled';
    }
    this.save();
  }
}

export async function replayEngine(tape,calendar,settings={},execution={}) {
  const events=tape.events;
  if(tape.schema!==1||tape.quoteSizeUnits!=='shares'||!Array.isArray(events)||!events.length||!['recorded','synthetic'].includes(tape.source))throw new Error('Require a normalized receipt-ordered tape with explicit share sizes and source');
  if(!Array.isArray(calendar.sessions)||!calendar.coverageFrom||!calendar.coverageTo||!Number.isFinite(calendar.observedAt)||calendar.observedAt>events[0].now)throw new Error('Require a calendar available before replay and an explicit coverage range');
  if(calendar.sessions.some((s,i)=>!Number.isFinite(s.open)||!Number.isFinite(s.close)||s.open>=s.close||nyDate(s.open)!==s.date||(i&&s.date<=calendar.sessions[i-1].date)))throw new Error('Invalid calendar sessions');
  if(events.some((e,i)=>!Number.isFinite(e.now)||(i&&e.now<events[i-1].now)||nyDate(e.now)<calendar.coverageFrom||nyDate(e.now)>calendar.coverageTo||!['quote','bar','heartbeat'].includes(e.kind)))throw new Error('Invalid, unordered or uncovered replay events');
  const symbols=[...new Set(events.filter(e=>e.symbol).map(e=>e.symbol))];
  if(symbols.some(isCrypto))throw new Error('Equity parity replay requires a separate provider-5m crypto context tape');
  const cfg=config({...settings,MODE:'shadow',JEV_MODE:'off',ALPACA_KEY:'offline',ALPACA_SECRET:'offline',DASHBOARD_TOKEN:'offline-replay-00000000000000000000000000',EQUITY_SYMBOLS:symbols.join(','),CRYPTO_SYMBOLS:''});
  let now=events[0].now;const store=new Store(),broker=new ReplayBroker(cfg,store,calendar,()=>now,execution);
  const workers={status:()=>cfg.strategies.map(strategy=>({strategy,alive:true})),evaluate:async(f,t,selected)=>selected.map(s=>evaluate(s,f,t)).filter(Boolean)};
  const engine=new Engine(cfg,store,broker,workers,()=>now);engine.scheduleReconcile=()=>{};
  const seen=[];
  if(cfg.strategies.includes('noise_area'))engine.noiseArea=new NoiseArea(engine,broker,{bars:async(symbols,from,to,timeframe='1Min')=>new Map(symbols.map(symbol=>{
    const rows=seen.filter(b=>b.symbol===symbol&&b.ts>=from&&b.ts<to&&b.ts+60000<=now);
    if(timeframe==='1Min')return [symbol,rows];
    const groups=new Map();for(const b of rows){const t=Math.floor(b.ts/1800000)*1800000;const a=groups.get(t)??[];a.push(b);groups.set(t,a);}
    return [symbol,[...groups].filter(([t,a])=>a.length===30&&a[0].ts===t&&a.at(-1).ts===t+29*60000).map(([ts,a])=>({symbol,ts,open:a[0].open,high:Math.max(...a.map(b=>b.high)),low:Math.min(...a.map(b=>b.low)),close:a.at(-1).close,volume:a.reduce((s,b)=>s+b.volume,0)}))];
  }))});
  try{
    await engine.init();
    for(const event of events){
      now=event.now;await engine.reconcile();
      if(event.kind==='quote'){if(event.ts>now)throw new Error('Future quote in replay');await engine.onQuote(event);await engine.mutex.tail;}
      else if(event.kind==='bar'){if(event.ts+60000>now)throw new Error('Unfinished bar in replay');seen.push(event);await engine.onBar(event,event.warmup===true);}
      await engine.noiseArea?.tick(now);await engine.reconcile();
    }
    const report=buildReport(store,cfg);
    return {...report,replay:{source:tape.source,events:events.length,inputSha256:hash(tape),calendarSha256:hash(calendar),sourceSha256:RELEASE.sourceSha256,execution:{latencyMs:broker.latencyMs,participation:broker.participation},sharedPortfolio:true,calendarAware:true,liveEligible:false,
      limitations:['Uses production signal, risk, ownership and exit coordination, with a simulated broker.', 'Displayed share size is a fill cap, not queue priority; repeated snapshots may overstate replenishment. Native bracket races and market impact require paper execution calibration.', 'Jev is off. Crypto provider context and options execution are excluded. Open exposure and unfilled orders remain unresolved at tape end.']},orders:store.orders(),finalState:engine.status()};
  }finally{engine.stopped=true;clearTimeout(engine.streamReconcile);await engine.mutex.tail;store.close();}
}
