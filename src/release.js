import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { hash } from './util.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const walk=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(x=>x.isDirectory()?walk(join(dir,x.name)):[join(dir,x.name)]);
const files=[...walk(join(root,'src')),...walk(join(root,'public')),join(root,'package.json')].sort();
const sourceSha256=hash(files.map(file=>[relative(root,file).replaceAll('\\','/'),readFileSync(file,'utf8').replaceAll('\r\n','\n')]));
let build=null;try{build=JSON.parse(readFileSync(join(root,'release.json'),'utf8'));}catch{}
export const RELEASE={version:JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version,sourceSha256,build:build?.sourceSha256===sourceSha256?build:null,manifestVerified:build?.sourceSha256===sourceSha256};
