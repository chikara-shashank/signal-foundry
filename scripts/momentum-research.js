import {createReadStream,readFileSync,writeFileSync,openSync,writeSync,closeSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import {MomentumResearch} from '../src/momentum-research.js';
import {momentumCodeHash} from '../src/momentum-validation.js';
import { FEE_SCHEDULE, FEE_SCHEDULE_HASH } from '../src/momentum-fees.js';

const [command,input,output,...rest]=process.argv.slice(2);
if(command!=='replay'||!input||!output){console.error('Usage: npm run research:momentum -- replay events.jsonl report.json [--stress]');process.exit(1);}
if(rest.some(x=>x!=='--stress'))throw new Error('Unknown option');
const auditPath=output+'.audit.jsonl',auditFd=openSync(auditPath,'wx');
const stress=rest.includes('--stress'),engine=new MomentumResearch({...(stress?{latencyMs:3500,extraTicks:1}:{}),audit:row=>writeSync(auditFd,JSON.stringify(row)+'\n')});
const hash=createHash('sha256');let lineNumber=0;
for await(const line of createInterface({input:createReadStream(input),crlfDelay:Infinity})){
  lineNumber++;hash.update(line+'\n');if(!line.trim())continue;
  try{engine.on(JSON.parse(line));}catch(error){throw new Error(`Tape line ${lineNumber}: ${error.message}`);}
}
if(!engine.eventCount)throw new Error('Empty tape');
const result=engine.report();result.replay={inputSha256:hash.digest('hex'),codeSha256:momentumCodeHash(),designSha256:createHash('sha256').update(readFileSync(new URL('../docs/momentum-experiment-v0.json',import.meta.url))).digest('hex'),scenario:stress?'stress_3500ms_one_tick':'primary_1000ms',generatedAt:new Date().toISOString()};
result.replay.feeScheduleHash=FEE_SCHEDULE_HASH;result.replay.feeVersion=FEE_SCHEDULE.version;result.replay.feeConvention=FEE_SCHEDULE.futureConvention;
closeSync(auditFd);result.replay.auditPath=auditPath;
writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output,source:result.source,events:result.eventCount,signals:result.signals.length,closedTrades:result.portfolio.closedTrades.length,unresolved:result.portfolio.openPositions.length,markedNetUsd:result.portfolio.markedNetUsd,validationEligible:result.validationEligible}));
