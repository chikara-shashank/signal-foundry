import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { hash } from './util.js';
import { Store } from './store.js';

// The DB commit owns both ledger state and its compressed observation. Export is
// idempotent and outside the trading mutex; a crash cannot drop the observation.
export class OptionsTape {
  constructor(store, directory) { this.store=store;this.directory=directory;this.running=false;this.error=null; }
  async flush() {
    if(this.running)return;this.running=true;
    try {
      for(const row of this.store.optionExports()) {
        if(!/^\d{4}-\d\d-\d\d$/.test(row.date))throw new Error('options_archive_date');
        const dir=join(this.directory,row.date);await mkdir(dir,{recursive:true});
        const file=join(dir,String(row.sequence).padStart(12,'0')+'.json.gz');
        let existing;
        try{existing=await readFile(file);}catch(error){if(error.code!=='ENOENT')throw error;}
        if(existing) {
          const record=Store.decodeOptionRecord(existing),{recordHash,...body}=record;
          if(recordHash!==row.digest||hash(body)!==row.digest)throw new Error('options_archive_integrity');
        } else {
          const handle=await open(file+'.tmp','w');
          try { await handle.writeFile(row.data); await handle.sync(); } finally { await handle.close(); }
          await rename(file+'.tmp',file);
        }
        this.store.markOptionExport(row.sequence);
      }
      this.error=null;
    }catch(error){this.error=/^options_\w+$/.test(error.message)?error.message:'options_archive_write_failed';}
    finally{this.running=false;}
  }
}
