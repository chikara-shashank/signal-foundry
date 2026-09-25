import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { RELEASE } from '../src/release.js';
let commit=process.env.VCS_REF||null,dirty=process.env.SOURCE_DIRTY==null?null:process.env.SOURCE_DIRTY==='true';
try { commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();dirty=!!execFileSync('git',['status','--porcelain'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(); } catch {}
const release={version:RELEASE.version,sourceSha256:RELEASE.sourceSha256,createdAt:new Date().toISOString(),commit,dirty};
writeFileSync(new URL('../release.json',import.meta.url),JSON.stringify(release,null,2)+'\n');console.log(JSON.stringify(release,null,2));
