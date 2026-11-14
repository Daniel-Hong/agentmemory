import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StateKV} from '../src/state/kv.js';
import {KV} from '../src/state/schema.js';
import {VectorIndex} from '../src/state/vector-index.js';
import {withKeyedLock} from '../src/state/keyed-mutex.js';
import {registerEmbeddingRecovery,EMBEDDING_RETRY_NAMESPACE as RETRY} from '../src/ops/embedding-recovery.mjs';

const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{vi.unstubAllEnvs();for(const cleanup of cleanups.splice(0))await cleanup();vi.restoreAllMocks();});
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'am-selected-source-'));vi.stubEnv('AGENTMEMORY_STATE_STORE_PATH',dir);
 const rows=new Map<string,Map<string,any>>();let heldKey:string|undefined,started!:()=>void,resolve!:()=>void,reject!:(error:Error)=>void;
 const entered=new Promise<void>(yes=>started=yes),gate=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});void gate.catch(()=>{});
 const sdk={trigger:async({function_id,payload:p}:any)=>{
  const table=rows.get(p.scope);
  if(function_id==='state::get')return structuredClone(table?.get(p.key)??null);
  if(function_id==='state::list')return structuredClone([...table?.values()??[]]);
  if(function_id==='state::set'){
   if(!rows.has(p.scope))rows.set(p.scope,new Map());rows.get(p.scope)!.set(p.key,structuredClone(p.value));
   if(p.key===heldKey){started();await gate;}return p.value;
  }
  if(function_id==='state::delete')return table?.delete(p.key)??false;
  throw Error('unexpected synthetic SDK call');
 }};
 const kv=new StateKV(sdk as never),provider={name:'synthetic',dimensions:2,embed:vi.fn(async()=>new Float32Array([1,0]))};
 const worker=registerEmbeddingRecovery({kv,KV,index:new VectorIndex(),provider,withKeyedLock,schedule:false,persistIndex:async()=>{}});
 cleanups.push(async()=>{resolve();worker.stop();await worker.drain();await kv.durability!.drain();await rm(dir,{recursive:true,force:true});});
 const item={id:'selected',sessionId:'shared-session',kind:'synthetic' as const},scope=KV.observations(item.sessionId),row={id:item.id,sessionId:item.sessionId,title:'selected original',sourceRaw:{raw:'synthetic original'}};
 await kv.set(scope,item.id,row);
 return{kv,worker,provider,item,scope,row,entered,resolve,reject,hold:(key:string)=>{heldKey=key;}};
}

it.each([false,true])('certifies a selected source with another same-session applied SDK write starting beforePrepare=%s',async beforePrepare=>{
 const f=await fixture();f.hold('other');
 let other:Promise<unknown>|undefined;if(beforePrepare){other=f.kv.set(f.scope,'other',{id:'other',sessionId:f.item.sessionId});await f.entered;}
 const certify=await f.worker.prepareEnqueue(f.item);
 if(!other){other=f.kv.set(f.scope,'other',{id:'other',sessionId:f.item.sessionId});await f.entered;}
 let completed=false;const pending=certify().then(value=>{completed=true;return value;});void pending.catch(()=>{});
 await new Promise(resolve=>setTimeout(resolve,10));expect(completed).toBe(false);
 f.resolve();await other;await expect(pending).resolves.toBe(true);expect(await f.kv.get(f.scope,f.item.id)).toEqual(f.row);
 expect(await f.kv.get(RETRY,f.item.id)).toMatchObject({id:f.item.id});expect(f.provider.embed).not.toHaveBeenCalled();
});

it('refuses same-key ABA even when the final SDK row equals the original',async()=>{
 const f=await fixture(),certify=await f.worker.prepareEnqueue(f.item);
 await f.kv.set(f.scope,f.item.id,{...f.row,title:'replacement'});await f.kv.delete(f.scope,f.item.id);await f.kv.set(f.scope,f.item.id,f.row);
 await expect(certify()).rejects.toMatchObject({code:'EMBEDDING_SOURCE_CHANGED'});expect(await f.kv.get(f.scope,f.item.id)).toEqual(f.row);
});

it('refuses an unrelated uncertain SDK outcome without confusing it with target mutation',async()=>{
 const f=await fixture(),certify=await f.worker.prepareEnqueue(f.item);f.hold('other');
 const other=f.kv.set(f.scope,'other',{id:'other',sessionId:f.item.sessionId});void other.catch(()=>{});await f.entered;
 const pending=certify();void pending.catch(()=>{});await new Promise(resolve=>setTimeout(resolve,10));f.reject(Error('synthetic lost response'));
 await expect(other).rejects.toThrow('synthetic lost response');await expect(pending).rejects.toMatchObject({code:'STATE_DURABILITY_TIMEOUT',diagnostics:{errorCode:'SDK_MUTATION_UNCERTAIN'}});
 expect(f.kv.mutationOutcomeUncertain).toBe(true);expect(await f.kv.get(f.scope,f.item.id)).toEqual(f.row);expect(await f.kv.get(RETRY,f.item.id)).not.toBeNull();
});

it.each(['success','prepareFailure','fenceFailure','stopped'] as const)('releases the selected mutation watch after %s',async outcome=>{
 const f=await fixture(),fence=f.kv.durability!,original=fence.watchKeys;let live=0;
 vi.spyOn(fence,'watchKeys').mockImplementation(keys=>{const watch=original(keys);live++;let released=false;return{unchanged:watch.unchanged,release(){if(!released){released=true;live--;}watch.release();}};});
 if(outcome==='prepareFailure'){await f.kv.delete(f.scope,f.item.id);await expect(f.worker.prepareEnqueue(f.item)).rejects.toMatchObject({code:'EMBEDDING_SOURCE_CHANGED'});}
 else{
  const certify=await f.worker.prepareEnqueue(f.item);expect(live).toBe(1);
  if(outcome==='stopped'){f.worker.stop();expect(live).toBe(0);await expect(certify()).rejects.toMatchObject({code:'EMBEDDING_RECOVERY_STOPPED'});}
  else if(outcome==='fenceFailure'){vi.spyOn(fence,'waitForKeys').mockRejectedValue(Object.assign(Error('synthetic missing fence'),{code:'EMBEDDING_FENCE_UNAVAILABLE'}));await expect(certify()).rejects.toMatchObject({code:'EMBEDDING_FENCE_UNAVAILABLE'});}
  else await expect(certify()).resolves.toBe(true);
 }
 expect(live).toBe(0);
});
