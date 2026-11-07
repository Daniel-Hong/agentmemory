import {afterEach,expect,it,vi} from 'vitest';
import {mockKV} from './helpers/mocks.js';
import {KV} from '../src/state/schema.js';
import {VectorIndex} from '../src/state/vector-index.js';
import {withKeyedLock} from '../src/state/keyed-mutex.js';
import {installBackgroundControl} from '../src/ops/background-control.mjs';
import {serializeLongSessionProvider} from '../src/ops/long-session.mjs';
import {registerEmbeddingRecovery,EMBEDDING_RETRY_NAMESPACE as RETRY} from '../src/ops/embedding-recovery.mjs';

const workers:ReturnType<typeof registerEmbeddingRecovery>[]=[];
afterEach(async()=>{installBackgroundControl(null);for(const worker of workers.splice(0)){worker.stop();await worker.drain();}vi.useRealTimers();});
async function fixture(count=12){
 vi.useFakeTimers();vi.setSystemTime(100000);
 const kv=mockKV(),index=new VectorIndex();let active=0,peak=0;
 const embed=vi.fn(async()=>{peak=Math.max(peak,++active);await Promise.resolve();active--;return new Float32Array([1,0]);});
 const persistIndex=vi.fn(async()=>{});
 const options={kv:kv as never,KV,index,provider:{dimensions:2,embed},withKeyedLock,schedule:false,persistIndex};
 const worker=registerEmbeddingRecovery(options);workers.push(worker);
 for(let n=0;n<count;n++){const id=String(n);await kv.set(KV.observations('s'),id,{id,sessionId:'s',title:'synthetic '+id});await kv.set(RETRY,id,{id,sessionId:'s',kind:'synthetic',attempts:0,retryAt:0});}
 return{kv,index,embed,persistIndex,worker,options,peak:()=>peak};
}
it('continues a published backlog after a one-second yield with at most five serial inferences per round',async()=>{
 const f=await fixture();f.worker.start();await vi.advanceTimersByTimeAsync(15000);
 expect(f.worker.snapshot().completedCount).toBe(5);expect(f.peak()).toBe(1);
 await vi.advanceTimersByTimeAsync(999);expect(f.embed).toHaveBeenCalledTimes(5);
 await vi.advanceTimersByTimeAsync(1);expect(f.worker.snapshot().completedCount).toBe(10);
 await vi.advanceTimersByTimeAsync(1000);expect(f.worker.snapshot().completedCount).toBe(12);
 expect(await f.kv.list(RETRY)).toHaveLength(0);expect(f.peak()).toBe(1);
});
it('rotates past unchanged failing head items without changing their attempts or source',async()=>{
 const f=await fixture(6),get=f.kv.get;
 f.kv.get=async(scope,id)=>{if(scope===KV.observations('s')&&Number(id)<5)throw Error('synthetic read failure');return get(scope,id);};
 f.worker.start();await vi.advanceTimersByTimeAsync(15000);expect(f.embed).not.toHaveBeenCalled();
 await vi.advanceTimersByTimeAsync(14999);expect(f.embed).not.toHaveBeenCalled();
 await vi.advanceTimersByTimeAsync(1);expect(f.index.has('5')).toBe(true);
 for(let n=0;n<5;n++){expect(await get(RETRY,String(n))).toMatchObject({attempts:0,retryAt:0});expect(await get(KV.observations('s'),String(n))).toMatchObject({title:'synthetic '+n});}
});
it('does not start another round while any selected publication is unresolved',async()=>{
 const f=await fixture(11);let release!:()=>void;const held=new Promise<void>(r=>release=r);
 f.persistIndex.mockImplementation(async()=>held);f.worker.start();
 try{await vi.advanceTimersByTimeAsync(15000);expect(f.embed).toHaveBeenCalledTimes(5);expect(f.worker.snapshot().completedCount).toBe(0);
  await vi.advanceTimersByTimeAsync(45000);expect(f.embed).toHaveBeenCalledTimes(5);
 }finally{release();await f.worker.drain();}
 await vi.advanceTimersByTimeAsync(999);expect(f.embed).toHaveBeenCalledTimes(5);
 await vi.advanceTimersByTimeAsync(1);expect(f.embed).toHaveBeenCalledTimes(10);
});
it('uses the idle interval after a failed publication even when other entries complete',async()=>{
 const f=await fixture();let failed=false;
 f.persistIndex.mockImplementation(async()=>{if(!failed){failed=true;throw Error('synthetic disk failure');}});
 f.worker.start();await vi.advanceTimersByTimeAsync(15000);expect(f.worker.snapshot().completedCount).toBe(4);
 await vi.advanceTimersByTimeAsync(14999);expect(f.embed).toHaveBeenCalledTimes(5);
 await vi.advanceTimersByTimeAsync(1);expect(f.embed).toHaveBeenCalledTimes(10);
 expect(await f.kv.get(RETRY,'0')).toMatchObject({attempts:1,retryAt:145000});
});
it('keeps provider backoff and does not poll a future-only queue at the fast rate',async()=>{
 const f=await fixture(1);f.embed.mockRejectedValueOnce(Object.assign(Error('synthetic provider failure'),{code:'ECONNRESET'}));
 const list=vi.spyOn(f.kv,'list');f.worker.start();await vi.advanceTimersByTimeAsync(15000);
 expect(await f.kv.get(RETRY,'0')).toMatchObject({attempts:1,retryAt:145000});const scans=list.mock.calls.length;
 await vi.advanceTimersByTimeAsync(14999);expect(list.mock.calls.length).toBe(scans);
 await vi.advanceTimersByTimeAsync(1);expect(f.embed).toHaveBeenCalledTimes(1);
 await vi.advanceTimersByTimeAsync(15000);expect(f.embed).toHaveBeenCalledTimes(2);expect(f.index.has('0')).toBe(true);
});
it('does not bypass provider waiting or create multiple schedules through repeated start',async()=>{
 const f=await fixture();f.worker.stop();let ready=false;
 const worker=registerEmbeddingRecovery({...f.options,readiness:{ensureReady:async()=>ready,snapshot:()=>({status:ready?'ready':'waiting'})}as never});workers.push(worker);
 worker.start();worker.start();await vi.advanceTimersByTimeAsync(15000);expect(f.embed).not.toHaveBeenCalled();
 ready=true;await vi.advanceTimersByTimeAsync(14999);expect(f.embed).not.toHaveBeenCalled();
 await vi.advanceTimersByTimeAsync(1);expect(f.embed).toHaveBeenCalledTimes(5);
 await vi.advanceTimersByTimeAsync(1000);expect(f.embed).toHaveBeenCalledTimes(10);
});
it.each(['pause','stop'])('closes fast admission on %s while preserving remaining intents',async mode=>{
 const f=await fixture();let paused=false;installBackgroundControl({isPaused:()=>paused,run:async(fn:()=>unknown)=>paused?{deferred:true}:fn()}as never);
 f.worker.start();await vi.advanceTimersByTimeAsync(15000);expect(f.embed).toHaveBeenCalledTimes(5);
 if(mode==='pause')paused=true;else f.worker.stop();
 await vi.advanceTimersByTimeAsync(16000);expect(f.embed).toHaveBeenCalledTimes(5);expect(await f.kv.list(RETRY)).toHaveLength(7);
 if(mode==='pause'){paused=false;await vi.advanceTimersByTimeAsync(15000);expect(f.embed.mock.calls.length).toBeGreaterThan(5);}
});
it('lets an already-waiting chat run between individual embeddings',async()=>{
 const f=await fixture(5);f.worker.stop();const order:string[]=[];let release!:()=>void,entered!:()=>void;
 const held=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);let active=0,peak=0,n=0;
 const provider=serializeLongSessionProvider({dimensions:2,async embed(){const id=n++;order.push('embed'+id);peak=Math.max(peak,++active);if(id===0){entered();await held;}active--;return new Float32Array([1,0]);}},withKeyedLock);
 const chat=serializeLongSessionProvider({async summarize(){order.push('chat');peak=Math.max(peak,++active);active--;return 'synthetic';}},withKeyedLock);
 const worker=registerEmbeddingRecovery({...f.options,provider});workers.push(worker);
 try{const pump=worker.pump();await started;const chatting=chat.summarize();release();await Promise.all([pump,chatting]);await worker.drain();expect(order).toEqual(['embed0','chat','embed1','embed2','embed3','embed4']);expect(peak).toBe(1);}finally{release();}
});
it('keeps old unattempted work ahead of new arrivals despite reversed engine enumeration',async()=>{
 const f=await fixture(6),get=f.kv.get,list=f.kv.list;
 f.kv.get=async(scope,id)=>{if(scope===KV.observations('s')&&Number(id)<5)throw Error('synthetic read failure');return get(scope,id);};
 await f.worker.pump();expect(f.embed).not.toHaveBeenCalled();
 for(let n=6;n<12;n++){const id=String(n);await f.kv.set(KV.observations('s'),id,{id,sessionId:'s',title:'new '+id});await f.worker.enqueue({id,sessionId:'s',kind:'synthetic'});}
 f.kv.list=async scope=>(await list(scope)).reverse();
 await f.worker.pump();expect(f.index.has('5')).toBe(true);expect(f.embed).toHaveBeenCalledTimes(1);
 expect(await f.kv.list(RETRY)).toHaveLength(11);
});
it('stops scheduling while drain still waits for already admitted publications',async()=>{
 const f=await fixture();let release!:()=>void;const held=new Promise<void>(r=>release=r);f.persistIndex.mockImplementation(async()=>held);
 f.worker.start();
 try{await vi.advanceTimersByTimeAsync(15000);f.worker.start();f.worker.stop();let drained=false;const draining=f.worker.drain().then(()=>{drained=true;});
  await vi.advanceTimersByTimeAsync(30000);expect(f.embed).toHaveBeenCalledTimes(5);expect(drained).toBe(false);
  release();await draining;expect(f.worker.snapshot().completedCount).toBe(5);
  await vi.advanceTimersByTimeAsync(30000);expect(f.embed).toHaveBeenCalledTimes(5);expect(await f.kv.list(RETRY)).toHaveLength(7);
 }finally{release();await f.worker.drain();}
});
it('does not schedule a fast round when readiness changes during publication',async()=>{
 const f=await fixture();f.worker.stop();let ready=true;
 const worker=registerEmbeddingRecovery({...f.options,readiness:{ensureReady:async()=>ready,snapshot:()=>({status:ready?'ready':'waiting'})}as never});workers.push(worker);
 f.persistIndex.mockImplementation(async()=>{ready=false;});worker.start();await vi.advanceTimersByTimeAsync(15000);
 const calls=f.embed.mock.calls.length;expect(calls).toBeGreaterThan(0);ready=true;
 await vi.advanceTimersByTimeAsync(14999);expect(f.embed).toHaveBeenCalledTimes(calls);
 await vi.advanceTimersByTimeAsync(1);expect(f.embed.mock.calls.length).toBeGreaterThan(calls);
});
it('returns to idle polling once the final publication finishes',async()=>{
 const f=await fixture(1),list=vi.spyOn(f.kv,'list');f.worker.start();await vi.advanceTimersByTimeAsync(15000);
 expect(f.worker.snapshot().completedCount).toBe(1);const scans=list.mock.calls.length;
 await vi.advanceTimersByTimeAsync(14999);expect(list.mock.calls.length).toBe(scans);
 await vi.advanceTimersByTimeAsync(1);expect(list.mock.calls.length).toBe(scans+1);expect(f.embed).toHaveBeenCalledOnce();
});
