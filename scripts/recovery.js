import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { createBackup, verifyBackup, inspectBackup } from '../src/recovery.js';
import { freshOptionsState, optionsRecord, advanceOptions } from '../src/options-lab.js';
import { OptionsTape } from '../src/options-tape.js';
const [command,path,out]=process.argv.slice(2);
try {
  if(command==='verify'&&path)console.log(JSON.stringify(await verifyBackup(resolve(path)),null,2));
  else if(command==='drill'&&path){
    const dir=resolve(path);await mkdir(dir,{recursive:false});
    const source=new Store(join(dir,'source.sqlite'));source.lease(Date.now());source.set('dailyLossOverride',2000);
    try{
      const before=freshOptionsState(),frame={schema:1,source:'alpaca_opra',stockFeed:'sip',now:Date.parse('2026-09-25T14:00:00Z'),clockUncertaintyMs:0,marketOpen:false,session:null,quotes:{},contracts:{},spots:{},contexts:{}};
      const next=structuredClone(before);advanceOptions(next,frame,false);source.saveOptionsFrame(optionsRecord(before,frame,false,true),next);
      await createBackup(source,join(dir,'backup.sqlite'));
    }finally{source.release();source.close();}
    await verifyBackup(join(dir,'backup.sqlite'));await copyFile(join(dir,'backup.sqlite'),join(dir,'restored.sqlite'));
    const restored=new Store(join(dir,'restored.sqlite'));
    try{
      // Only this newly created drill copy has its copied lease removed.
      restored.set('lease',null);restored.lease(Date.now());const tape=new OptionsTape(restored,join(dir,'restored-tape'));await tape.flush();
      if(tape.error||restored.optionArchiveStatus().pending||restored.get('dailyLossOverride')!==2000)throw new Error('restore_drill_failed');
      console.log(JSON.stringify({status:'passed',...inspectBackup(join(dir,'restored.sqlite')),out:dir},null,2));
    }finally{restored.release();restored.close();}
  }else if(command==='export-options'&&path&&out){
    const dbPath=resolve(path);inspectBackup(dbPath);const db=new DatabaseSync(dbPath,{readOnly:true});
    try{await mkdir(resolve(out),{recursive:true});let count=0;for(const row of db.prepare('SELECT * FROM options_outbox ORDER BY sequence').iterate()){const dir=join(resolve(out),row.date);await mkdir(dir,{recursive:true});await writeFile(join(dir,String(row.sequence).padStart(12,'0')+'.json.gz'),row.data,{flag:'wx'});count++;}console.log(JSON.stringify({exported:count}));}finally{db.close();}
  }else if(command==='new-options-experiment'&&path){
    const store=new Store(resolve(path));try{store.lease(Date.now());const old=store.get('optionsLab');if(old?.positions?.length||old?.pending?.length)throw new Error('options_open_exposure_requires_review');
      store.transaction(()=>{const history=store.get('optionsLabHistory',[]);if(old)history.push({archivedAt:Date.now(),state:old});store.set('optionsLabHistory',history);store.set('optionsLab',freshOptionsState());store.event('options_experiment_archived',{priorCodeHash:old?.codeHash??null});});console.log(JSON.stringify({status:'new_experiment_disabled',archived:true}));
    }finally{store.release();store.close();}
  }else throw new Error('Usage: recovery.js verify backup.sqlite | drill new-directory | export-options backup.sqlite directory | new-options-experiment stopped-engine.sqlite');
}catch(error){console.error(error.message);process.exitCode=1;}
