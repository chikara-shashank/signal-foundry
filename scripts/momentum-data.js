import {MomentumData} from '../src/momentum-data.js';
import {recordMomentumStream} from '../src/momentum-recorder.js';
import {normalizeMomentumTape} from '../src/momentum-normalize.js';
const [command,path,symbolList,seconds='15']=process.argv.slice(2);
if(!path||!['discover','sample','stream','prepare','normalize'].includes(command)){console.error('Usage: npm run research:momentum:data -- discover directory | sample output.jsonl APUS,GLND 15 | stream output.jsonl APUS,GLND 60 | prepare directory APUS,GLND YYYY-MM-DD | normalize raw.jsonl context.json normalized.jsonl');process.exit(1);}
try{
  const data=command==='normalize'?null:new MomentumData({key:process.env.ALPACA_KEY,secret:process.env.ALPACA_SECRET});
  let result;
  if(command==='normalize')result=await normalizeMomentumTape(path,symbolList,seconds);
  else if(command==='prepare')result=await data.prepare(path,seconds,(symbolList??'').split(',').filter(Boolean));
  else if(command==='discover')result=await data.discover(path);
  else if(command==='sample')result=await data.sample((symbolList??'').split(',').filter(Boolean),Number(seconds),path);
  else {
    const clock=await data.clock();
    result=await recordMomentumStream({key:process.env.ALPACA_KEY,secret:process.env.ALPACA_SECRET,symbols:(symbolList??'').split(',').filter(Boolean),path,seconds:Number(seconds),clockOffsetMs:clock.offsetMs,clockUncertaintyMs:clock.uncertaintyMs});
  }
  const {rows,...summary}=result;console.log(JSON.stringify(summary,null,2));
}catch(error){console.error(/^(market_data_http_\d+|stream_[a-z_0-9]+|clock_moved_backward|recording_size_limit)$/.test(error.message)?error.message:'Data capture failed; check credentials, entitlement, output path and connection. Existing captures are not overwritten.');process.exitCode=1;}
