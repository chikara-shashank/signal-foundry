import test from 'node:test';
import assert from 'node:assert/strict';
import { MarketSchedule } from '../src/market-schedule.js';
import { CryptoUniverse, rankCrypto } from '../src/crypto-universe.js';
import { AlpacaFeed } from '../src/feeds.js';
import { AlpacaBroker, normalizeOrder } from '../src/broker.js';
import { canonical, nyTimestamp } from '../src/util.js';
import { fixture, testConfig, quote } from './helpers.js';
import { EquityUniverse } from '../src/equity-universe.js';
import { StockHistory } from '../src/stock-history.js';
import { OptionsLab } from '../src/options-lab.js';
import { OptionsData } from '../src/options-data.js';

const session=(date,close='16:00')=>({date,open:nyTimestamp(date,'09:30'),close:nyTimestamp(date,close)});
const dispose=async f=>{f.engine.stopped=true;clearTimeout(f.engine.streamReconcile);await f.engine.mutex.tail;f.store.close();};
function calendar(e,rows) { const s=new MarketSchedule(e,{});s.cache={rows,fetchedAt:e.clock(),through:rows.at(-1).date};e.schedule=s;return s; }
const ranks=now=>Array.from({length:26},(_,i)=>({id:i===0?'btc-bitcoin':i===1?'eth-ethereum':`unknown-${i}`,symbol:i===0?'BTC':i===1?'ETH':`U${i}`,name:'Coin '+i,rank:i+1,last_updated:new Date(now).toISOString(),quotes:{USD:{market_cap:1e9-i*1e6}}}));
const cryptoAsset={tradable:true,assetClass:'crypto',status:'active',min_order_size:.0001,min_trade_increment:.00000001,price_increment:.01};

