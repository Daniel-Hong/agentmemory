import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mockKV,mockSdk} from './helpers/mocks.js';
import {KV} from '../src/state/schema.js';
import {VectorIndex} from '../src/state/vector-index.js';
import * as search from '../src/functions/search.js';
import {registerObserveFunction} from '../src/functions/observe.js';
import {registerCaptureFunctions} from '../src/functions/capture.js';
import {withKeyedLock} from '../src/state/keyed-mutex.js';
import {registerEmbeddingRecovery} from '../src/ops/embedding-recovery.mjs';
vi.mock('../src/logger.js',()=>({logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}}));
const RETRY='mem:embedding-retry:v1';
const COMMITTED='mem:embedding-committed:v1';
const payload={sessionId:'synthetic-capture',project:'synthetic',cwd:'/tmp/synthetic',hookType:'post_tool_use',timestamp:'2026-10-15T00:00:00Z',data:{tool_name:'synthetic',tool_output:'preserved synthetic source'}};
const controllers:any[]=[];
function fixture(embed=vi.fn(async()=>new Float32Array([1,0]))) {
 const kv=mockKV(),index=new VectorIndex();
 const provider={name:'synthetic',dimensions:2,embed};
 const recovery=registerEmbeddingRecovery({kv,KV,index,provider,withKeyedLock,schedule:false,persistIndex:async()=>{},logger:{warn:vi.fn()}});
 controllers.push(recovery);return {kv,index,provider,recovery};
}
afterEach(async()=>{for(const c of controllers.splice(0)){c.stop();await c.drain();}search.setEmbeddingRecovery(null);search.setVectorIndex(null);search.setEmbeddingProvider(null);});
describe('capture completes with durable embedding intent rather than waiting for inference',()=>{
 it('preserves raw and returns ACK plus duplicate ACK while the embedding provider cannot finish',async()=>{
  const f=fixture(vi.fn(async()=>{throw Error('capture must not call inference')}));
  search.setVectorIndex(f.index);search.setEmbeddingProvider(f.provider);search.setEmbeddingRecovery(f.recovery);
  const sdk=mockSdk({looseTrigger:true});registerObserveFunction(sdk as never,f.kv as never);const capture=registerCaptureFunctions(sdk as never,f.kv as never);controllers.push(capture);
  const first:any=await sdk.trigger('mem::capture',{payload,eventId:'synthetic-event'});
  expect(first).toMatchObject({status:'accepted',state:'completed'});
  const stored:any=await f.kv.get(KV.observations(payload.sessionId),first.observationId);
  expect(stored.sourceRaw.toolOutput).toContain('preserved synthetic source');
  expect(await f.kv.get(RETRY,first.observationId)).toMatchObject({id:first.observationId,kind:'synthetic',attempts:0});
  expect(await f.kv.list(KV.captureInbox)).toHaveLength(0);
  const second:any=await sdk.trigger('mem::capture',{payload,eventId:'synthetic-event'});
  expect(second.status).toBe('duplicate');expect(f.provider.embed).not.toHaveBeenCalled();
  expect(await f.kv.list(KV.observations(payload.sessionId))).toHaveLength(1);
 });
 it('does not ACK capture if durable intent persistence fails',async()=>{
  const f=fixture();search.setVectorIndex(f.index);search.setEmbeddingProvider(f.provider);search.setEmbeddingRecovery(f.recovery);
  const oldSet=f.kv.set;f.kv.set=async(scope:any,key:any,value:any)=>{if(scope===RETRY)throw Error('synthetic intent write failure');return oldSet(scope,key,value);};
  const sdk=mockSdk({looseTrigger:true});registerObserveFunction(sdk as never,f.kv as never);const capture=registerCaptureFunctions(sdk as never,f.kv as never);controllers.push(capture);
  const result:any=await sdk.trigger('mem::capture',{payload,eventId:'synthetic-intent-fail'});
  expect(result.state).toBe('retrying');expect(await f.kv.list(KV.captureInbox)).toHaveLength(1);expect(f.provider.embed).not.toHaveBeenCalled();
 });
 it('refuses duplicate ACK when restoring durable intent fails',async()=>{
  const f=fixture();search.setVectorIndex(f.index);search.setEmbeddingProvider(f.provider);search.setEmbeddingRecovery(f.recovery);
  const sdk=mockSdk({looseTrigger:true});registerObserveFunction(sdk as never,f.kv as never);controllers.push(registerCaptureFunctions(sdk as never,f.kv as never));
  const input={payload,eventId:'synthetic-redelivery'};const first:any=await sdk.trigger('mem::capture',input);
  await f.recovery.pump();await f.recovery.drain();f.index.remove(first.observationId);
  const oldSet=f.kv.set;f.kv.set=async(scope:any,key:any,value:any)=>{if(scope===RETRY)throw Error('synthetic intent unavailable');return oldSet(scope,key,value);};
  await expect(sdk.trigger('mem::capture',input)).rejects.toThrow('synthetic intent unavailable');
 });
 it('refuses duplicate ACK when the canonical observation cannot be read',async()=>{
  const f=fixture();search.setVectorIndex(f.index);search.setEmbeddingProvider(f.provider);search.setEmbeddingRecovery(f.recovery);
  const sdk=mockSdk({looseTrigger:true});registerObserveFunction(sdk as never,f.kv as never);controllers.push(registerCaptureFunctions(sdk as never,f.kv as never));
  const input={payload,eventId:'synthetic-unreadable'};await sdk.trigger('mem::capture',input);
  const oldGet=f.kv.get;f.kv.get=async(scope:any,key:any)=>{if(scope===KV.observations(payload.sessionId))throw Error('synthetic read failure');return oldGet(scope,key);};
  await expect(sdk.trigger('mem::capture',input)).rejects.toThrow('capture_existing_observation_unavailable');
 });
 it('accepts duplicate durable intent without waiting for an in-flight embedding of that record',async()=>{
  let release!:(x:Float32Array)=>void;const embed=vi.fn(()=>new Promise<Float32Array>(r=>release=r));const f=fixture(embed);
  await f.kv.set(KV.observations('s'),'o',{id:'o',title:'canonical'});
  const pending=f.recovery.add({id:'o',sessionId:'s',kind:'synthetic'});
  await vi.waitFor(()=>expect(embed).toHaveBeenCalledOnce());
  try{await Promise.race([f.recovery.enqueue({id:'o',sessionId:'s',kind:'synthetic'}),new Promise((_,reject)=>setTimeout(()=>reject(Error('intent waited for inference')),100))]);}
  finally{release(new Float32Array([1,0]));await pending;}
  await f.recovery.drain();expect(embed).toHaveBeenCalledOnce();expect(await f.kv.get(COMMITTED,'o')).toBeTruthy();
 });
 it('retries the canonical projection changed during inference instead of publishing a false completed intent',async()=>{
  let release!:(x:Float32Array)=>void;const embed=vi.fn().mockImplementationOnce(()=>new Promise<Float32Array>(r=>release=r)).mockResolvedValue(new Float32Array([0,1]));const f=fixture(embed);
  await f.kv.set(KV.observations('s'),'o',{id:'o',title:'old'});const pending=f.recovery.add({id:'o',sessionId:'s',kind:'synthetic'});
  await vi.waitFor(()=>expect(embed).toHaveBeenCalledOnce());await f.kv.set(KV.observations('s'),'o',{id:'o',title:'new'});release(new Float32Array([1,0]));await pending;await f.recovery.drain();
  expect(await f.kv.get(RETRY,'o')).toBeTruthy();expect(await f.kv.get(COMMITTED,'o')).toBeNull();
  await f.recovery.pump();await f.recovery.drain();expect(embed).toHaveBeenCalledTimes(2);expect(await f.kv.get(RETRY,'o')).toBeNull();expect(await f.kv.get(COMMITTED,'o')).toBeTruthy();
 });
});
