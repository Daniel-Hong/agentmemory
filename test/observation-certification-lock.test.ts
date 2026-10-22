import {afterEach,expect,it,vi} from 'vitest';
import {mockKV,mockSdk} from './helpers/mocks.js';
import {KV} from '../src/state/schema.js';
import {observationBudgetEntry} from '../src/functions/observation-source-budget.js';
import {VectorIndex} from '../src/state/vector-index.js';
import * as search from '../src/functions/search.js';
import {registerObserveFunction} from '../src/functions/observe.js';
import {withKeyedLock} from '../src/state/keyed-mutex.js';
import {finishLongSession} from '../src/ops/long-session.mjs';
import {registerEmbeddingRecovery,EMBEDDING_RETRY_NAMESPACE as RETRY} from '../src/ops/embedding-recovery.mjs';
vi.mock('../src/logger.js',()=>({logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}}));
const workers:ReturnType<typeof registerEmbeddingRecovery>[]=[];
afterEach(async()=>{for(const w of workers.splice(0)){w.stop();await w.drain();}search.setEmbeddingRecovery(null);search.setVectorIndex(null);search.setEmbeddingProvider(null);});
function fixture(){
 const kv=mockKV(),index=new VectorIndex(),provider={name:'synthetic',dimensions:2,embed:vi.fn(async()=>new Float32Array([1,0]))};
 let release!:()=>void,entered=false;const gate=new Promise<void>(resolve=>release=resolve);
 let mutation=0;for(const method of ['set','delete','update'] as const){const original=kv[method];(kv as any)[method]=async(scope:string,...args:any[])=>{if(scope.startsWith('mem:obs:'))mutation++;return(original as any)(scope,...args);};}
 Object.assign(kv,{observationReader:{mutationRevision:()=>mutation,pendingMutations:()=>0,captureSummary:async(scope:string,excludeId:string)=>{const rows:any[]=await kv.list(scope);const entries=rows.filter(r=>r.id!==excludeId).map(observationBudgetEntry);return{count:rows.length,summaryCount:entries.length,summaryBytes:entries.reduce((n,r)=>n+r.summaryBytes,0),sourceBytes:entries.reduce((n,r)=>n+r.sourceBytes,0)};}},backend:'file',durability:{waitForKeys:async()=>{entered=true;await gate;return{synced:true};}}});
 const recovery=registerEmbeddingRecovery({kv:kv as never,KV,index,provider,withKeyedLock,schedule:false,persistIndex:async()=>{}});workers.push(recovery);
 search.setVectorIndex(index);search.setEmbeddingProvider(provider);search.setEmbeddingRecovery(recovery);
 const sdk=mockSdk({looseTrigger:true});registerObserveFunction(sdk as never,kv as never);
 const payload={sessionId:'synthetic-lock',project:'synthetic',cwd:'/tmp/synthetic',hookType:'post_tool_use',timestamp:'2026-10-22T00:00:00Z',observationId:'obs_lock_durable',eventId:'synthetic-event',data:{tool_name:'synthetic',tool_output:'preserved'}};
 return{kv,recovery,provider,payload,send:()=>sdk.trigger('mem::observe',payload),release,entered:()=>entered};
}
for(const duplicate of [false,true])it(`releases the session lock before ${duplicate?'duplicate restoration':'new capture'} certification while withholding success`,async()=>{
 const f=fixture();await f.kv.set(KV.sessions,f.payload.sessionId,{id:f.payload.sessionId,project:'synthetic',status:'active',observationCount:duplicate?1:0});
 if(duplicate)await f.kv.set(KV.observations(f.payload.sessionId),f.payload.observationId,{id:f.payload.observationId,sessionId:f.payload.sessionId,title:'canonical',narrative:'source',facts:[],concepts:[],files:[],sourceRaw:{raw:'preserved'}});
 let acknowledged=false,ended=false;const pending=f.send().then(value=>{acknowledged=true;return value;});
 await vi.waitFor(()=>expect(f.entered()).toBe(true));
 const end=finishLongSession(f.kv as never,KV,withKeyedLock,f.payload.sessionId,true).then(value=>{ended=value;});
 try{
  await new Promise(resolve=>setTimeout(resolve,20));
  expect(await f.kv.get(RETRY,f.payload.observationId)).toMatchObject({id:f.payload.observationId});
  expect(acknowledged).toBe(false);expect(ended).toBe(true);
  expect(await f.kv.get(KV.sessions,f.payload.sessionId)).toMatchObject({status:'completed',observationCount:1});
 }finally{f.release();await pending;await end;}
 expect(acknowledged).toBe(true);expect(f.provider.embed).not.toHaveBeenCalled();expect(await f.kv.list(KV.observations(f.payload.sessionId))).toHaveLength(1);
});

