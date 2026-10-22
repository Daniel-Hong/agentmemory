import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,writeFile,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStateDurabilityFence} from '../src/ops/state-durability.mjs';
import {mockKV} from './helpers/mocks.js';
import {KV} from '../src/state/schema.js';
import {VectorIndex} from '../src/state/vector-index.js';
import {withKeyedLock} from '../src/state/keyed-mutex.js';
import {installBackgroundControl} from '../src/ops/background-control.mjs';
import {registerEmbeddingRecovery,EMBEDDING_RETRY_NAMESPACE as RETRY} from '../src/ops/embedding-recovery.mjs';
const workers:ReturnType<typeof registerEmbeddingRecovery>[]=[];
afterEach(async()=>{installBackgroundControl(null);for(const w of workers.splice(0)){w.stop();await w.drain();}});
async function fixture(count=5){
 const kv=mockKV(),index=new VectorIndex();let active=0,peak=0;
 const embed=vi.fn(async()=>{peak=Math.max(peak,++active);await new Promise(r=>setTimeout(r,1));active--;return new Float32Array([1,0]);});
 const groups=vi.fn(async(_kv:unknown,selections:unknown[])=>selections.map(()=>({status:'fulfilled',value:{synced:true}})));
 const fence=vi.fn(async()=>({synced:true}));
 Object.assign(kv,{backend:'file',durability:{waitForKeys:fence,waitForKeyGroups:groups}});
 const options={kv:kv as never,KV,index,provider:{dimensions:2,embed},withKeyedLock,schedule:false,persistIndex:async()=>{}};
 const worker=registerEmbeddingRecovery(options);workers.push(worker);
 for(let n=0;n<count;n++){const id=String(n);await kv.set(KV.observations('s'),id,{id,title:'current '+id});await kv.set(RETRY,id,{id,sessionId:'s',kind:'synthetic',attempts:0});}
 return {kv,index,embed,groups,fence,worker,options,peak:()=>peak};
}
it('batches at most five same-namespace intent certificates and keeps inference serial',async()=>{
 const f=await fixture(6);await f.worker.pump();await f.worker.drain();
 expect(f.groups).toHaveBeenCalledTimes(1);expect(f.groups.mock.calls[0]![1]).toHaveLength(5);
 expect(f.embed).toHaveBeenCalledTimes(5);expect(f.peak()).toBe(1);expect(await f.kv.list(RETRY)).toHaveLength(1);
});
it('isolates a failed certificate including an empty rejection from healthy peers',async()=>{
 const f=await fixture();f.groups.mockImplementationOnce(async()=>Array.from({length:5},(_,n)=>n===1?{status:'rejected',reason:undefined}:{status:'fulfilled',value:{synced:true}}) as never);
 await f.worker.pump();await f.worker.drain();expect(f.embed).toHaveBeenCalledTimes(4);expect(f.index.has('1')).toBe(false);
 expect(await f.kv.get(RETRY,'1')).toMatchObject({id:'1',attempts:1});expect(await f.kv.list(RETRY)).toHaveLength(1);
});
it('does not infer or overwrite a superseded generation or changed canonical projection',async()=>{
 const f=await fixture(3);f.embed.mockImplementationOnce(async()=>{
  await f.kv.set(RETRY,'1',{...await f.kv.get(RETRY,'1'),generation:'new-owner'});
  await f.kv.set(KV.observations('s'),'2',{id:'2',title:'changed'});return new Float32Array([1,0]);
 });
 await f.worker.pump();await f.worker.drain();expect(f.embed).toHaveBeenCalledTimes(1);
 expect(await f.kv.get(RETRY,'1')).toMatchObject({generation:'new-owner'});expect(await f.kv.get(RETRY,'2')).not.toBeNull();
});
for(const mode of ['stop','pause'])it(`retains certified intents when ${mode} arrives while the group is pending and restarts from canonical data`,async()=>{
 const f=await fixture(2);let paused=false;installBackgroundControl({isPaused:()=>paused,run:async(fn:()=>unknown)=>fn()} as never);
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 f.groups.mockImplementationOnce(async()=>{await gate;return Array.from({length:2},()=>({status:'fulfilled',value:{synced:true}}));});
 const pumping=f.worker.pump();await vi.waitFor(()=>expect(f.groups).toHaveBeenCalledTimes(1));
 if(mode==='stop')f.worker.stop();else paused=true;release();await pumping;await f.worker.drain();
 expect(f.embed).not.toHaveBeenCalled();expect(await f.kv.list(RETRY)).toHaveLength(2);
 f.worker.stop();paused=false;await f.kv.set(KV.observations('s'),'1',{id:'1',title:'latest'});
 const restarted=registerEmbeddingRecovery(f.options);workers.push(restarted);await restarted.pump();await restarted.drain();
 expect(f.embed).toHaveBeenCalledWith('latest ');expect(await f.kv.list(RETRY)).toHaveLength(0);
});
it('preparation write failure leaves its original intent and allows the other items',async()=>{
 const f=await fixture(3),set=f.kv.set;let failed=false;
 f.kv.set=async(scope,id,value)=>{if(scope===RETRY&&id==='1'&&!failed){failed=true;throw Error('synthetic write failure');}return set(scope,id,value);};
 await f.worker.pump();await f.worker.drain();expect(f.embed).toHaveBeenCalledTimes(2);expect(await f.kv.get(RETRY,'1')).not.toBeNull();
});
for(const fails of [false,true])it(`preserves a foreign generation installed during ${fails?'failed':'successful'} inference`,async()=>{
 const f=await fixture(1);f.embed.mockImplementationOnce(async()=>{
  await f.kv.set(RETRY,'0',{id:'0',sessionId:'s',kind:'synthetic',generation:'foreign',phase:'queued',attempts:7});
  if(fails)throw Error('synthetic inference failure');return new Float32Array([1,0]);
 });
 await f.worker.pump();await f.worker.drain();expect(await f.kv.get(RETRY,'0')).toMatchObject({generation:'foreign',phase:'queued',attempts:7});expect(f.index.has('0')).toBe(false);
});

