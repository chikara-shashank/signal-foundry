import { nyDate } from './util.js';

export function normalizeActivity(x) {
  if(typeof x.id!=='string'||typeof x.activity_type!=='string')throw new Error('activity_invalid');
  const at=x.transaction_time??x.date;
  if(!Number.isFinite(Date.parse(at)))throw new Error('activity_invalid_date');
  const number=k=>x[k]==null?null:Number(x[k]);
  const row={id:x.id,type:x.activity_type,at,orderId:x.order_id??null,symbol:x.symbol??null,qty:number('qty'),price:number('price'),side:x.side??null,netAmount:number('net_amount')};
  if([row.qty,row.price,row.netAmount].some(v=>v!==null&&!Number.isFinite(v)))throw new Error('activity_invalid_amount');
  return row;
}
export class Accounting {
  constructor(engine){this.engine=engine;this.running=false;this.lastPoll=0;this.error=null;}
  async poll(){
    const e=this.engine;
    if(this.running||!e.broker.activities||Date.now()-this.lastPoll<60000)return;
    this.running=true;this.lastPoll=Date.now();
    try{
      for(let page=0;page<5;page++){
        const cursor=e.store.get('activityCursor'),first=e.store.orders().find(o=>o.filledQty>0)?.ts??e.clock();
        const rows=(await e.broker.activities(cursor,new Date(first-86400000).toISOString())).map(normalizeActivity);
        await e.mutex.run(()=>{
          if(e.stopped)return;e.store.assertLease();
          e.store.transaction(()=>{for(const row of rows)e.store.activity(row);if(rows.length)e.store.set('activityCursor',rows.at(-1).id);e.store.set('activitySync',{at:e.clock(),coverageStart:e.store.get('activitySync')?.coverageStart??first-86400000,backlog:rows.length===100});});
          this.reconcileFees();
        });
        if(rows.length<100)break;
      }
      this.error=null;
    }catch{this.error='broker_activity_sync_unavailable';}
    finally{this.running=false;}
  }
  reconcileFees(){
    const e=this.engine, rows=e.store.activities(), fees=new Map();
    for(const row of rows)if(['FEE','CFEE','PTC','PTR'].includes(row.type)&&row.orderId&&row.netAmount!==null)fees.set(row.orderId,(fees.get(row.orderId)??0)-row.netAmount);
    for(const order of e.store.orders()){
      let changed=false;
      for(const fill of [order,...(order.legs??[])])if(fees.has(fill.brokerId)&&fees.get(fill.brokerId)>=0){fill.fee=fees.get(fill.brokerId);fill.feeSource='broker_activity_provisional';changed=true;}
      if(changed)e.store.order(order);
    }
    let routeFeesChanged=false;
    for(const order of e.paperRoutes?.accountingOrders()??[])for(const fill of [order,...(order.legs??[])])if(fees.has(fill.brokerId)&&fees.get(fill.brokerId)>=0){fill.fee=fees.get(fill.brokerId);fill.feeSource='broker_activity_provisional';routeFeesChanged=true;}
    if(routeFeesChanged)e.paperRoutes.save();
  }
  snapshot(){
    const e=this.engine, rows=e.store.activities(), orders=[...e.store.orders(),...(e.paperRoutes?.accountingOrders()??[])], byBroker=new Map();
    for(const o of orders)for(const x of [o,...(o.legs??[])])if(x.brokerId)byBroker.set(x.brokerId,o);
    const own=rows.filter(r=>r.orderId&&byBroker.has(r.orderId)), unattributed=rows.filter(r=>r.type!=='FILL'&&(!r.orderId||!byBroker.has(r.orderId)));
    const mismatches=[];
    for(const o of orders)for(const fill of [o,...(o.legs??[])]){
      const events=own.filter(r=>r.type==='FILL'&&r.orderId===fill.brokerId);
      if(events.length&&Math.abs(events.reduce((s,x)=>s+Math.abs(x.qty??0),0)-(fill.filledQty??0))>1e-7)mismatches.push({orderId:fill.brokerId,reason:'activity_fill_quantity_mismatch'});
    }
    const modelCost=e.store.db.prepare('SELECT COALESCE(SUM(COALESCE(actual,reserved)),0) value FROM spending').get().value;
    const days=e.store.get('operatingCostDays',[]), fixedCost=e.cfg.operatingCostPerDay==null?null:days.length*e.cfg.operatingCostPerDay;
    const unresolved=Object.values(e.store.get('executionIncidents',{})).some(x=>!x.resolvedAt);
    const base=e.portfolio.state.totalPnl, knownEconomicNet=base==null||unresolved||mismatches.length?null:base-modelCost-(fixedCost??0);
    return {sync:e.store.get('activitySync'),error:this.error,activities:rows.length,ownedActivities:own.length,unattributedActivities:unattributed.length,
      mismatches,lifecycleEvents:unattributed.filter(r=>['OPASN','OPEXP','OPXRC','SSP','REORG','SC','MA'].includes(r.type)).slice(-30),
      modelCost,fixedOperatingCost:fixedCost,operatingCostPerDay:e.cfg.operatingCostPerDay??null,knownEconomicNet,
      complete:false,note:'Known economic P/L subtracts recorded/reserved model charges and configured operating costs. Broker fees remain provisional; unlinked fees and corporate actions require ownership review. This is not a certified broker statement reconciliation.'};
  }
  observeDay(now){const e=this.engine,days=e.store.get('operatingCostDays',[]),day=nyDate(now);if(!days.includes(day)){days.push(day);e.store.set('operatingCostDays',days);}}
}