it('does not certify or overwrite an intent replaced in the unlocked gap',async()=>{
 const f=fixture(),item={id:f.payload.observationId,sessionId:f.payload.sessionId,kind:'synthetic' as const};
 await f.kv.set(KV.observations(item.sessionId),item.id,{id:item.id,sessionId:item.sessionId,title:'source'});
 const certify=await f.recovery.prepareEnqueue(item);
 const replacement={...await f.kv.get(RETRY,item.id),generation:'new-owner',attempts:7};await f.kv.set(RETRY,item.id,replacement);
 await expect(certify()).rejects.toMatchObject({code:'EMBEDDING_INTENT_CHANGED'});
 expect(await f.kv.get(RETRY,item.id)).toEqual(replacement);expect(f.entered()).toBe(false);f.release();
});
it('rejects replacement during certification without publishing success or restoring the old generation',async()=>{
 const f=fixture(),item={id:f.payload.observationId,sessionId:f.payload.sessionId,kind:'synthetic' as const};
 await f.kv.set(KV.observations(item.sessionId),item.id,{id:item.id,sessionId:item.sessionId,title:'source'});
 const certify=await f.recovery.prepareEnqueue(item),pending=certify();await vi.waitFor(()=>expect(f.entered()).toBe(true));
 const replacement={...await f.kv.get(RETRY,item.id),generation:'foreign',attempts:9};await f.kv.set(RETRY,item.id,replacement);f.release();
 await expect(pending).rejects.toMatchObject({code:'EMBEDDING_INTENT_CHANGED'});expect(await f.kv.get(RETRY,item.id)).toEqual(replacement);
});
it('reuses one certification promise and refuses an unstarted certificate after stop',async()=>{
 const f=fixture(),item={id:f.payload.observationId,sessionId:f.payload.sessionId,kind:'synthetic' as const};
 await f.kv.set(KV.observations(item.sessionId),item.id,{id:item.id,sessionId:item.sessionId,title:'source'});
 const certify=await f.recovery.prepareEnqueue(item);const first=certify();expect(certify()).toBe(first);f.release();await first;
 const second=await f.recovery.prepareEnqueue(item);f.recovery.stop();await expect(second()).rejects.toMatchObject({code:'EMBEDDING_RECOVERY_STOPPED'});expect(await f.kv.get(RETRY,item.id)).not.toBeNull();
});
it('retains capture inbox and original source when certification fails, then retries idempotently',async()=>{
 const f=fixture();const{registerCaptureFunctions}=await import('../src/functions/capture.js');const sdk=mockSdk({looseTrigger:true});registerObserveFunction(sdk as never,f.kv as never);const capture=registerCaptureFunctions(sdk as never,f.kv as never);
 let fail=true;(f.kv as any).durability.waitForKeys=async()=>{if(fail)throw Error('synthetic certificate failure');return{synced:true};};
 try{
  const input={payload:f.payload,eventId:f.payload.eventId};const failed:any=await sdk.trigger('mem::capture',input);expect(failed.state).toBe('retrying');expect(await f.kv.list(KV.captureInbox)).toHaveLength(1);
  const rows:any[]=await f.kv.list(KV.observations(f.payload.sessionId));expect(rows).toHaveLength(1);expect(rows[0].sourceRaw.toolOutput).toBe('preserved');
  fail=false;const replay=await sdk.trigger('mem::observe',{...f.payload,observationId:failed.observationId});expect(replay).toMatchObject({existing:true,observationId:failed.observationId});
  expect(await f.kv.list(KV.observations(f.payload.sessionId))).toHaveLength(1);expect(f.provider.embed).not.toHaveBeenCalled();
 }finally{capture.stop();await capture.drain();f.release();}
});
it('allows a concurrent canonical rewrite while awaiting certification and restores from canonical rows after restart',async()=>{
 const f=fixture();let ack=false;const pending=f.send().then(v=>{ack=true;return v;});void pending.catch(()=>{});await vi.waitFor(()=>expect(f.entered()).toBe(true));
 const rewrite=withKeyedLock(`obs:${f.payload.sessionId}`,async()=>{const row:any=await f.kv.get(KV.observations(f.payload.sessionId),f.payload.observationId);await f.kv.set(KV.observations(f.payload.sessionId),row.id,{...row,title:'updated canonical'});});
 try{await Promise.race([rewrite,new Promise((_,reject)=>setTimeout(()=>reject(Error('rewrite blocked by certification')),100))]);expect(ack).toBe(false);}finally{f.release();await expect(pending).rejects.toMatchObject({code:'EMBEDDING_SOURCE_CHANGED'});await rewrite;}
 await f.send();
 f.recovery.stop();await f.recovery.drain();const restarted=registerEmbeddingRecovery({kv:f.kv as never,KV,index:search.getVectorIndex()!,provider:f.provider,withKeyedLock,schedule:false,persistIndex:async()=>{}});workers.push(restarted);
 await restarted.pump();await restarted.drain();expect(await f.kv.get(RETRY,f.payload.observationId)).toBeNull();expect(f.provider.embed.mock.calls[0]?.[0]).toContain('updated canonical');
});
it('does not let a concurrent duplicate recapture the session lock while the first certificate is pending',async()=>{
 const f=fixture();const first=f.send();await vi.waitFor(()=>expect(f.entered()).toBe(true));const second=f.send();
 let ended=false;const end=finishLongSession(f.kv as never,KV,withKeyedLock,f.payload.sessionId,true).then(v=>{ended=v;});
 try{await new Promise(r=>setTimeout(r,20));expect(ended).toBe(true);}finally{f.release();await Promise.all([first,second,end]);}
 expect(await f.kv.list(KV.observations(f.payload.sessionId))).toHaveLength(1);
});
it('does not acknowledge a canonical observation deleted while certification is pending',async()=>{
 const f=fixture();const pending=f.send();await vi.waitFor(()=>expect(f.entered()).toBe(true));
 await f.kv.delete(KV.observations(f.payload.sessionId),f.payload.observationId);f.release();
 await expect(pending).rejects.toMatchObject({code:'EMBEDDING_SOURCE_CHANGED'});expect(await f.kv.get(RETRY,f.payload.observationId)).not.toBeNull();
});
it('does not accept delete/recreate of an originally generation-less intent in the gap',async()=>{
 const f=fixture(),item={id:f.payload.observationId,sessionId:f.payload.sessionId,kind:'synthetic' as const};
 await f.kv.set(KV.observations(item.sessionId),item.id,{id:item.id,sessionId:item.sessionId,title:'source'});
 await f.kv.set(RETRY,item.id,{...item,attempts:0});const certify=await f.recovery.prepareEnqueue(item);
 await f.kv.delete(RETRY,item.id);await f.kv.set(RETRY,item.id,{...item,attempts:0});f.release();
 await expect(certify()).rejects.toMatchObject({code:'EMBEDDING_INTENT_CHANGED'});
});