it('uses one real physical namespace scan for delayed same-pump captures, without acknowledging enqueue early',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am-pump-proof-'));const f=await fixture(4);
 try{
  const durability=createStateDurabilityFence({storePath:dir,timeoutMs:1000,pollIntervalMs:5});
  await f.kv.set(KV.observations('s'),'filler',{id:'filler',narrative:'public synthetic '.repeat(200000)});
  const scopes=[KV.observations('s'),RETRY];
  async function persist(scope:string){const rows=Object.fromEntries((await f.kv.list(scope)).map((row:any)=>[row.id,row]));const path=join(dir,encodeURIComponent(scope)+'.bin');await writeFile(path+'.tmp',JSON.stringify(rows));await rename(path+'.tmp',path);}
  for(const scope of scopes)await persist(scope);
  const set=f.kv.set,del=f.kv.delete,get=f.kv.get;let grouping=false;
  f.kv.set=(scope,id,value)=>withKeyedLock('disk:'+scope,()=>durability.mutate(scope,id,async()=>{await set(scope,id,value);await persist(scope);}));
  f.kv.delete=(scope,id)=>withKeyedLock('disk:'+scope,()=>durability.mutate(scope,id,async()=>{await del(scope,id);await persist(scope);}));
  f.kv.get=async(scope,id)=>{if(grouping)await new Promise(r=>setTimeout(r,3));return get(scope,id);};
  let scans=0;const original=durability.waitForKeyGroups;
  durability.waitForKeyGroups=async(...args:any[])=>{const before=durability.snapshot().readSharing.completeReads;grouping=true;try{return await original(...args);}finally{grouping=false;scans=durability.snapshot().readSharing.completeReads-before;}};
  Object.assign(f.kv,{durability});await f.worker.pump();await f.worker.drain();
  expect(scans).toBe(2);expect(f.embed).toHaveBeenCalledTimes(4);expect(await f.kv.list(RETRY)).toHaveLength(0);
 }finally{await rm(dir,{recursive:true,force:true});}
});
it('rejects an empty provider response instead of publishing a stale vector as a new fingerprint',async()=>{
 const f=await fixture(1);f.index.add('0','s',new Float32Array([0,1]));f.embed.mockResolvedValueOnce(null as never);
 await f.worker.pump();await f.worker.drain();expect(await f.kv.get(RETRY,'0')).toMatchObject({attempts:1,errorCode:'EMBEDDING_DIMENSION_MISMATCH'});expect(f.worker.snapshot().completedCount).toBe(0);
});
it('does not let a post-certificate SDK read failure abort healthy peers',async()=>{
 const f=await fixture(3),get=f.kv.get;let certified=false;
 f.groups.mockImplementationOnce(async()=>{certified=true;return Array.from({length:3},()=>({status:'fulfilled',value:{synced:true}}));});
 f.kv.get=async(scope,id)=>{if(certified&&scope===RETRY&&id==='1')throw Error('synthetic SDK read failure');return get(scope,id);};
 await f.worker.pump();await f.worker.drain();expect(f.embed).toHaveBeenCalledTimes(2);expect(await get(RETRY,'1')).not.toBeNull();
});
