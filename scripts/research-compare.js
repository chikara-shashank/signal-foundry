import { readFileSync, writeFileSync } from 'node:fs';
import { compareResearch } from '../src/research-comparison.js';

const [tape,calendar,bundle,out,settings]=process.argv.slice(2),json=p=>JSON.parse(readFileSync(p,'utf8'));
if(!tape||!calendar||!bundle||!out)throw new Error('Usage: research-compare.js tape.json calendar.json research.json output.json [settings.json]');
const result=await compareResearch(json(tape),json(calendar),json(bundle),settings?json(settings):{});
writeFileSync(out,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({out,experimentId:result.experimentId,rows:result.rows,qualification:result.qualification},null,2));
