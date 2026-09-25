import {readFileSync,writeFileSync} from 'node:fs';
import {comparePyramiding} from '../src/pyramiding-replay.js';
const [tape,calendar,out,settings,execution]=process.argv.slice(2),json=p=>JSON.parse(readFileSync(p,'utf8'));
if(!tape||!calendar||!out)throw new Error('Usage: pyramiding-replay.js normalized-tape.json calendar.json output.json [settings.json] [execution.json]');
const report=await comparePyramiding(json(tape),json(calendar),settings?json(settings):{},execution?json(execution):{});
writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({out,complete:report.complete,incrementalNet:report.incrementalNet,evidence:report.evidence,liveEligible:false}));
