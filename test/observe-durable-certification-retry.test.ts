import {afterEach,expect,it,vi} from 'vitest';
import {mockKV,mockSdk} from './helpers/mocks.js';
import {KV} from '../src/state/schema.js';
import {VectorIndex} from '../src/state/vector-index.js';
import {DedupMap} from '../src/functions/dedup.js';
import * as search from '../src/functions/search.js';
import {registerObserveFunction} from '../src/functions/observe.js';
import {withKeyedLock} from '../src/state/keyed-mutex.js';
import {registerEmbeddingRecovery,EMBEDDING_RETRY_NAMESPACE as RETRY} from '../src/ops/embedding-recovery.mjs';
vi.mock('../src/logger.js',()=>({logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}}));
afterEach(()=>{search.setEmbeddingRecovery(null);search.setVectorIndex(null);search.setEmbeddingProvider(null);});
it('recertifies a stored server capture before semantic dedup can acknowledge a failed intent',async()=>{
 const kv=mockKV(),sdk=mockSdk({looseTrigger:true}),dedup=new DedupMap(),index=new VectorIndex();
 const provider={name:'synthetic',dimensions:2,embed:vi.fn(async()=>new Float32Array([1,0]))};
 const recovery=registerEmbeddingRecovery({kv,KV,index,provider,withKeyedLock,schedule:false,persistIndex:async()=>{}});
 search.setVectorIndex(index);search.setEmbeddingProvider(provider);search.setEmbeddingRecovery(recovery);
 registerObserveFunction(sdk as never,kv as never,dedup);
 const payload={sessionId:'synthetic-certification',project:'synthetic',cwd:'/tmp/synthetic',hookType:'post_tool_use',timestamp:'2026-10-22T00:00:00Z',observationId:'obs_durable_certification',data:{tool_name:'synthetic',tool_output:'preserved source'}};
 const originalSet=kv.set;let fail=true;
 kv.set=async(scope,key,value)=>{if(scope===RETRY&&fail)throw Error('synthetic intent unavailable');return originalSet(scope,key,value);};
 try{
  await expect(sdk.trigger('mem::observe',payload)).rejects.toThrow('synthetic intent unavailable');
  await expect(sdk.trigger('mem::observe',payload)).rejects.toThrow('synthetic intent unavailable');
  fail=false;
  expect(await sdk.trigger('mem::observe',payload)).toMatchObject({observationId:payload.observationId,existing:true});
  const rows:any[]=await kv.list(KV.observations(payload.sessionId));
  expect(rows).toHaveLength(1);expect(rows[0].sourceRaw.toolOutput).toBe('preserved source');
  expect(await kv.get(RETRY,payload.observationId)).toMatchObject({id:payload.observationId,kind:'synthetic'});
  expect(provider.embed).not.toHaveBeenCalled();
 }finally{dedup.stop();recovery.stop();await recovery.drain();}
});
