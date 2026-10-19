import {afterEach,expect,it} from 'vitest';
import {mockKV} from './helpers/mocks.js';
import {KV} from '../src/state/schema.js';
import {VectorIndex} from '../src/state/vector-index.js';
import {setVectorIndex,setEmbeddingProvider,setPendingVectorBackfillCount,getPendingVectorBackfillCount,rebuildKeywordIndex,getSearchIndex} from '../src/functions/search.js';
afterEach(()=>{setVectorIndex(null);setEmbeddingProvider(null);setPendingVectorBackfillCount(0);getSearchIndex().clear()});
it('updates native backfill pending when recovery fills the same vectors without restarting',async()=>{
 const kv=mockKV(),vectors=new VectorIndex();setVectorIndex(vectors);setEmbeddingProvider({name:'synthetic',dimensions:2,embed:async()=>new Float32Array([1,0])} as never);
 await kv.set(KV.sessions,'s',{id:'s'});
 for(let i=0;i<4;i++)await kv.set(KV.observations('s'),'o'+i,{id:'o'+i,sessionId:'s',title:'synthetic',narrative:'synthetic',timestamp:'2026-10-15T00:00:00Z',facts:[],concepts:[],files:[]});
 const result=await rebuildKeywordIndex(kv as never,'2026-10-14T00:00:00Z');expect(result.vectorJobs).toHaveLength(4);setPendingVectorBackfillCount(4);
 vectors.add('o0','s',new Float32Array([1,0]));expect(getPendingVectorBackfillCount()).toBe(3);
 for(let i=1;i<4;i++)vectors.add('o'+i,'s',new Float32Array([1,0]));expect(getPendingVectorBackfillCount()).toBe(0);
});
it('keeps a capped remainder limited instead of implying that all missing vectors are queued',async()=>{
 const {setVectorBackfillState,getVectorBackfillState}=await import('../src/functions/search.js');
 const kv=mockKV(),vectors=new VectorIndex();setVectorIndex(vectors);setEmbeddingProvider({name:'synthetic',dimensions:2,embed:async()=>new Float32Array([1,0])} as never);
 await kv.set(KV.sessions,'s',{id:'s'});
 for(let i=0;i<5;i++)await kv.set(KV.observations('s'),'o'+i,{id:'o'+i,sessionId:'s',title:'synthetic',narrative:'synthetic',timestamp:'2026-10-15T00:00:00Z',facts:[],concepts:[],files:[]});
 await rebuildKeywordIndex(kv as never,'2026-10-14T00:00:00Z');setVectorBackfillState('limited');
 vectors.add('o0','s',new Float32Array([1,0]));vectors.add('o1','s',new Float32Array([1,0]));
 expect(getPendingVectorBackfillCount()).toBe(3);expect(getVectorBackfillState()).toBe('limited');
 for(let i=2;i<5;i++)vectors.add('o'+i,'s',new Float32Array([1,0]));expect(getVectorBackfillState()).toBe('idle');
});
