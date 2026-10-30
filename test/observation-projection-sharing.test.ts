import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,writeFile,rm,rename} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createObservationReader} from '../src/ops/observation-pages.mjs';
import {createFeatureLifecycle} from '../src/ops/feature-lifecycle.mjs';
import {createStatusReporter} from '../src/triggers/api.js';
import {withKeyedLock} from '../src/state/keyed-mutex.js';
import {KV} from '../src/state/schema.js';
import {registerViewerStreamTriggers} from '../src/triggers/viewer-streams.js';
import {onLiveEvent} from '../src/viewer/live-events.js';
import {resetViewerCounts} from '../src/state/viewer-counts.js';
const dirs:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const p of dirs.splice(0))await rm(p,{recursive:true,force:true});});
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'am-projection-sharing-'));dirs.push(dir);
 const scope=KV.observations('synthetic');const file=join(dir,encodeURIComponent(scope)+'.bin');
 const rows:any={one:{id:'one',title:'Synthetic',narrative:'present',sourceRaw:{toolOutput:'synthetic retained source'}}};
 await writeFile(file,JSON.stringify(rows));let chunks=0;let gate:Promise<void>|undefined;
 const values=new Map<string,any>();values.set(KV.sessions+'|synthetic',{id:'synthetic',project:'fixture',observationCount:1});
 const kv:any={get:async(s:string,k:string)=>s===scope?rows[k]??null:values.get(s+'|'+k)??null,set:async(s:string,k:string,v:any)=>values.set(s+'|'+k,v),list:async(s:string)=>s===KV.sessions?[values.get(s+'|synthetic')]:[],durability:{withBulkRead:async(work:any)=>{chunks++;await gate;return work();}}};
 const reader=createObservationReader({storePath:dir,kv});kv.observationReader=reader;
 return{dir,file,scope,rows,kv,reader,chunks:()=>chunks,block(){let release!:()=>void;gate=new Promise<void>(r=>release=r);return release;}};
}
it('shares actual file parsing between concurrent ID and index projections',async()=>{
 const f=await fixture(),release=f.block();const ids=f.reader.ids(f.scope),index=f.reader.indexCandidates(f.scope);
 await vi.waitFor(()=>expect(f.chunks()).toBeGreaterThan(0));release();
 expect(await ids).toEqual(['one']);expect(await index).toEqual([{id:'one',eligible:true}]);expect(f.chunks()).toBe(1);
});
it('reuses only small projections of an unchanged file revision',async()=>{
 const f=await fixture();expect(await f.reader.ids(f.scope)).toEqual(['one']);expect(await f.reader.indexCandidates(f.scope)).toEqual([{id:'one',eligible:true}]);expect(f.chunks()).toBe(1);
 await writeFile(f.file+'.next',JSON.stringify({two:{id:'two'}}));await rename(f.file+'.next',f.file);
 expect(await f.reader.indexCandidates(f.scope)).toEqual([{id:'two',eligible:false}]);expect(f.chunks()).toBe(2);
});
it('a timed-out real status scan remains unknown and shares its disk work with feature enqueue',async()=>{
 const f=await fixture(),release=f.block();const reporter=createStatusReporter({trigger:async()=>({})}as never,f.kv,{});
 const report=reporter({health:{status:'healthy',alerts:[],notes:[],connectionState:'connected'}as never,scanMaxAgeMs:0});
 await vi.waitFor(()=>expect(f.chunks()).toBe(1));
 const timedOut=await report;expect(timedOut.index.missingObservations).toBeNull();
 const features=createFeatureLifecycle({kv:f.kv,KV,withKeyedLock,provider:null,schedule:false,isSlotsEnabled:()=>true});
 try{
  const queued=features.enqueue('synthetic');release();expect(await queued).toMatchObject({success:true,queued:true});
  const finished=await reporter({health:{status:'healthy',alerts:[],notes:[],connectionState:'connected'}as never,scanMaxAgeMs:0});
  expect(finished.index.missingObservations).toBe(1);expect(finished.problems.some(p=>p.code==='index-missing-observations')).toBe(true);expect(f.chunks()).toBe(1);
 }finally{release();await features.stop();}
},10000);
it('invalidates parsed reuse for pending SDK changes and never shares mutable ID objects',async()=>{
 const f=await fixture();await writeFile(f.file,JSON.stringify({one:{id:{nested:'original'},title:'yes',narrative:'text'}}));
 const first=await f.reader.ids(f.scope);first[0].nested='caller mutation';expect(await f.reader.ids(f.scope)).toEqual([{nested:'original'}]);expect(f.chunks()).toBe(1);
 f.rows.one={id:'new-sdk-id',title:'yes',narrative:''};f.reader.record(f.scope,'one',f.rows.one);
 expect(await f.reader.indexCandidates(f.scope)).toEqual([{id:'new-sdk-id',eligible:false}]);expect(f.chunks()).toBe(2);
 delete f.rows.one;f.reader.record(f.scope,'one',null,true);expect(await f.reader.ids(f.scope)).toEqual([]);
});
it('does not cache failed validation or serve cached results while a mutation is active',async()=>{
 const f=await fixture();await writeFile(f.file,JSON.stringify({one:42}));await expect(f.reader.ids(f.scope)).rejects.toMatchObject({code:'invalid_observation_record'});
 await writeFile(f.file,JSON.stringify(f.rows));expect(await f.reader.ids(f.scope)).toEqual(['one']);const n=f.chunks();
 const finish=f.reader.beginMutation(f.scope);try{expect(await f.reader.ids(f.scope)).toEqual(['one']);expect(f.chunks()).toBe(n+1);}finally{finish();}
});
it('does not retain over-limit projections and evicts old scopes after eight completed entries',async()=>{
 const f=await fixture();const many=Object.fromEntries(Array.from({length:4097},(_,i)=>[String(i),{id:String(i)}]));await writeFile(f.file,JSON.stringify(many));
 expect(await f.reader.ids(f.scope)).toHaveLength(4097);const n=f.chunks();expect(await f.reader.indexCandidates(f.scope)).toHaveLength(4097);expect(f.chunks()).toBe(n*2);
 await writeFile(f.file,JSON.stringify(f.rows));await f.reader.ids(f.scope);
 for(let i=0;i<8;i++){const scope=KV.observations('extra'+i);await writeFile(join(f.dir,encodeURIComponent(scope)+'.bin'),JSON.stringify(f.rows));await f.reader.ids(scope);}
 const before=f.chunks();expect(await f.reader.ids(f.scope)).toEqual(['one']);expect(f.chunks()).toBe(before+1);
});
it('does not retain a projection whose encoded value exceeds one MiB',async()=>{
 const f=await fixture();await writeFile(f.file,JSON.stringify({one:{id:{retained:'x'.repeat(1024*1024)}}}));
 expect((await f.reader.ids(f.scope))[0].retained.length).toBe(1024*1024);const n=f.chunks();await f.reader.ids(f.scope);expect(f.chunks()).toBe(n*2);
});

