import {afterEach,expect,it,vi} from 'vitest';
vi.mock('../src/logger.js',()=>({logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}}));
vi.mock('../src/functions/access-tracker.js',()=>({recordAccessBatch:vi.fn()}));
import {getSearchIndex,registerSearchFunction,setHybridRanker} from '../src/functions/search.js';
import {HybridSearch} from '../src/state/hybrid-search.js';
import {memoryToObservation} from '../src/state/memory-utils.js';
import {createStateDurabilityFence} from '../src/ops/state-durability.mjs';
import {KV} from '../src/state/schema.js';
const date='2026-01-01T00:00:00Z';
afterEach(()=>{setHybridRanker(null);getSearchIndex().clear();vi.restoreAllMocks();});
function fixture(cache:boolean){
 getSearchIndex().clear();let observers=0,peakObservers=0;let roundHook: ((limit:number)=>Promise<void>)|undefined;const records=new Map<string,any>(),reads={observations:0,memories:0};
 const fence=createStateDurabilityFence({storePath:'/tmp/synthetic-search-no-file-access',completion:'sdk'});
 const watch=fence.watchKeys.bind(fence);fence.watchKeys=(keys:any)=>{const token=watch(keys);observers++;peakObservers=Math.max(peakObservers,observers);let released=false;return{unchanged:token.unchanged,release(){if(!released){released=true;observers--;token.release();}}};};
 const kv:any={...(cache?{durability:fence,hydrationReadCurrent:()=>true}:{}),async get(scope:string,key:string){if(scope===KV.observations('memory'))reads.observations++;if(scope===KV.memories){reads.memories++;return structuredClone(records.get(key)??null);}return null;},async list(){return[];}};
 for(let i=0;i<1000;i++){const m={id:`mem_${String(i).padStart(4,'0')}`,createdAt:date,updatedAt:date,type:'fact',title:'hydration marker',content:'hydration marker',concepts:[],files:[],sessionIds:[],strength:7,version:1,isLatest:true,project:i>=998?'wanted':'other'};records.set(m.id,m);getSearchIndex().add(memoryToObservation(m as any),'memory');}
 const hybrid=new HybridSearch(getSearchIndex(),null,null,kv,0.4,0.6,0),limits:number[]=[];
 setHybridRanker(async(...args:any[])=>{limits.push(args[1]);await roundHook?.(args[1]);return (hybrid.search as any)(...args);});
 let handler:any;registerSearchFunction({registerFunction:(_:string,fn:any)=>handler=fn} as any,kv);
 return{records,reads,limits,kv,fence,onRound:(fn:(limit:number)=>Promise<void>)=>roundHook=fn,observers:()=>observers,peakObservers:()=>peakObservers,search:()=>handler({query:'hydration marker',project:'wanted',targetLayer:'memory',agentId:'*',limit:5})};
}
it('reduces repeated hydration across 100-to-1000 sparse-project rounds without changing results',async()=>{
 const baseline=fixture(false);const expected=await baseline.search();expect(baseline.limits).toEqual([100,200,400,800,1000]);expect(baseline.reads).toEqual({observations:2500,memories:3500});
 const cached=fixture(true);const result=await cached.search();expect(result).toEqual(expected);expect(cached.limits).toEqual(baseline.limits);expect(cached.reads).toEqual({observations:1000,memories:2000});expect(cached.observers()).toBe(0);expect(cached.peakObservers()).toBeLessThanOrEqual(1000);
});
it('never shares cached values across separate search requests',async()=>{
 const f=fixture(true);await f.search();f.reads.observations=0;f.reads.memories=0;f.records.get('mem_0999').content='new current content';
 const r=await f.search();expect(JSON.stringify(r)).toContain('new current content');expect(f.reads).toEqual({observations:1000,memories:2000});expect(f.observers()).toBe(0);
});

