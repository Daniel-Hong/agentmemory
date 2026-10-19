import {afterEach,it,expect,vi} from 'vitest';
import {mockKV} from './helpers/mocks.js';
import {KV} from '../src/state/schema.js';
import {VectorIndex} from '../src/state/vector-index.js';
import {withKeyedLock} from '../src/state/keyed-mutex.js';
import {registerEmbeddingRecovery,EMBEDDING_RETRY_NAMESPACE as RETRY,EMBEDDING_COMMITTED_NAMESPACE as COMMITTED} from '../src/ops/embedding-recovery.mjs';
const workers:ReturnType<typeof registerEmbeddingRecovery>[]=[];
afterEach(async()=>{for(const w of workers.splice(0)){w.stop();await w.drain();}});
const item={id:'o',sessionId:'s',kind:'synthetic'} as const;
function fixture(){const kv=mockKV(),index=new VectorIndex(),embed=vi.fn(async()=>new Float32Array([1,0])),persistIndex=vi.fn(async()=>{});const worker=registerEmbeddingRecovery({kv:kv as never,KV,index,provider:{name:'fixture',dimensions:2,embed},withKeyedLock,schedule:false,persistIndex});workers.push(worker);return{kv,index,embed,persistIndex,worker};}
it.each([false,true])('file intent cannot ACK without a successful fence (duplicate=%s)',async duplicate=>{
 const f=fixture();await f.kv.set(KV.observations('s'),'o',{id:'o',title:'raw'});if(duplicate)await f.kv.set(RETRY,'o',item);
 const waitForKeys=vi.fn(async()=>{throw Error('fixture_disk_unverified');});Object.assign(f.kv,{backend:'file',durability:{waitForKeys}});
 await expect(f.worker.enqueue(item)).rejects.toThrow('fixture_disk_unverified');expect(waitForKeys).toHaveBeenCalledWith(f.kv,expect.arrayContaining([{scope:KV.observations('s'),key:'o'},{scope:RETRY,key:'o'}]));expect(await f.kv.get(RETRY,'o')).toBeTruthy();expect(f.embed).not.toHaveBeenCalled();
});
it('file backend without a fence refuses inference and ACK',async()=>{
 const f=fixture();await f.kv.set(KV.observations('s'),'o',{id:'o',title:'raw'});Object.assign(f.kv,{backend:'file'});
 await expect(f.worker.enqueue(item)).rejects.toMatchObject({code:'EMBEDDING_FENCE_UNAVAILABLE'});
 await expect(f.worker.add(item)).rejects.toMatchObject({code:'EMBEDDING_FENCE_UNAVAILABLE'});expect(f.embed).not.toHaveBeenCalled();
});
it('retains a new projection changed during the committed marker write',async()=>{
 const f=fixture();await f.kv.set(KV.observations('s'),'o',{id:'o',title:'before'});const set=f.kv.set;let changed=false;
 f.kv.set=async(scope,key,value)=>{const result=await set(scope,key,value);if(scope===COMMITTED&&!changed){changed=true;await set(KV.observations('s'),'o',{id:'o',title:'after'});}return result;};
 await f.worker.add(item);await f.worker.drain();expect(await f.kv.get(RETRY,'o')).toBeTruthy();await f.worker.pump();await f.worker.drain();expect(await f.kv.get(RETRY,'o')).toBeNull();expect(f.embed).toHaveBeenCalledTimes(2);
});
it('retains canonical restoration during deletion publication',async()=>{
 const f=fixture();f.persistIndex.mockImplementationOnce(async()=>{await f.kv.set(KV.observations('s'),'o',{id:'o',title:'restored'});});
 await f.worker.enqueue(item);await f.worker.pump();await f.worker.drain();expect(await f.kv.get(RETRY,'o')).toBeTruthy();await f.worker.pump();await f.worker.drain();expect(f.index.has('o')).toBe(true);expect(await f.kv.get(RETRY,'o')).toBeNull();
});
it('restores retry ownership if the post-completion canonical read fails',async()=>{
 const f=fixture();await f.kv.set(KV.observations('s'),'o',{id:'o',title:'raw'});const get=f.kv.get,remove=f.kv.delete;let fail=false;
 f.kv.delete=async(scope,key)=>{await remove(scope,key);if(scope===RETRY)fail=true;};f.kv.get=async(scope,key)=>{if(fail&&scope===KV.observations('s'))throw Error('fixture_read_unavailable');return get(scope,key);};
 await f.worker.add(item);await f.worker.drain();expect(await get(RETRY,'o')).toBeTruthy();
});
it('keeps retry ownership if the completion marker cannot be certified on disk',async()=>{
 const f=fixture();await f.kv.set(KV.observations('s'),'o',{id:'o',title:'raw'});
 Object.assign(f.kv,{backend:'file',durability:{waitForKeys:async(_kv:unknown,keys:Array<{scope:string}>)=>{if(keys.some(k=>k.scope===COMMITTED))throw Error('fixture_marker_unverified');}}});
 await f.worker.add(item);await f.worker.drain();expect(await f.kv.get(RETRY,'o')).toBeTruthy();
});
