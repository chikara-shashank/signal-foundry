import {readFileSync,writeFileSync} from 'node:fs';
import {freezeExperiment,assessExperiment} from '../src/momentum-validation.js';
const [command,a,b,c,d]=process.argv.slice(2),json=p=>JSON.parse(readFileSync(p,'utf8'));
if(command==='freeze'&&a&&b){const result=freezeExperiment(json(a));writeFileSync(b,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({output:b,status:result.status,sha256:result.sha256}));}
else if(command==='assess'&&a&&b&&c&&d){const result=assessExperiment(json(a),json(b),json(c));writeFileSync(d,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result,null,2));}
else {console.error('Usage: momentum-validation.js freeze registration-input.json output.json | assess primary.json stress.json registration.json output.json');process.exitCode=1;}