it('invalidates hydration and project authorization on mutation before index publication',async()=>{
 const f=fixture(true);f.records.get('mem_0000').project='wanted';
 f.onRound(async limit=>{if(limit===200){await f.fence.mutate(KV.memories,'mem_0000',async()=>{f.records.get('mem_0000').project='other';});await f.fence.mutate(KV.memories,'mem_0001',async()=>{f.records.get('mem_0001').project='wanted';});}});
 const result=await f.search();const ids=result.results.map((r:any)=>r.observation.id);expect(ids).not.toContain('mem_0000');expect(ids).toContain('mem_0001');expect(f.observers()).toBe(0);
});
it('does not retain a fallback hydration after an asynchronous State read failure',async()=>{
 const f=fixture(true),get=f.kv.get;let attempts=0;
 f.kv.get=async(scope:string,key:string)=>{const value=await get(scope,key);if(scope===KV.observations('memory')&&key==='mem_0000'&&++attempts===1)throw Error('synthetic temporary failure');return value;};
 await f.search();expect(attempts).toBe(2);expect(f.observers()).toBe(0);
});
it('keeps concurrent requests separate and releases all watchers',async()=>{
 const f=fixture(true);const [a,b]=await Promise.all([f.search(),f.search()]);expect(a).toEqual(b);expect(f.reads).toEqual({observations:2000,memories:4000});expect(f.observers()).toBe(0);
});

it('invalidates a cached entry when index publication replaces its revision',async()=>{
 const f=fixture(true);f.onRound(async limit=>{if(limit===200){f.records.get('mem_0000').project='wanted';getSearchIndex().invalidateRevision('mem_0000');}});
 expect((await f.search()).results.map((r:any)=>r.observation.id)).toContain('mem_0000');expect(f.observers()).toBe(0);
});
it('does not retain deleted hydration or release watchers only on success',async()=>{
 const f=fixture(true);f.records.get('mem_0000').project='wanted';f.onRound(async limit=>{if(limit===200)await f.fence.mutate(KV.memories,'mem_0000',async()=>{f.records.delete('mem_0000');});});
 expect((await f.search()).results.map((r:any)=>r.observation.id)).not.toContain('mem_0000');expect(f.observers()).toBe(0);
});
it('releases request watchers when project authorization fails',async()=>{
 const f=fixture(true),get=f.kv.get;f.kv.get=async(scope:string,key:string)=>{if(scope===KV.sessions)throw Error('synthetic authorization read failure');return get(scope,key);};
 await expect(f.search()).rejects.toThrow('synthetic authorization read failure');expect(f.observers()).toBe(0);
});
it('does not reuse a record changed while its first hydration is pending',async()=>{
 const f=fixture(true);f.records.get('mem_0000').project='wanted';f.records.get('mem_0000').content='obsolete hydration payload';const get=f.kv.get;let changed=false;
 f.kv.get=async(scope:string,key:string)=>{const value=await get(scope,key);if(scope===KV.memories&&key==='mem_0000'&&!changed){changed=true;await f.fence.mutate(scope,key,async()=>{f.records.get(key).content='current hydration payload';});}return value;};
 const result=await f.search();expect(JSON.stringify(result)).toContain('current hydration payload');expect(JSON.stringify(result)).not.toContain('obsolete hydration payload');expect(f.observers()).toBe(0);
});

it('does not reuse cached records after State writer identity changes',async()=>{
 const f=fixture(true);f.records.get('mem_0000').project='wanted';let current=true;const get=f.kv.get;
 f.kv.hydrationReadCurrent=()=>current;f.kv.get=async(...args:any[])=>{if(!current)throw Error('STATE_WRITER_IDENTITY_CHANGED');return get(...args);};
 f.onRound(async limit=>{if(limit===200)current=false;});
 expect((await f.search()).results).toEqual([]);expect(f.observers()).toBe(0);
});
it('disables reuse without a pinned read admission check',async()=>{
 const f=fixture(true);delete f.kv.hydrationReadCurrent;await f.search();expect(f.reads).toEqual({observations:2500,memories:3500});expect(f.peakObservers()).toBe(0);
});
it('rechecks identity after an asynchronous cached-value continuation',async()=>{
 const f=fixture(true);f.records.get('mem_0000').project='wanted';let current=true,armed=false;const get=f.kv.get;
 f.kv.hydrationReadCurrent=()=>{const result=current;if(armed){armed=false;queueMicrotask(()=>{current=false;});}return result;};
 f.kv.get=async(...args:any[])=>{if(!current)throw Error('STATE_WRITER_IDENTITY_CHANGED');return get(...args);};
 f.onRound(async limit=>{if(limit===200)armed=true;});
 expect((await f.search()).results).toEqual([]);expect(f.observers()).toBe(0);
});