it('periodic health never starts a deep scan and keeps absent or expired evidence unknown',async()=>{
 const f=await fixture(),handlers=new Map<string,any>(),events:any[]=[];
 const sdk={registerFunction:(id:string,fn:any)=>handlers.set(id,fn),registerTrigger:()=>{},trigger:async()=>({})};
 resetViewerCounts();const unsubscribe=onLiveEvent(event=>events.push(event));registerViewerStreamTriggers(sdk as never,f.kv,{});
 const tick=()=>handlers.get('event::viewer::health-changed')({key:'latest',event_type:'state:updated',new_value:{status:'healthy',alerts:[],notes:[],connectionState:'connected'}});
 try{
  await tick();expect(f.chunks()).toBe(0);expect(events.at(-1).data.report.index.missingObservations).toBeNull();
  expect(events.at(-1).data.report.problems.some((p:any)=>p.code==='index-check-unavailable')).toBe(true);
  const initial=await handlers.get('api::viewer-snapshot')({headers:{},query_params:{}});expect(initial.status_code).toBe(200);expect(initial.body.report.index.missingObservations).toBe(1);expect(f.chunks()).toBe(1);
  await tick();expect(events.at(-1).data.report.index.missingObservations).toBe(1);expect(f.chunks()).toBe(1);
  const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now+120001);await tick();
  expect(events.at(-1).data.report.index.missingObservations).toBeNull();expect(f.chunks()).toBe(1);
  expect(events.at(-1).data.report.problems.find((p:any)=>p.code==='index-check-unavailable').fix).not.toContain('next health update');
 }finally{unsubscribe();resetViewerCounts();}
});
