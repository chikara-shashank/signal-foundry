import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, quote } from './helpers.js';
import { BrokerBudget } from '../src/broker-budget.js';
import { tradeScorecard } from '../src/research.js';

const close = async f => { clearTimeout(f.engine.streamReconcile); await f.engine.mutex.tail; f.store.close(); };
test('simultaneous crypto stops latch by entry, survive a rebound and are persisted before coordinator work', async () => {
  const f = await fixture({ CRYPTO_SYMBOLS:'BTC/USD,ETH/USD' });
  try {
    let release; const gate = new Promise(r=>release=r); f.engine.mutex.run(()=>gate); f.engine.scheduleReconcile=()=>{};
    for(const symbol of f.cfg.crypto) f.engine.managed[symbol]={entryId:symbol,stop:98,target:104};
    for(const symbol of f.cfg.crypto) f.engine.onQuote(quote(symbol,f.now(),97));
    assert.equal(Object.keys(f.store.get('exitTriggers')).length,2);
    f.advance(1); f.engine.onQuote(quote('ETH/USD',f.now(),100)); release(); await f.engine.mutex.tail;
    for(const symbol of f.cfg.crypto) assert.equal(f.engine.managed[symbol].exitReason,'stop');
    assert.deepEqual(f.store.get('exitTriggers'),{});
  } finally { await close(f); }
});
test('external short remains external without disabling unrelated shared-account entries',async()=>{
  const f=await fixture({ACCOUNT_POLICY:'shared'});
  try { f.broker.state.positions.XYZ={symbol:'XYZ',qty:-1,entryPrice:100}; await f.engine.reconcile(); assert.equal(f.engine.ready,true); assert.ok(f.engine.externalSymbols.has('XYZ')); }
  finally {await close(f);}
});
test('external QQQ reservation releases noise allocation and explains unavailability',async()=>{
  const f=await fixture({ACCOUNT_POLICY:'shared',MAX_GROSS_USD:'3000',MAX_GROUP_USD:'3000',NOISE_AREA_NOTIONAL_USD:'1600'});
  try {
    f.engine.strategyControls.state.strategies.noise_area.enabled=true;
    f.broker.state.positions.QQQ260925P00735000={symbol:'QQQ260925P00735000',qty:1,entryPrice:1}; await f.engine.reconcile();
    assert.deepEqual(f.engine.noiseReservation(),{eligible:false,reason:'external_symbol_reserved',notional:0});
    assert.match(f.engine.strategyControls.unavailable('noise_area'),/external/);
    f.engine.portfolio.positions=[{symbol:'AAPL',qty:1,marketValue:1360.83}];
    assert.equal(f.engine.checkEntry(f.prepare()).ok,true);
  }finally{await close(f);}
});
test('six and twenty stable positions leave entry headroom; protection reads and exit writes work at the normal ceiling',async()=>{
  for(const count of [6,20]) {
    const symbols=Array.from({length:count},(_,i)=>'S'+String.fromCharCode(65+i));
    const f=await fixture({ACCOUNT_POLICY:'shared',EQUITY_SYMBOLS:symbols.join(',')});
    try {
      for(const symbol of symbols) {
        const o={id:symbol,brokerId:symbol,symbol,kind:'entry',strategy:'range_breakout',qty:1,filledQty:1,fillPrice:100,status:'filled',ts:f.now(),legs:[],settledAt:f.now()};
        f.store.order(o);f.broker.state.orders[symbol]=o;f.broker.state.positions[symbol]={symbol,qty:1,entryPrice:100};
        f.engine.managed[symbol]={entryId:symbol,strategy:o.strategy,stop:95,target:105,maxHold:3600000,openedAt:f.now()};
      }
      f.broker.state.cash=10000-count*100;
      let wall=Date.now();const b=new BrokerBudget(()=>wall);
      for(const [method,index] of [['clock',1],['openOrders',0],['find',2],['positions',0],['account',1]]) {
        const original=f.broker[method].bind(f.broker);f.broker[method]=async(...args)=>{b.reserve('GET',args[index]);return original(...args);};
      }
      f.broker.budgetStatus=()=>b.status();f.broker.entryBudgetAvailable=()=>b.status().entryAvailable;
      for(let i=0;i<12;i++){await f.engine.reconcile();wall+=5000;f.advance(5000);}
      assert.ok(b.status().used<120,`${count}: ${b.status().used}`);assert.equal(f.engine.ready,true);
      // Only one parent needs urgent refresh; stable others remain cached.
      for(const symbol of symbols)f.engine.orderRefreshAt.set(symbol,f.now());
      b.requests=Array(160).fill(wall); f.engine.managed[symbols[0]].exitReason='operator_flatten';
      const submit=f.broker.submit.bind(f.broker);f.broker.submit=async o=>{b.reserve('POST','protection');return submit(o);};
      await f.engine.reconcile();assert.equal(f.store.orders().filter(o=>o.kind==='exit').length,1);assert.equal(f.engine.protection.state,'reconciled');
    }finally{await close(f);}
  }
});
test('OCO overfill remains an explicit persistent incident with unavailable strategy P/L',async()=>{
  const f=await fixture({ACCOUNT_POLICY:'shared'});
  try{
    const o={id:'double',brokerId:'double',symbol:'SPY',kind:'entry',strategy:'range_breakout',qty:1,filledQty:1,fillPrice:100,status:'filled',ts:f.now(),settledAt:f.now(),legs:[{brokerId:'target',status:'filled',filledQty:1,fillPrice:104,type:'limit'},{brokerId:'stop',status:'filled',filledQty:1,fillPrice:98,type:'stop'}]};
    f.store.order(o);f.broker.state.orders.double=o;f.broker.state.positions.SPY={symbol:'SPY',qty:-1,entryPrice:98};f.broker.state.cash=10102;
    f.engine.managed.SPY={entryId:'double',strategy:o.strategy,stop:98,target:104,maxHold:3600000,openedAt:f.now()};
    await f.engine.reconcile();const incidents=Object.values(f.store.get('executionIncidents'));assert.equal(incidents.length,1);assert.equal(incidents[0].brokerSignedQty,-1);
    assert.equal(f.engine.strategyControls.snapshot().strategies.find(x=>x.id===o.strategy).realizedNetPnl,null);
    assert.equal(tradeScorecard(f.store.orders(),f.cfg).pnlAvailable,false);assert.ok(f.engine.issues.includes('execution_incident'));
    await f.engine.control('flatten');await f.engine.reconcile();assert.equal(f.store.orders().filter(x=>x.kind==='exit').length,0);
  }finally{await close(f);}
});
