import {afterEach,it,expect,vi} from 'vitest';
import {mockKV} from './helpers/mocks.js';
import {KV} from '../src/state/schema.js';
import {VectorIndex} from '../src/state/vector-index.js';
import {withKeyedLock} from '../src/state/keyed-mutex.js';
import {registerEmbeddingRecovery,EMBEDDING_RETRY_NAMESPACE as RETRY,EMBEDDING_COMMITTED_NAMESPACE as COMMITTED} from '../src/ops/embedding-recovery.mjs';
const workers:ReturnType<typeof registerEmbeddingRecovery>[]=[];
afterEach(async()=>{for(const w of workers.splice(0)){w.stop();await w.drain();}vi.useRealTimers();});
function fixture(embed=vi.fn(async()=>new Float32Array([1,0]))){const kv=mockKV(),index=new VectorIndex();const worker=registerEmbeddingRecovery({kv:kv as never,KV,index,provider:{name:'fixture',dimensions:2,embed},withKeyedLock,schedule:false,persistIndex:async()=>{}});workers.push(worker);return{kv,index,worker,embed};}
it('does not turn a recovery scan into implicit full legacy backfill',async()=>{
 const f=fixture();await f.kv.set(KV.sessions,'old',{id:'old'});await f.kv.set(KV.observations('old'),'legacy',{id:'legacy',title:'old',sessionId:'old'});
 await f.worker.pump();await f.worker.drain();expect(f.embed).not.toHaveBeenCalled();expect(await f.kv.list(RETRY)).toHaveLength(0);
});
it('recovers a missing vector previously committed by this feature',async()=>{
 const f=fixture();await f.kv.set(KV.observations('s'),'o',{id:'o',title:'fixture'});await f.kv.set(COMMITTED,'o',{id:'o',sessionId:'s',kind:'synthetic',fingerprint:'previous'});
 await f.worker.pump();await f.worker.drain();expect(f.embed).toHaveBeenCalledOnce();expect(f.index.has('o')).toBe(true);expect(await f.kv.get(RETRY,'o')).toBeNull();
});
it('stop prevents new enqueue, add and timer work while drain waits for an admitted inference',async()=>{
 vi.useFakeTimers();let release!:(x:Float32Array)=>void;const f=fixture(vi.fn(()=>new Promise<Float32Array>(resolve=>{release=resolve;})));
 await f.kv.set(KV.observations('s'),'o',{id:'o',title:'fixture'});const item={id:'o',sessionId:'s',kind:'synthetic'} as const;const pending=f.worker.add(item);
 await vi.advanceTimersByTimeAsync(0);expect(f.embed).toHaveBeenCalledOnce();f.worker.start();f.worker.stop();
 let drained=false;const drain=f.worker.drain().then(()=>{drained=true;});await Promise.resolve();expect(drained).toBe(false);
 await expect(f.worker.enqueue({...item,id:'new'})).rejects.toThrow('embedding_recovery_stopped');expect(await f.worker.add({...item,id:'new'})).toBe(false);
 release(new Float32Array([1,0]));await pending;await drain;await vi.advanceTimersByTimeAsync(60000);expect(f.embed).toHaveBeenCalledOnce();expect(await f.kv.get(COMMITTED,'o')).toBeTruthy();
});
