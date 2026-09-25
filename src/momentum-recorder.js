import {openSync,writeSync,closeSync} from 'node:fs';
import {parseFeedFrame} from './feeds.js';
import {createHash} from 'node:crypto';

// Raw tape only. Authentication/control frames and credentials are never saved.
export async function recordMomentumStream({key,secret,symbols,path,seconds=60,maxBytes=512*1024*1024,clockOffsetMs,clockUncertaintyMs,Socket=WebSocket,now=()=>Date.now()}){
  if(!key||!secret||!Array.isArray(symbols)||!symbols.length||symbols.some(s=>s!=='*'&&!/^[A-Z][A-Z0-9.]{0,9}$/.test(s))||(symbols.includes('*')&&symbols.length!==1)||!Number.isInteger(seconds)||seconds<1||seconds>43200||!Number.isFinite(clockOffsetMs)||!Number.isFinite(clockUncertaintyMs)||clockUncertaintyMs<0||!Number.isInteger(maxBytes)||maxBytes<1024)throw new Error('Invalid recorder configuration');
  const fd=openSync(path,'wx');let bytes=0,frames=0,lastNow=-Infinity,done=false,authenticated=false,subscribed=false,ws,timer,authTimer,heartbeatTimer,sequence=0;
  const digest=createHash('sha256'),startLocal=now(),startMonotonic=performance.now();
  const stamp=()=>{const t=now()+clockOffsetMs;if(t<lastNow)throw new Error('clock_moved_backward');lastNow=t;return t;};
  const write=row=>{if(!['raw_stream_header','raw_stream_end'].includes(row.kind))row.sequence=++sequence;const line=JSON.stringify(row)+'\n',n=Buffer.byteLength(line);if(bytes+n>maxBytes)throw new Error('recording_size_limit');writeSync(fd,line);bytes+=n;if(row.kind!=='raw_stream_end')digest.update(line);};
  try{write({kind:'raw_stream_header',schemaVersion:2,source:'alpaca_sip_websocket',symbols,startedAtLocal:startLocal,clockOffsetMs,clockUncertaintyMs,quoteSizeUnits:'round_lots',completeUniverseRequested:symbols[0]==='*',normalized:false});}catch(error){closeSync(fd);throw error;}
  return new Promise((resolve,reject)=>{
    const finish=(reason,error=false)=>{
      if(done)return;done=true;clearTimeout(timer);clearTimeout(authTimer);clearInterval(heartbeatTimer);
      try{if(bytes<maxBytes-512)write({kind:'raw_stream_end',now:stamp(),reason,subscribed,frames,sequence,sha256:digest.digest('hex')});}catch{ /* Missing footer prevents certification. */ }
      try{ws?.close();}catch{ /* Always close the local tape even if transport teardown fails. */ }closeSync(fd);
      if(error)reject(new Error(reason));else resolve({path,frames,bytes,subscribed,reason,normalized:false});
    };
    try{ws=new Socket('wss://stream.data.alpaca.markets/v2/sip');}catch{finish('stream_connection_failed',true);return;}
    authTimer=setTimeout(()=>finish('stream_authentication_timeout',true),15000);
    timer=setTimeout(()=>finish(subscribed?'bounded_capture_complete':'stream_not_subscribed',!subscribed),seconds*1000);
    ws.addEventListener('open',()=>ws.send(JSON.stringify({action:'auth',key,secret})));
    ws.addEventListener('message',event=>{
      if(done)return;
      try{
        if(typeof event.data!=='string'||event.data.length>2000000)throw new Error('stream_invalid_frame');
        const rows=parseFeedFrame(event.data);if(!Array.isArray(rows))throw new Error('stream_invalid_frame');
        const receivedAtLocal=now(),receivedAt=stamp();
        for(const row of rows){
          if(row.T==='error'){finish(`stream_provider_error_${Number(row.code)||0}`,true);return;}
          if(row.T==='success'&&row.msg==='authenticated'){
            authenticated=true;ws.send(JSON.stringify({action:'subscribe',trades:symbols,quotes:symbols,statuses:symbols}));
          }else if(row.T==='subscription'){
            subscribed=authenticated&&['trades','quotes','statuses'].every(k=>symbols.every(s=>row[k]?.includes(s)));
            if(!subscribed){finish('stream_incomplete_subscription',true);return;}
            clearTimeout(authTimer);write({kind:'raw_subscription',receivedAtLocal,receivedAt,channels:{trades:row.trades,quotes:row.quotes,statuses:row.statuses}});
            if(heartbeatTimer)throw new Error('stream_invalid_frame');
            heartbeatTimer=setInterval(()=>{
              try{
                const clockDriftMs=(now()-startLocal)-(performance.now()-startMonotonic);
                if(Math.abs(clockDriftMs)>100){finish('stream_clock_drift',true);return;}
                write({kind:'raw_heartbeat',now:stamp(),clockDriftMs});
              }catch(error){finish(error.message==='recording_size_limit'?error.message:'stream_heartbeat_failed',true);}
            },1000);
          }else if(authenticated&&subscribed&&['q','t','s','c','x'].includes(row.T)){
            if(symbols[0]!=='*'&&!symbols.includes(row.S))continue;
            write({kind:'raw_market_event',receivedAtLocal,receivedAt,message:row});frames++;
          }
        }
      }catch(error){finish(['clock_moved_backward','recording_size_limit','stream_invalid_frame'].includes(error.message)?error.message:'stream_recording_failed',true);}
    });
    ws.addEventListener('error',()=>finish('stream_connection_failed',true));
    ws.addEventListener('close',()=>finish('stream_disconnected_coverage_gap',true));
  });
}
