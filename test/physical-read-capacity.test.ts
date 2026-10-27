import{it,expect,vi}from'vitest';import{mkdtemp,writeFile,stat,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
const model=vi.hoisted(()=>({reads:[]as any[],value:{id:'synthetic',timestamp:'2026-01-01T00:00:00Z'}}));
vi.mock('../src/ops/namespace-reader.mjs',()=>({readNamespaceEntries:async(path:string,options:any)=>{
 if(options.onEntry){await options.withReadChunk(()=>options.onEntry('synthetic',model.value),{signal:options.signal});return{values:new Map(),entries:1};}
 const st=await stat(path,{bigint:true});options.onOpen?.({fileBytes:Number(st.size)});let release:any;const wait=new Promise(r=>release=r);model.reads.push({release});await wait;
 options.onRead?.({fileBytes:Number(st.size),bytesRead:Number(st.size),entries:1,complete:true});return{values:new Map([...options.keys].map(k=>[k,model.value])),signature:[st.dev,st.ino,st.size,st.mtimeNs,st.ctimeNs].join(':')};
}}));
import{createStateDurabilityFence}from'../src/ops/state-durability.mjs';import{createObservationReader}from'../src/ops/observation-pages.mjs';
const turn=()=>new Promise(r=>setTimeout(r,1));async function until(fn:()=>boolean){for(let i=0;i<1000&&!fn();i++)await turn();expect(fn()).toBe(true);}
for(const coordinated of[false,true])it('distinct namespace capacity limit '+coordinated,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am-capacity-model-'));let clock=0;model.reads=[];try{
 const scopes=Array.from({length:6},(_,i)=>'mem:obs:synthetic'+i);for(const scope of scopes)await writeFile(join(dir,encodeURIComponent(scope)+'.bin'),JSON.stringify({synthetic:model.value}));
 const fence=createStateDurabilityFence({storePath:dir,clock:()=>clock,timeoutMs:15000,pollIntervalMs:1});const kv={get:async()=>model.value,...(coordinated?{durability:fence}:{})};const reader=createObservationReader({storePath:dir,kv});const request=(scope:string)=>fence.waitForKeys(kv,[{scope,key:'synthetic'}]).then(()=>({ok:true}),e=>({ok:false,code:e.code}));
 const first=scopes.slice(0,5).map(request);await until(()=>model.reads.length===1&&fence.snapshot().readCoordination.activeCritical===5);clock=1000;const bulk=reader.list(scopes[0]),late=request(scopes[5]);await turn();
 for(let i=0;i<5;i++){await until(()=>model.reads.length===i+1);clock=(i+1)*2800;model.reads[i].release();}
 expect((await Promise.all(first)).every(v=>v.ok)).toBe(true);await until(()=>model.reads.length===6);clock=16800;model.reads[5].release();const result=await late;await bulk;await fence.drain();expect(result.ok).toBe(false);
 if(process.env.AM_CAPACITY_RESULT)await writeFile(process.env.AM_CAPACITY_RESULT+'-'+coordinated+'.json',JSON.stringify({diagnostic:'distinct_namespace_capacity',coordinated,simulatedClock:true,physicalServiceTimeMs:2800,firstFiveOutcomes:'all_verified',lateArrivalMs:1000,lateFinishMs:16800,lateDeadlineMs:16000,lateOutcome:result,physicalReads:model.reads.length,phaseTotals:fence.snapshot().measurements.totals},null,2)+'\n');
 }finally{await rm(dir,{recursive:true,force:true});}
});
