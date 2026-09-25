import { createServer } from 'node:net';
import { hash } from './util.js';

// A process-lifetime lock independent of DATA_DIR. Containers must also use a
// single shared network namespace/one writer deployment for each account.
export async function accountWriterLock(accountId, mode) {
  if(!accountId)throw new Error('Account identity required for writer lock');
  const port=30000+parseInt(hash([accountId,mode]).slice(0,8),16)%20000;
  const server=createServer(socket=>socket.destroy());
  await new Promise((resolve,reject)=>{
    server.once('error',()=>reject(new Error('Another engine owns this account writer lock or its local port is unavailable')));
    server.listen({host:'127.0.0.1',port,exclusive:true},resolve);
  });
  return { close:()=>new Promise(resolve=>server.close(resolve)) };
}
