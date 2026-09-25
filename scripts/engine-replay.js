import {readFileSync,writeFileSync} from 'node:fs';
import {replayEngine} from '../src/engine-replay.js';
const [tape,calendar,out,settings]=process.argv.slice(2),json=p=>JSON.parse(readFileSync(p,'utf8'));
if(!tape||!calendar||!out)throw new Error('Usage: engine-replay.js normalized-tape.json calendar.json output.json [settings.json]');
const report=await replayEngine(json(tape),json(calendar),settings?json(settings):{});
writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({out,orders:report.orderCount,closed:report.closedTradeCount,liveEligible:false}));
