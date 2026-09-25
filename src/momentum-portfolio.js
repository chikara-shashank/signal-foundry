import {robinhoodEquityFee} from './momentum-fees.js';
export class MomentumPortfolio {
  constructor({capital=10000,maxPosition=500,maxGross=3000,risk=10,dailyLoss=30,latencyMs=1000,entryTtlMs=1000,maxHoldMs=300000,depthFraction=.1,extraTicks=0,accountType='cash',reservedExternal=0,fee=robinhoodEquityFee}={}){
    if(![capital,maxPosition,maxGross,risk,dailyLoss,entryTtlMs,maxHoldMs,depthFraction].every(x=>Number.isFinite(x)&&x>0)||![latencyMs,extraTicks,reservedExternal].every(x=>Number.isFinite(x)&&x>=0)||maxPosition>maxGross||maxGross>capital||reservedExternal>capital||depthFraction>1||!['cash','limited_margin'].includes(accountType))throw new Error('Invalid research portfolio limits');
    Object.assign(this,{capital,maxPosition,maxGross,risk,dailyLoss,latencyMs,entryTtlMs,maxHoldMs,depthFraction,extraTicks,accountType,reservedExternal,fee,cash:capital,settling:[],pending:new Map(),positions:new Map(),quotes:new Map(),quoteUsable:new Map(),halted:new Map(),used:new Set(),journal:[],closed:[],date:null,nextDate:null,lossHalt:false,startEquity:capital,days:[]});
  }
  equity(){return this.cash+this.settling.reduce((s,x)=>s+x.amount,0)+[...this.positions.values()].reduce((s,p)=>s+p.qty*(this.quotes.get(p.symbol)?.bid??p.entry),0);}
  exposure(){return this.reservedExternal+[...this.pending.values()].reduce((s,p)=>s+p.qty*p.limit,0)+[...this.positions.values()].reduce((s,p)=>s+p.qty*Math.max(p.entry,this.quotes.get(p.symbol)?.bid??p.entry),0);}
  spendable(){return this.cash-this.reservedExternal-[...this.pending.values()].reduce((s,p)=>s+p.qty*p.limit+p.feeReserve,0);}
  session({date,nextDate},now){
    if(this.date&&date<=this.date)throw new Error('Sessions must advance');
    if(!/^\d{4}-\d\d-\d\d$/.test(date)||!(nextDate>date))throw new Error('Explicit next settlement session required');
    if(this.date)this.days.push({date:this.date,netUsd:this.equity()-this.startEquity,lossHalt:this.lossHalt});
    for(const p of this.pending.values())this.log('cancel',now,{symbol:p.symbol,reason:'session_change'});
    this.pending.clear();
    for(const x of this.settling.filter(x=>x.date<=date))this.cash+=x.amount;
    this.settling=this.settling.filter(x=>x.date>date);
    this.date=date;this.nextDate=nextDate;this.used.clear();this.halted.clear();this.quoteUsable.clear();this.lossHalt=false;this.startEquity=this.equity();
  }
  log(kind,now,fields){this.journal.push({kind,now,...fields});}
  tick(now){
    for(const [symbol,p] of this.pending)if(now>p.expires){this.pending.delete(symbol);this.log('cancel',now,{symbol,reason:'entry_expired'});}
    for(const p of this.positions.values())if(!p.exitAt&&now>=p.at+this.maxHoldMs){p.exitAt=p.at+this.maxHoldMs+this.latencyMs;p.reason='time';}
    if(this.equity()-this.startEquity<=-this.dailyLoss){
      this.lossHalt=true;
      for(const symbol of this.pending.keys())this.log('cancel',now,{symbol,reason:'daily_loss'});
      this.pending.clear();
    }
  }
  reserve(intent,now){
    this.tick(now);const {symbol,limit,stop,tickSize}=intent;
    let reason=null;
    if(!this.date||!Number.isFinite(limit)||limit<1||!Number.isFinite(stop)||!(limit>stop&&stop>0)||!Number.isFinite(tickSize)||tickSize<=0)reason='invalid_intent';
    else if(this.lossHalt)reason='daily_loss';
    else if(this.used.has(symbol)||this.pending.has(symbol)||this.positions.has(symbol))reason='symbol_already_attempted';
    else if(this.halted.get(symbol)!==false)reason='unknown_or_halted';
    const feeReserve=.02; // Two cents covers CAT at this version's <=500 USD, >=1 USD entry.
    const qty=reason?0:Math.floor(Math.min(this.maxPosition/limit,this.risk/(limit-stop),(this.maxGross-this.exposure())/limit,(this.spendable()-feeReserve)/limit));
    if(!reason&&qty<1)reason='capital_or_risk';
    if(reason){this.log('reject',now,{symbol,reason});return false;}
    this.pending.set(symbol,{...intent,qty,feeReserve,at:now+this.latencyMs,expires:now+this.latencyMs+this.entryTtlMs});
    this.used.add(symbol);this.log('intent',now,{...intent,qty});return true;
  }
  halt(symbol,active,now){
    this.halted.set(symbol,active);
    if(active!==false&&this.pending.delete(symbol))this.log('cancel',now,{symbol,reason:'halt_or_unknown'});
  }
  quote(q,now,canExecute=true){
    this.quoteUsable.set(q.symbol,false);
    if(q.eligible!==true||!Number.isFinite(q.ts)||q.ts>now||now-q.ts>250||![q.bid,q.ask,q.bidSize,q.askSize].every(Number.isFinite)||q.bid<=0||q.ask<=q.bid||q.bidSize<=0||q.askSize<=0)return;
    if(q.ts<(this.quotes.get(q.symbol)?.ts??-Infinity))return;
    if(q.timestampNs!==undefined){
      const ns=BigInt(q.timestampNs),prior=this.quotes.get(q.symbol);
      if(ns/1000000n!==BigInt(Math.trunc(q.ts)))throw new Error('Inconsistent quote timestamp precision');
      if(prior?.timestampNs!==undefined&&ns<BigInt(prior.timestampNs))return;
    }
    this.quotes.set(q.symbol,{...q,receivedAt:now});this.quoteUsable.set(q.symbol,true);this.tick(now);
    if(!canExecute||this.halted.get(q.symbol)!==false)return;
    const order=this.pending.get(q.symbol);
    if(order&&now>=order.at&&now<=order.expires){
      const price=q.ask+this.extraTicks*order.tickSize;
      if(price<=order.limit&&price>order.stop){
        const otherExposure=this.exposure()-order.qty*order.limit;
        const availableCash=this.spendable()+order.qty*order.limit+order.feeReserve;
        const qty=Math.min(order.qty,Math.floor(q.askSize*this.depthFraction),Math.floor((this.maxGross-otherExposure)/price),Math.floor((availableCash-order.feeReserve)/price));
        if(qty>0){
          const fee=this.fee({side:'buy',qty,price,date:this.date}).total;
          if(price*qty+fee>this.cash-this.reservedExternal+1e-8)throw new Error('Cash invariant');
          this.cash-=price*qty+fee;this.pending.delete(q.symbol);
          this.positions.set(q.symbol,{symbol:q.symbol,qty,initialQty:qty,entry:price,entryFee:fee,at:now,stop:order.stop,target:price+2*(price-order.stop),tickSize:order.tickSize,exitAt:null,depthUsed:{},proceeds:0,exitFees:0});
          this.log('entry',now,{symbol:q.symbol,qty,price,fee,canceledQty:order.qty-qty});
        }
      }
    }
    const p=this.positions.get(q.symbol);
    if(!p)return;
    if(!p.exitAt&&(q.bid<=p.stop||q.bid>=p.target)){p.exitAt=now+this.latencyMs;p.reason=q.bid<=p.stop?'stop':'target';}
    // A fill cannot trigger and execute its own exit on the same receipt.
    if(p.exitAt&&now>=p.exitAt&&now>p.at){
      const key=String(q.bid),capacity=Math.max(0,Math.floor(q.bidSize*this.depthFraction)-(p.depthUsed[key]??0));
      const qty=Math.min(p.qty,capacity);
      if(!qty)return;
      const price=Math.max(.000001,q.bid-this.extraTicks*p.tickSize);
      // Unknown final partial-order notional cannot safely earn a SEC waiver.
      const orderNotional=qty===p.initialQty?qty*price:Math.max(500.01,p.initialQty*price);
      const fee=this.fee({side:'sell',qty,price,date:this.date,orderTotalShares:p.initialQty,orderTotalNotional:orderNotional}).total;
      p.depthUsed[key]=(p.depthUsed[key]??0)+qty;p.qty-=qty;p.proceeds+=qty*price;p.exitFees+=fee;
      if(this.accountType==='cash')this.settling.push({date:this.nextDate,amount:qty*price-fee});else this.cash+=qty*price-fee;
      this.log('exit',now,{symbol:q.symbol,qty,price,fee,reason:p.reason,remaining:p.qty});
      if(p.qty===0){this.closed.push({symbol:p.symbol,entryAt:p.at,exitAt:now,qty:p.initialQty,entry:p.entry,netUsd:p.proceeds-p.initialQty*p.entry-p.entryFee-p.exitFees,reason:p.reason});this.positions.delete(q.symbol);}
    }
    this.tick(now);
  }
  report(){
    const open=[...this.positions.values()].map(p=>({...p,mark:this.quotes.get(p.symbol)?.bid??null,markReceivedAt:this.quotes.get(p.symbol)?.receivedAt??null}));
    return {capital:this.capital,cash:this.cash,unsettled:this.settling,markedEquity:this.equity(),markedNetUsd:this.equity()-this.capital,closedTrades:this.closed,openPositions:open,pendingOrders:[...this.pending.values()],days:[...this.days,...(this.date?[{date:this.date,netUsd:this.equity()-this.startEquity,lossHalt:this.lossHalt}]:[])],completeLiquidation:!open.length&&!this.pending.size,journal:this.journal};
  }
}
