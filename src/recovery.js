import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from './store.js';
import { hash } from './util.js';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export function inspectBackup(path) {
  const db=new DatabaseSync(path,{readOnly:true});
  try {
    if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('backup_sqlite_integrity');
    const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='options_outbox'").get();
    let previous=null,frames=0;
    if(exists)for(const row of db.prepare('SELECT * FROM options_outbox ORDER BY sequence').iterate()){
      const record=Store.decodeOptionRecord(row.data),{recordHash,...body}=record;
      if(recordHash!==row.digest||hash(body)!==row.digest||record.sequence!==row.sequence||row.sequence!==(previous?.sequence??0)+1||record.previousRecordHash!==(previous?.digest??null))throw new Error('backup_options_integrity');
      previous=row;frames++;
    }
    const get=k=>{const row=db.prepare('SELECT value FROM kv WHERE key=?').get(k);return row?JSON.parse(row.value):null;};
    const head=get('optionsTapeHead');
    if((head?.sequence??0)!==frames||(head?.digest??null)!==(previous?.digest??null))throw new Error('backup_options_head_mismatch');
    return {integrity:'ok',orders:db.prepare('SELECT COUNT(*) n FROM orders').get().n,optionsFrames:frames,dailyLossOverride:get('dailyLossOverride'),hasOptionsState:!!get('optionsLab')};
  } finally {db.close();}
}
export async function createBackup(store,path,{release,exportDir}={}) {
  await mkdir(dirname(path),{recursive:true});await store.backup(path);
  const integrity=inspectBackup(path),bytes=await readFile(path);
  const manifest={schema:1,createdAt:new Date().toISOString(),file:basename(path),sha256:digest(bytes),bytes:bytes.length,release:release??null,...integrity};
  await writeFile(path+'.manifest.json',JSON.stringify(manifest,null,2)+'\n');
  if(exportDir){await mkdir(exportDir,{recursive:true});await copyFile(path,join(exportDir,basename(path)));await copyFile(path+'.manifest.json',join(exportDir,basename(path)+'.manifest.json'));}
  return manifest;
}
export async function verifyBackup(path) {
  const manifest=JSON.parse(await readFile(path+'.manifest.json','utf8'));
  if(digest(await readFile(path))!==manifest.sha256)throw new Error('backup_digest_mismatch');
  return {...manifest,...inspectBackup(path)};
}
