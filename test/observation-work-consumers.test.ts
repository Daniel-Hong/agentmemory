import {afterEach,it,expect,vi} from 'vitest';
import {mkdtemp,writeFile,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createObservationReader} from '../src/ops/observation-pages.mjs';
import {registerSummarizeFunction} from '../src/functions/summarize.js';
import {registerEnrichmentWorker,ENRICHMENT_NAMESPACE} from '../src/ops/background-enrichment.mjs';
import {KV} from '../src/state/schema.js';
vi.mock('../src/logger.js',()=>({logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}}));
vi.mock('../src/functions/audit.js',()=>({safeAudit:vi.fn(async()=>{})}));
const dirs:string[]=[];afterEach(async()=>{vi.unstubAllEnvs();vi.useRealTimers();for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
const output=JSON.stringify({title:'Synthetic',narrative:'Synthetic retained evidence.',filesModified:['a.ts','invented.ts'],keyDecisions:['explicit'],concepts:[]});
const clean=(value:any):any=>Array.isArray(value)?value.map(clean):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([k])=>!['createdAt','updatedAt','resolvedAt'].includes(k)).map(([k,v])=>[k,clean(v)])):value;
async function fixture(work:boolean,options:any={}){
 const dir=await mkdtemp(join(tmpdir(),'am-work-consumers-'));dirs.push(dir);const db=new Map<string,Map<string,any>>(),handlers=new Map(),calls:any[]=[];let chunks=0,reader:any;
 const kv:any={get:async(s:string,k:string)=>structuredClone(db.get(s)?.get(k)??null),list:async(s:string)=>s.startsWith('mem:obs:')?reader.list(s):structuredClone([...(db.get(s)?.values()??[])]),
  set:async(s:string,k:string,v:any)=>{if(!db.has(s))db.set(s,new Map());db.get(s)!.set(k,structuredClone(v));if(s.startsWith('mem:obs:'))reader.record(s,k,v);},
  update:async(s:string,k:string,updates:any[])=>{const row=await kv.get(s,k);for(const u of updates)row[u.path]=structuredClone(u.value);await kv.set(s,k,row);},
  durability:{withBulkRead:async(fn:any)=>{chunks++;return fn();}}};
 reader=createObservationReader({storePath:dir,kv,...options});kv.observationReader=work?reader:{revision:reader.revision};
 const sdk:any={registerFunction:(id:string,fn:any)=>handlers.set(id,fn),trigger:async({function_id,payload}:any)=>{
  if(handlers.has(function_id))return handlers.get(function_id)(payload);
  calls.push({function_id,payload:structuredClone(payload)});
  if(function_id==='mem::compress'){const row=await kv.get(KV.observations('s'),payload.observationId);await kv.set(KV.observations('s'),row.id,{...row,title:'Compressed '+row.id,narrative:'compressed evidence',llmCompressionRevision:'enrichment-v2'});return{success:true};}
  return{success:true,llm:true};
 }};
 const put=async(scope:string,key:string,value:any)=>{if(!db.has(scope))db.set(scope,new Map());db.get(scope)!.set(key,structuredClone(value));};
 const publish=async()=>{const path=join(dir,encodeURIComponent(KV.observations('s'))+'.bin');await writeFile(path+'.next',JSON.stringify(Object.fromEntries(db.get(KV.observations('s'))??[])));await rename(path+'.next',path);};
 const seed=async(rows:any[],progress:any={status:'queued'})=>{for(const row of rows)await put(KV.observations('s'),row.id,row);await put(KV.sessions,'s',{id:'s',status:'completed',project:'synthetic',observationCount:rows.length,startedAt:'2026-01-01',summaryProgress:progress});await publish();};
 return{dir,kv,reader,sdk,calls,put,publish,seed,chunks:()=>chunks,provider:{name:'synthetic',compress:vi.fn(),summarize:vi.fn(async(_system:string,input:string)=>{calls.push({function_id:'summary',payload:JSON.parse(input)});return output;})}};
}
const row=(i:number)=>({id:'o'+String(i).padStart(3,'0'),timestamp:'2026-01-01',type:'file_read',title:'Read synthetic',files:['a.ts'],narrative:'retained '+i,sourceRaw:{hookType:'post_tool_use',toolOutput:'synthetic '+i+' x'.repeat(180),raw:{}}});
it('registered summary preserves 50 batch inputs, partial pins, ties and deleted processed history with one stable metadata scan',async()=>{
 vi.stubEnv('SUMMARIZE_INPUT_CHARS','800');vi.stubEnv('SUMMARIZE_BATCH_OBS','5');
 const results:any[]=[];
 for(const work of [false,true]){
  const f=await fixture(work),rows=Array.from({length:100},(_,i)=>row(i));rows[0]={...rows[0],sourceRaw:undefined,narrative:'current projection must use retained pin',facts:[]} as any;
  await f.seed(rows);await f.put(KV.summaries,'s',{sessionId:'s',createdAt:'2026-01-01',revision:'long-session-v1',processedObservationIds:['deleted-history'],sourceOffsets:{o000:20},sourceProjectionSnapshots:{o000:{id:'o000',type:'file_read',title:'Read synthetic',content:'PINNED '.repeat(700)}},segments:[],schedulingTurn:1});
  const worker=registerSummarizeFunction(f.sdk,f.kv,f.provider as any,undefined,{schedule:false});const states=[];
  try{for(let i=0;i<50;i++){const result=await f.sdk.trigger({function_id:'mem::summarize',payload:{sessionId:'s'}});expect(result.success).toBe(true);states.push(clean({summary:await f.kv.get(KV.summaries,'s'),progress:(await f.kv.get(KV.sessions,'s')).summaryProgress}));}}finally{await worker.stop();}
  results.push({calls:f.calls,states,chunks:f.chunks()});
 }
 expect(results[1].calls).toEqual(results[0].calls);expect(results[1].states).toEqual(results[0].states);
 expect(results[1].chunks).toBeLessThan(results[0].chunks/20);
});
it.each(['backoff','blocked','provider','priority'])('preserves summary admission and selection for %s',async mode=>{
 const now=Date.now(),results=[];for(const work of [false,true]){
  const f=await fixture(work),rows=[row(0),{...row(1),timestamp:new Date(now).toISOString(),type:'decision',importance:9}, {...row(2),timestamp:new Date(now).toISOString(),sourceRaw:{hookType:'prompt_submit',userPrompt:'synthetic priority'}}];
  await f.seed(rows,{status:'queued',...(mode==='backoff'?{retryAt:now+100000}:{}),...(mode==='blocked'?{blockedObservations:Object.fromEntries(rows.map(r=>[r.id,{status:'blocked'}]))}:{})});
  if(mode==='provider')(f.provider as any).readiness={ensureReady:async()=>false,snapshot:()=>({status:'unavailable'})};
  const worker=registerSummarizeFunction(f.sdk,f.kv,f.provider as any,undefined,{schedule:false});try{const response=await f.sdk.trigger({function_id:'mem::summarize',payload:{sessionId:'s'}});results.push(clean({success:response.success,reason:response.reason,calls:f.calls,summary:await f.kv.get(KV.summaries,'s'),progress:(await f.kv.get(KV.sessions,'s')).summaryProgress}));}finally{await worker.stop();}
 }expect(results[1]).toEqual(results[0]);
});
it('keeps the last summary when a selected source changes during inference and admits the changed source on forced retry',async()=>{
 const f=await fixture(true);await f.seed([row(0)]);let changed=false;
 f.provider.summarize.mockImplementation(async()=>{if(!changed){changed=true;await f.kv.set(KV.observations('s'),'o000',{...row(0),narrative:'changed during inference'});}return output;});
 const worker=registerSummarizeFunction(f.sdk,f.kv,f.provider as any,undefined,{schedule:false});try{
  expect(await f.sdk.trigger({function_id:'mem::summarize',payload:{sessionId:'s'}})).toMatchObject({success:false,error:'source_changed'});expect(await f.kv.get(KV.summaries,'s')).toBeNull();
  expect(await f.sdk.trigger({function_id:'mem::summarize',payload:{sessionId:'s',force:true}})).toMatchObject({success:true});
 }finally{await worker.stop();}
});
it.each([false,true])('preserves compression and graph payloads, fingerprints and progress (compression %s)',async compress=>{
 const results=[];for(const work of [false,true]){
  const f=await fixture(work);await f.seed(Array.from({length:9},(_,i)=>({...row(i),concepts:['test'],...(i%2?{llmCompressionRevision:'enrichment-v2'}:{})})));
  const worker=registerEnrichmentWorker({kv:f.kv,sdk:f.sdk,KV,withKeyedLock:async(_k:any,fn:any)=>fn(),logger:{info(){},warn(){}},isGraphEnabled:()=>true,isCompressEnabled:()=>compress,schedule:false,batchSize:()=>3,inputChars:()=>1200,clock:()=>123000});
  try{for(let i=0;i<8;i++)await worker.pump();results.push(clean({calls:f.calls,state:await f.kv.get(ENRICHMENT_NAMESPACE,'s'),progress:(await f.kv.get(KV.sessions,'s')).enrichmentProgress}));}finally{await worker.stop();}
 }expect(results[1]).toEqual(results[0]);
});
it.each(['compression','graph'])('source changes before %s inference do not create provider failure attempts or mark any item complete',async kind=>{
 const f=await fixture(true);await f.seed([row(0),row(1)]);const original=f.kv.get;let changed=false;
 f.kv.get=async(s:string,k:string)=>{const value=await original(s,k);if(!changed&&s===KV.observations('s')){changed=true;return{...value,narrative:'changed selected body'};}return value;};
 const warnings:any[]=[];const worker=registerEnrichmentWorker({kv:f.kv,sdk:f.sdk,KV,withKeyedLock:async(_k:any,fn:any)=>fn(),logger:{info(){},warn(...args:any[]){warnings.push(args);}},isGraphEnabled:()=>kind==='graph',isCompressEnabled:()=>kind==='compression',schedule:false,batchSize:()=>3,inputChars:()=>3200});
 try{await worker.pump();expect(f.calls).toEqual([]);expect(await f.kv.get(ENRICHMENT_NAMESPACE,'s')).toBeNull();expect(warnings).toHaveLength(1);}finally{await worker.stop();}
});
it('normal stop still drains a selected-source checkpoint without new admission',async()=>{
 const f=await fixture(true);await f.seed([row(0)]);let enter:any,release:any;const entered=new Promise<void>(r=>enter=r),gate=new Promise<string>(r=>release=r);
 f.provider.summarize.mockImplementation(async()=>{enter();return gate;});const worker=registerSummarizeFunction(f.sdk,f.kv,f.provider as any,undefined,{schedule:false});const run=f.sdk.trigger({function_id:'mem::summarize',payload:{sessionId:'s'}});await entered;let stopped=false;const stop=worker.stop().then(()=>stopped=true);await Promise.resolve();expect(stopped).toBe(false);expect(await f.sdk.trigger({function_id:'mem::summarize',payload:{sessionId:'s'}})).toMatchObject({deferred:true,reason:'shutting_down'});release(output);expect(await run).toMatchObject({success:true});await stop;expect(stopped).toBe(true);
});
it('preserves nullish versus empty raw hook semantics when grounding model decisions',async()=>{
 const result=[];for(const work of [false,true]){const f=await fixture(work);await f.seed([{...row(0),title:'prompt_submit',hookType:'prompt_submit',sourceRaw:{hookType:'',toolOutput:'synthetic'},narrative:'nonempty evidence'}]);const worker=registerSummarizeFunction(f.sdk,f.kv,f.provider as any,undefined,{schedule:false});try{expect(await f.sdk.trigger({function_id:'mem::summarize',payload:{sessionId:'s'}})).toMatchObject({success:true});result.push((await f.kv.get(KV.summaries,'s')).keyDecisions);}finally{await worker.stop();}}expect(result).toEqual([['explicit'],['explicit']]);
});
it('keeps an unrelated generation arrival pending without rejecting the selected checkpoint or omitting the new SDK overlay',async()=>{
 const f=await fixture(true);await f.seed([row(0)]);let changed=false;f.provider.summarize.mockImplementation(async()=>{if(!changed){changed=true;await f.kv.set(KV.observations('s'),'o001',row(1));await f.kv.update(KV.sessions,'s',[{path:'observationCount',value:2}]);await f.publish();}return output;});const worker=registerSummarizeFunction(f.sdk,f.kv,f.provider as any,undefined,{schedule:false});
 try{expect(await f.sdk.trigger({function_id:'mem::summarize',payload:{sessionId:'s'}})).toMatchObject({success:true,pendingCount:1});expect(await f.sdk.trigger({function_id:'mem::summarize',payload:{sessionId:'s'}})).toMatchObject({success:true,pendingCount:0});expect((await f.kv.get(KV.summaries,'s')).processedObservationIds).toEqual(['o000','o001']);}finally{await worker.stop();}
});
it('rebinds graph fingerprints when the configured input budget changes during readiness',async()=>{
 const results=[];for(const work of [false,true]){const f=await fixture(work);await f.seed([{...row(0),narrative:'long evidence '.repeat(100)}]);let chars=3200;const w=registerEnrichmentWorker({kv:f.kv,sdk:f.sdk,KV,withKeyedLock:async(_k:any,fn:any)=>fn(),logger:{info(){},warn(){}},isGraphEnabled:()=>true,isCompressEnabled:()=>false,schedule:false,inputChars:()=>chars,readiness:{ensureReady:async()=>{chars=400;return true;},snapshot:()=>({})}});try{await w.pump();results.push(clean({calls:f.calls,state:await f.kv.get(ENRICHMENT_NAMESPACE,'s'),view:(await f.kv.get(KV.sessions,'s')).enrichmentProgress}));}finally{await w.stop();}}expect(results[1]).toEqual(results[0]);
});
it('refuses publication after the validated writer context changes during model work',async()=>{
 let context:any={};const f=await fixture(true,{workContext:()=>context});await f.seed([row(0)]);f.provider.summarize.mockImplementation(async()=>{context={};return output;});const worker=registerSummarizeFunction(f.sdk,f.kv,f.provider as any,undefined,{schedule:false});try{expect(await f.sdk.trigger({function_id:'mem::summarize',payload:{sessionId:'s'}})).toMatchObject({success:false,error:'observation_work_source_changed'});expect(await f.kv.get(KV.summaries,'s')).toBeNull();}finally{await worker.stop();}
});