test('exchange schedule handles DST, warmup, entry cutoff, holidays, early closes and weekends',async()=>{
  const f=await fixture();try{
    const s=calendar(f.engine,[session('2026-09-25'),session('2026-09-28'),session('2026-09-29'),session('2026-09-30')]);
    const at=(date,time)=>{const now=nyTimestamp(date,time);s.cache.fetchedAt=now;return s.state(now);};
    assert.equal(at('2026-09-25','08:59').equityTracking,false);
    assert.equal(at('2026-09-25','09:00').phase,'premarket_warmup');assert.equal(at('2026-09-25','09:00').regular,false);
    assert.equal(at('2026-09-25','09:30').regular,true);assert.equal(at('2026-09-25','15:29').carryWindow,false);
    assert.equal(at('2026-09-25','15:30').carryWindow,true);assert.equal(at('2026-09-25','15:55').carryWindow,false);
    assert.equal(at('2026-09-25','16:00').equityTracking,false);assert.equal(at('2026-09-25','16:02').next.date,'2026-09-28');
    assert.equal(at('2026-09-26','10:00').equityTracking,false);
    at('2026-09-25','15:35');assert.equal(s.holdingDeadline(nyTimestamp('2026-09-25','15:35'),3),nyTimestamp('2026-09-30','15:55'));
    s.cache.rows=[session('2026-11-27','13:00'),session('2026-11-30')];s.cache.through='2026-11-30';
    assert.equal(at('2026-11-26','10:00').phase,'non_trading_day');assert.equal(at('2026-11-27','13:00').equityTracking,false);assert.equal(at('2026-11-27','15:30').carryWindow,false);
    assert.equal(new Date(nyTimestamp('2026-09-25','09:00')).getUTCHours(),13);assert.equal(new Date(nyTimestamp('2026-11-27','09:00')).getUTCHours(),14);
    s.cache.fetchedAt-=86400001;assert.equal(s.state(nyTimestamp('2026-11-27','15:30')).calendarFresh,false);
  }finally{await dispose(f);}
});
test('calendar refresh failure never invents a weekday session',async()=>{
  const f=await fixture();try{const s=new MarketSchedule(f.engine,{calendar:async()=>{throw Error('offline');}});await s.poll();assert.equal(s.state().equityTracking,false);assert.equal(s.holdingDeadline(f.now()),null);assert.match(s.state().error,/unavailable/);}finally{await dispose(f);}
});
test('top-25 eligibility is a verified identity intersection, never 25 available substitutes',()=>{
  const now=Date.now(), rows=ranks(now),assets=new Map([['BTC/USD',cryptoAsset],['U25/USD',cryptoAsset]]);
  const result=rankCrypto(rows,assets,now);assert.equal(result.length,25);assert.deepEqual(result.filter(r=>r.eligible).map(r=>r.symbol),['BTC/USD']);
  assert.ok(!result.some(r=>r.rank===26));rows[0].id='impostor';assert.equal(rankCrypto(rows,assets,now)[0].eligible,false);
  rows[0].id='btc-bitcoin';rows[2].symbol='BTC';assert.equal(rankCrypto(rows,assets,now)[0].eligible,false);
  assert.throws(()=>rankCrypto(rows.slice(1),assets,now),/incomplete/);rows[0].last_updated=new Date(now-3600001).toISOString();assert.throws(()=>rankCrypto(rows,assets,now),/stale/);
});
test('ranking refresh and restart retain held out-of-rank crypto solely for protection',async()=>{
  const f=await fixture({CRYPTO_SYMBOLS:'BTC/USD,ETH/USD'});try{
    const assets=new Map([['BTC/USD',cryptoAsset],['ETH/USD',cryptoAsset],['LTC/USD',cryptoAsset]]);
    f.engine.managed['LTC/USD']={entryId:'owned'};
    const u=new CryptoUniverse(f.engine,{assets:async()=>assets},async()=>({ok:true,text:async()=>JSON.stringify(ranks(f.now()))}));f.engine.cryptoUniverse=u;
    let selection;u.feed={setSymbols:async s=>{selection=s;}};await u.poll(true);
    assert.deepEqual(selection,['LTC/USD','BTC/USD','ETH/USD']);assert.equal(u.allowed('LTC/USD'),false);assert.equal(u.allowed('BTC/USD'),true);
    assert.equal(f.engine.realtime.trades.symbols.has('LTC/USD'),true);f.advance(6*3600000);assert.equal(u.allowed('BTC/USD'),false);
    u.restore();assert.deepEqual(f.cfg.crypto,['LTC/USD']);assert.equal(u.state.subscriptionReady,false);
  }finally{await dispose(f);}
});
test('crypto subscription failure blocks buys until acknowledgment and never removes old protection',async()=>{
  const f=await fixture({CRYPTO_SYMBOLS:'ETH/USD'});try{
    const u=new CryptoUniverse(f.engine,{assets:async()=>new Map([['BTC/USD',cryptoAsset]])},async()=>({ok:true,text:async()=>JSON.stringify(ranks(f.now()))}));
    u.feed={setSymbols:async()=>{throw Error('disconnected');}};await u.poll(true);
    assert.equal(u.allowed('BTC/USD'),false);assert.ok(f.cfg.crypto.includes('ETH/USD'));assert.ok(u.status().error);
  }finally{await dispose(f);}
});
test('closed equity calendar and stale stock scanner do not block an eligible crypto signal',async()=>{
  const f=await fixture({CRYPTO_SYMBOLS:'BTC/USD'});try{
    f.engine.schedule={state:()=>({regular:false,equityTracking:false})};f.engine.universe={entryReady:()=>false,status:()=>({mode:'all'})};f.engine.cryptoUniverse={allowed:()=>true,status:()=>({})};
    const c=f.prepare('BTC/USD');assert.equal(f.engine.checkEntry(c).ok,true);
    assert.equal(f.engine.entryAvailability().crypto.ready,true);assert.equal(f.engine.status().entryReady,true);
    assert.equal(f.engine.checkEntry(f.prepare()).reason,'equity_tracking_window_closed');
    const old=f.engine.quotes.get('SPY');f.engine.onQuote(quote('SPY',f.now(),110));assert.equal(f.engine.quotes.get('SPY'),old);
    f.cfg.cryptoUniverse='off';assert.equal(f.engine.checkEntry(c).reason,'crypto_entries_disabled');
  }finally{await dispose(f);}
});
test('fast stock discovery, history warmup and options capture make no calls outside tracking window',async()=>{
  const f=await fixture();try{
    f.engine.schedule={state:()=>({equityTracking:false})};const fail=async()=>assert.fail('off-hours fast request');
    await new StockHistory(f.engine,fail).warmup();await new EquityUniverse(f.engine,fail,fail).poll(true);
    const lab=new OptionsLab(f.engine,{capture:fail});await lab.poll();
    let sockets=0, waits=0;
    const feed=new AlpacaFeed('equities','', ['SPY'],f.cfg,f.engine,class {constructor(){sockets++;}},async()=>{if(++waits===2)feed.stop();});
    feed.setStreaming(false);await feed.setSymbols(['SPY','QQQ']);await feed.run();assert.equal(sockets,0);assert.equal(f.engine.feeds.equities.status,'scheduled_off');
  }finally{await dispose(f);}
});
test('all crypto broker symbols normalize by asset class without changing an equity ending USD',async()=>{
  assert.equal(canonical('XRPUSD','crypto'),'XRP/USD');assert.equal(canonical('XRPUSD','us_equity'),'XRPUSD');
  assert.equal(normalizeOrder({symbol:'DOGEUSD',asset_class:'crypto',status:'new'}).symbol,'DOGE/USD');
  const cfg=testConfig(),broker=new AlpacaBroker(cfg,async()=>({ok:true,status:200,json:async()=>[{symbol:'SOLUSD',asset_class:'crypto',qty:'2',market_value:'100'}]}));
  assert.equal((await broker.positions())[0].symbol,'SOL/USD');
});
test('provider configuration forbids static crypto seeds and a ten-percent carry cap',()=>{
  const base={MODE:'paper',ALPACA_KEY:'test',ALPACA_SECRET:'test'};
  assert.equal(testConfig(base).cryptoUniverse,'top25');assert.throws(()=>testConfig({...base,CRYPTO_UNIVERSE:'static'}),/top25/);
  assert.throws(()=>testConfig({...base,OVERNIGHT_ALLOCATION_FRACTION:'.1'}),/Invalid/);
  assert.throws(()=>testConfig({CRYPTO_UNIVERSE:'top25'}),/synthetic/);
});
test('a paginated fast history read stops at the close; explicit closing research can continue',async()=>{
  const f=await fixture();try{
    let active=true,calls=0;f.engine.schedule={state:()=>({equityTracking:active})};
    const h=new StockHistory(f.engine,async()=>{calls++;active=false;return {ok:true,json:async()=>({bars:{},next_page_token:calls===1?'next':null})};});
    await assert.rejects(h.bars(['SPY'],f.now()-3600000,f.now()),/scheduled_off/);assert.equal(calls,1);
    await h.bars(['SPY'],f.now()-3600000,f.now(),'1Min',{research:true});assert.equal(calls,2);
    const adapter=new OptionsData({key:'test',secret:'test',canRead:()=>false,fetchFn:async()=>assert.fail('late options request')});
    await assert.rejects(adapter.capture(),/scheduled_off/);
  }finally{await dispose(f);}
});
test('late authentication cannot subscribe an equity stream after the tracking window ends',async()=>{
  const f=await fixture();try{
    let active=true,ws;const sent=[];
    class Socket {constructor(){ws=this;this.events={};}addEventListener(k,fn){this.events[k]=fn;}send(x){sent.push(JSON.parse(x));}close(){this.events.close?.({code:1000});}}
    f.engine.schedule={state:()=>({equityTracking:active})};
    const feed=new AlpacaFeed('equities','', ['SPY'],f.cfg,f.engine,Socket),connected=feed.connect();ws.events.open();assert.equal(sent[0].action,'auth');
    active=false;ws.events.message({data:JSON.stringify([{T:'success',msg:'authenticated'}])});await connected;
    assert.equal(sent.length,1);assert.equal(feed.scheduled,false);feed.stop();
  }finally{await dispose(f);}
});
test('stock submission rechecks the window after the intent was reserved',async()=>{
  const f=await fixture();try{
    f.engine.schedule={state:()=>({regular:false})};f.broker.submit=async()=>assert.fail('stock order sent after close');
    const o={id:'late-entry',symbol:'SPY',kind:'entry',status:'reserved',ts:f.now(),qty:1};f.store.order(o);await f.engine.submit(o);
    assert.equal(f.store.getOrder(o.id).status,'aborted');assert.equal(f.store.getOrder(o.id).reason,'equity_submission_window_closed');
  }finally{await dispose(f);}
});