for(const mismatch of [false,true])it(`uses the real readback/fsync fence and ${mismatch?'refuses mismatched disk data':'does not confuse pruning with source mutation'}`,async()=>{
 const{mkdtemp,writeFile,rename,rm}=await import('node:fs/promises');const{tmpdir}=await import('node:os');const{join}=await import('node:path');
 const{createStateDurabilityFence}=await import('../src/ops/state-durability.mjs');const{createObservationReader}=await import('../src/ops/observation-pages.mjs');
 const dir=await mkdtemp(join(tmpdir(),'am-lock-file-')),f=fixture();
 const durability=createStateDurabilityFence({storePath:dir,timeoutMs:120,pollIntervalMs:5});const reader=createObservationReader({storePath:dir,kv:f.kv as never});
 Object.assign(f.kv,{observationReader:reader,durability});
 const writes=new Map<string,Promise<void>>();
 for(const name of ['set','update','delete']as const){const original=f.kv[name];(f.kv as any)[name]=async(scope:string,key:string,...args:any[])=>{
  const value=await durability.mutate(scope,key,()=>original(scope,key,...JSON.parse(JSON.stringify(args))));const row=await f.kv.get(scope,key);reader.record(scope,key,row,name==='delete');
  const chain=(writes.get(scope)??Promise.resolve()).then(async()=>{const path=join(dir,encodeURIComponent(scope)+'.bin');await writeFile(path+'.tmp',JSON.stringify(Object.fromEntries(f.kv.store.get(scope)??[])));await rename(path+'.tmp',path);});writes.set(scope,chain);await chain;return value;
 };}
 const originalFence=durability.waitForKeys;let sawFence=false;durability.waitForKeys=async(...args:any[])=>{
  sawFence=true;
  if(mismatch){const path=join(dir,encodeURIComponent(KV.observations(f.payload.sessionId))+'.bin');await writeFile(path+'.tmp',JSON.stringify({[f.payload.observationId]:{id:f.payload.observationId,sessionId:f.payload.sessionId,title:'wrong disk'}}));await rename(path+'.tmp',path);}
  return originalFence(...args);
 };
 try{
  if(mismatch)await expect(f.send()).rejects.toMatchObject({code:'STATE_DURABILITY_TIMEOUT'});
  else{expect(await f.send()).toMatchObject({observationId:f.payload.observationId});expect(durability.snapshot().lastVerification).toMatchObject({status:'verified'});}
  expect(sawFence).toBe(true);const row:any=await f.kv.get(KV.observations(f.payload.sessionId),f.payload.observationId);expect(row.sourceRaw.toolOutput).toBe('preserved');expect(await f.kv.get(RETRY,f.payload.observationId)).not.toBeNull();
 }finally{f.release();await f.recovery.drain();await rm(dir,{recursive:true,force:true});}
});
it('retains original and intent when a caller stops waiting and can replay after its certificate finishes',async()=>{
 const f=fixture();const pending=f.send();await vi.waitFor(()=>expect(f.entered()).toBe(true));
 const abort=new AbortController();const abandoned=new Promise((_,reject)=>abort.signal.addEventListener('abort',()=>reject(new DOMException('caller stopped','AbortError'))));abort.abort();await expect(Promise.race([pending,abandoned])).rejects.toMatchObject({name:'AbortError'});
 expect(await finishLongSession(f.kv as never,KV,withKeyedLock,f.payload.sessionId,true)).toBe(true);expect(await f.kv.get(RETRY,f.payload.observationId)).not.toBeNull();
 f.release();await pending;expect(await f.send()).toMatchObject({existing:true});expect(await f.kv.list(KV.observations(f.payload.sessionId))).toHaveLength(1);
});
for(const duplicate of [false,true])it(`measures the bounded ${duplicate?'duplicate':'new capture'} session-lock comparison`,async()=>{
 const f=fixture();if(duplicate)await f.kv.set(KV.observations(f.payload.sessionId),f.payload.observationId,{id:f.payload.observationId,sessionId:f.payload.sessionId,title:'canonical',narrative:'source',facts:[],concepts:[],files:[],sourceRaw:{raw:'preserved'}});
 await f.kv.set(KV.sessions,f.payload.sessionId,{id:f.payload.sessionId,status:'active',observationCount:duplicate?1:0});
 const started=performance.now();let ackMs=0,endMs=0;const pending=f.send().then(()=>{ackMs=performance.now()-started;});await vi.waitFor(()=>expect(f.entered()).toBe(true));
 const endStart=performance.now(),end=finishLongSession(f.kv as never,KV,withKeyedLock,f.payload.sessionId,true).then(()=>{endMs=performance.now()-endStart;});
 await new Promise(r=>setTimeout(r,250));f.release();await Promise.all([pending,end]);
 expect(ackMs).toBeGreaterThanOrEqual(250);expect(await f.kv.list(KV.observations(f.payload.sessionId))).toHaveLength(1);
 process.stdout.write(JSON.stringify({syntheticSessionLockComparison:true,duplicate,injectedCertificateDelayMs:250,sessionEndMs:Math.round(endMs*100)/100,captureAckMs:Math.round(ackMs*100)/100})+"\n");
});
for(const beginBeforePrepare of [false,true])it(`invalidates a certificate when an SDK write begins ${beginBeforePrepare?'before':'after'} prepare and applies before a lost response`,async()=>{
 const{mkdtemp,writeFile,rename,rm}=await import('node:fs/promises');const{tmpdir}=await import('node:os');const{join}=await import('node:path');const{StateKV}=await import('../src/state/kv.js');const{createStateDurabilityFence}=await import('../src/ops/state-durability.mjs');
 const dir=await mkdtemp(join(tmpdir(),'am-lock-sdk-'));vi.stubEnv('AGENTMEMORY_STATE_STORE_PATH',dir);const rows=new Map<string,Map<string,any>>();
 let allowApply!:()=>void,started=false;const applyGate=new Promise<void>(resolve=>allowApply=resolve);
 let rejectWrite!:(error:Error)=>void,applied=false;const response=new Promise((_,reject)=>rejectWrite=reject);void response.catch(()=>{});
 const sdk={trigger:async({function_id,payload:p}:any)=>{
  if(function_id==='state::get')return rows.get(p.scope)?.get(p.key)??null;
  if(function_id==='state::list')return[...rows.get(p.scope)?.values()??[]];
  if(function_id==='state::set'){
   if(p.value.title==='foreign applied'){started=true;if(beginBeforePrepare)await applyGate;}
   if(!rows.has(p.scope))rows.set(p.scope,new Map());rows.get(p.scope)!.set(p.key,JSON.parse(JSON.stringify(p.value)));
   const path=join(dir,encodeURIComponent(p.scope)+'.bin');await writeFile(path+'.tmp',JSON.stringify(Object.fromEntries(rows.get(p.scope)!)));await rename(path+'.tmp',path);
   if(p.value.title==='foreign applied'){applied=true;await response;}
   return p.value;
  }
 }};
 const durability=createStateDurabilityFence({storePath:dir,timeoutMs:500,pollIntervalMs:5});const kv=new StateKV(sdk as never,{backend:'file',durability});const provider={name:'synthetic',dimensions:2,embed:vi.fn(async()=>new Float32Array([1,0]))};
 const worker=registerEmbeddingRecovery({kv,KV,index:new VectorIndex(),provider,withKeyedLock,schedule:false,persistIndex:async()=>{}});workers.push(worker);const item={id:'obs_apply_hold',sessionId:'s',kind:'synthetic' as const};
 try{
  await kv.set(KV.observations('s'),item.id,{id:item.id,sessionId:'s',title:'original',sourceRaw:{raw:'original source'}});const certify=beginBeforePrepare?null:await worker.prepareEnqueue(item);
  const pending=kv.set(KV.observations('s'),item.id,{id:item.id,sessionId:'s',title:'foreign applied',sourceRaw:{raw:'replacement source'}});void pending.catch(()=>{});await vi.waitFor(()=>expect(started).toBe(true));
  try{if(beginBeforePrepare)await expect(worker.prepareEnqueue(item)).rejects.toMatchObject({code:'EMBEDDING_SOURCE_CHANGED'});else{await vi.waitFor(()=>expect(applied).toBe(true));await expect(certify!()).rejects.toMatchObject({code:'EMBEDDING_SOURCE_CHANGED'});}}finally{allowApply();rejectWrite(Error('synthetic lost SDK response'));await expect(pending).rejects.toThrow('synthetic lost SDK response');}
  if(beginBeforePrepare)expect(await kv.get(RETRY,item.id)).toBeNull();else expect(await kv.get(RETRY,item.id)).not.toBeNull();
  expect(await kv.get(KV.observations('s'),item.id)).toMatchObject({title:'foreign applied'});
 }finally{worker.stop();await worker.drain();vi.unstubAllEnvs();await rm(dir,{recursive:true,force:true});}
});
it('refuses unsafe deferred file certification without a mutation guard',async()=>{
 const f=fixture();delete(f.kv as any).observationReader;
 const item={id:f.payload.observationId,sessionId:f.payload.sessionId,kind:'synthetic' as const};await f.kv.set(KV.observations(item.sessionId),item.id,{id:item.id,sessionId:item.sessionId,title:'canonical',facts:[],concepts:[],files:[]});
 await expect(f.recovery.prepareEnqueue(item)).rejects.toMatchObject({code:'EMBEDDING_SOURCE_GUARD_UNAVAILABLE'});f.release();
});
