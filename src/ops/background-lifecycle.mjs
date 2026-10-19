import {backgroundTask} from './background-control.mjs';
export function createBackgroundLifecycle(closeAdmission){
 const workers=new Set();let closing=null;
 const notify=(callback,value)=>{try{Promise.resolve(callback?.(value)).catch(()=>{});}catch{}};
 const settle=(method,onProgress)=>Promise.allSettled([...workers].map((worker,workerIndex)=>Promise.resolve().then(async()=>{
  if(typeof worker[method]!=='function')return;
  const update={stage:'worker_'+method,workerIndex};
  notify(onProgress,{...update,event:'start'});
  try{await worker[method]();notify(onProgress,{...update,event:'done'});}
  catch(error){notify(onProgress,{...update,event:'failed'});throw error;}
 })));
 return {track(worker){if(worker)workers.add(worker);return worker;},
    async drain(){const results=await settle('drain');const failed=results.filter(row=>row.status==='rejected');if(failed.length)throw new AggregateError(failed.map(row=>row.reason),'background_drain_failed');},shutdown(flush,onProgress){
  if(closing)return closing;
  closeAdmission();
  closing=(async()=>{
   const results=await settle('stop',onProgress);
   const drains=await settle('drain',onProgress);
   // Flush even if a producer failed; report all failures to the service manager.
   const failures=[...results,...drains].filter(x=>x.status==='rejected').map(x=>x.reason);
   await flush({drained:failures.length===0});
   if(failures.length)throw new AggregateError(failures,'background drain failed');
  })();return closing;
 }};
}

export function registerBackgroundInterval(lifecycle,callback,ms,pauseable=true){
 let closed=false,active=null;
 const timer=setInterval(()=>{
  if(closed||active)return;
  active=Promise.resolve().then(pauseable?backgroundTask(callback):callback).catch(error=>console.warn('[agentmemory] Periodic work deferred:',error?.code??error?.name??'error')).finally(()=>{active=null;});
 },ms);timer.unref();
 lifecycle.track({drain:async()=>{if(active)await active;},stop:async()=>{closed=true;clearInterval(timer);if(active)await active;}});
 return timer;
}

// The CLI verifies the worker's own PID receipt instead of treating SIGKILL as a flush.
import {mkdir,open,rename,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
export async function writeShutdownReceipt(value,directory=join(homedir(),'.agentmemory')){
 await mkdir(directory,{recursive:true,mode:0o700});
 const path=join(directory,'shutdown-receipt.json'),temp=path+'.'+process.pid+'.tmp';
 const file=await open(temp,'w',0o600);try{await file.writeFile(JSON.stringify(value)+'\n');await file.sync();}finally{await file.close();}
 await rename(temp,path);const dir=await open(directory,'r');try{await dir.sync();}finally{await dir.close();}
}
export async function readShutdownReceipt(directory=join(homedir(),'.agentmemory')){try{return JSON.parse(await readFile(join(directory,'shutdown-receipt.json'),'utf8'));}catch{return null;}}
