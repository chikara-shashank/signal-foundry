// Completed one-minute bars only. Each instance belongs to one symbol/session.
export class Pullback {
  constructor(open, close, tickSize) {
    if(![open,close,tickSize].every(Number.isFinite)||close<=open||tickSize<=0)throw new Error('Invalid session or tick');
    Object.assign(this,{open,close,tickSize,high:-Infinity,count:0,last:null,impulse:null,pullback:[],armed:false});
  }
  resetPattern(){this.impulse=null;this.pullback=[];this.armed=false;}
  bar(b,now,vwap){
    if(![b.ts,b.open,b.high,b.low,b.close,b.volume,now].every(Number.isFinite)||b.ts+60000>now||b.ts<this.open||b.ts+60000>this.close||b.ts%60000||b.low<=0||b.low>Math.min(b.open,b.close)||b.high<Math.max(b.open,b.close)||b.volume<0)throw new Error('Invalid or unfinished bar');
    if(this.last!==null&&b.ts<=this.last)throw new Error('Duplicate or revised completed bar');
    if(this.last!==null&&b.ts!==this.last+60000){this.resetPattern();this.count=0;}
    const priorHigh=this.high,priorCount=this.count;
    this.last=b.ts;this.high=Math.max(this.high,b.high);this.count++;
    if(priorCount>=5&&b.close>b.open&&b.high>priorHigh&&b.high>b.low){
      this.impulse={...b};this.pullback=[];this.armed=false;return;
    }
    if(!this.impulse)return;
    if(this.pullback.length>=3||b.high>this.impulse.high||b.low<this.impulse.high-(this.impulse.high-this.impulse.low)*.5){this.resetPattern();return;}
    this.pullback.push({...b});
    const meanVolume=this.pullback.reduce((s,x)=>s+x.volume,0)/this.pullback.length;
    this.armed=meanVolume<this.impulse.volume&&Number.isFinite(vwap)&&b.close>vwap;
  }
  trigger(trade,now){
    if(!this.armed||!this.impulse||now<this.open+300000||now>=Math.min(this.open+90*60000,this.close)||trade.ts<this.last+60000||trade.ts>=this.last+120000||now>=this.last+120000)return null;
    if(trade.price<=Math.max(...this.pullback.map(b=>b.high)))return null;
    const stop=Math.floor((Math.min(...this.pullback.map(b=>b.low))-this.tickSize+1e-10)/this.tickSize)*this.tickSize;
    const result={stop,impulseTs:this.impulse.ts,pullbackBars:this.pullback.length,trigger:trade.price};
    this.resetPattern();return result;
  }
}
