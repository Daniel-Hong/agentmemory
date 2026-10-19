import { test } from 'vitest';
import assert from 'node:assert/strict';
import {parseGraphStructuredOutput,registerEnrichmentWorker,ENRICHMENT_NAMESPACE} from '../src/ops/background-enrichment.mjs';
import {installBackgroundControl} from '../src/ops/background-control.mjs';
const KV={sessions:'sessions',observations:id=>'obs:'+id,lessons:'lessons',semantic:'semantic',crystals:'crystals',slots:'slots',globalSlots:'globalSlots',insights:'insights'};
function fixture(){let now=100000;const db=new Map(),calls=[];let mode='poison';let paused=false;
const kv={async get(ns,id){return structuredClone(db.get(ns)?.get(id)??null)},async list(ns){return structuredClone([...(db.get(ns)?.values()??[])])},async set(ns,id,value){if(!db.has(ns))db.set(ns,new Map());db.get(ns).set(id,structuredClone(value))},async update(ns,id,updates){const value=await this.get(ns,id);for(const u of updates)value[u.path]=u.value;await this.set(ns,id,value)}};
const sdk={async trigger({function_id,payload}){calls.push(structuredClone(payload));if(mode==='provider')return{success:false,deferred:true};if(function_id==='mem::compress')return{success:false,error:'output_empty'};if(mode==='poison'&&payload.observations.some(o=>o.id==='o0'))return{success:false,error:'graph_invalid_structured_output',diagnostics:{category:'output_invalid',field:'relationships.source'}};return{success:true,llm:true}}};
const worker=(overrides={})=>registerEnrichmentWorker({kv,KV,sdk,withKeyedLock:async(k,fn)=>fn(),isGraphEnabled:()=>true,isCompressEnabled:()=>false,clock:()=>now,schedule:false,batchSize:()=>5,inputChars:()=>3200,logger:{info(){},warn(){}},...overrides});
async function seed(){await kv.set(KV.sessions,'s',{id:'s',summary:{processedObservationIds:['kept'],sourceOffsets:{kept:22},segments:[{narrative:'synthetic'}]}});for(let i=0;i<5;i++)await kv.set(KV.observations('s'),'o'+i,{id:'o'+i,type:'decision',title:'Synthetic source '+i,narrative:'Synthetic graph data',sourceRaw:{toolOutput:'SYNTHETIC_RAW_'+i}})};
return{kv,calls,worker,seed,setTime:v=>now=v,advance:()=>now+=2000000,mode:v=>mode=v,pause:v=>paused=v};}

test('graph invalid field diagnostics reveal no model values',()=>{
 const bad={entities:[{type:'concept',name:'safe'}],relationships:[{type:'uses',source:'SECRET_VALUE',target:0,weight:.5}]};
 try{parseGraphStructuredOutput(JSON.stringify(bad),['o'],x=>x,'safe');assert.fail('must reject');}catch(error){assert.equal(error.message,'graph_invalid_structured_output');assert.deepEqual(error.diagnostics,{category:'output_invalid',field:'relationships.source',errorCode:'type_invalid'});assert.ok(!JSON.stringify(error).includes('SECRET_VALUE'));}
});
test('failed batch isolates poison record, bounds singleton retries, preserves history and original',async()=>{
 const f=fixture();await f.seed();const original=await f.kv.list(KV.observations('s'));const summary=(await f.kv.get(KV.sessions,'s')).summary;
 await f.kv.set(ENRICHMENT_NAMESPACE,'s',{graphDone:{unrelated:'kept'},graphFailures:Object.fromEntries(original.map(row=>[row.id,{attempts:10,retryAt:0,lastError:'old_batch_error',history:[{errorCode:'old_failure'}]}])),compressFailures:{}});
 const w=f.worker();await w.pump();assert.equal(f.calls[0].observations.length,1,'old repeated batch must start isolation');
 for(let i=0;i<20;i++){f.advance();await w.pump();}
 const state=await f.kv.get(ENRICHMENT_NAMESPACE,'s');const view=(await f.kv.get(KV.sessions,'s')).enrichmentProgress.graph;
 assert.equal(view.processedCount,4);assert.equal(view.pendingCount,1);assert.equal(view.quarantinedCount,1);assert.equal(view.status,'blocked');assert.equal(view.blockedObservations.o0.status,'blocked');
 assert.equal(state.graphDone.unrelated,'kept');assert.equal(state.graphFailures.o0.singleAttempts,8);assert.equal(state.graphFailures.o0.attempts,18);assert.deepEqual(state.graphFailures.o0.history[0],{errorCode:'old_failure'});assert.ok(state.graphFailures.o1.status==='resolved');assert.ok(state.graphDone.o1);assert.ok(!state.graphDone.o0);
 const count=f.calls.length;f.advance();await f.worker().pump();assert.equal(f.calls.length,count,'blocked is durable across restart');assert.deepEqual(await f.kv.list(KV.observations('s')),original);assert.deepEqual((await f.kv.get(KV.sessions,'s')).summary,summary);
});
test('first batch failure holds nobody and provider deferred does not count',async()=>{
 const f=fixture();await f.seed();const w=f.worker();await w.pump();let state=await f.kv.get(ENRICHMENT_NAMESPACE,'s');assert.equal(f.calls[0].observations.length,5);assert.ok(Object.values(state.graphFailures).every(s=>s.status!=='blocked'&&s.singleAttempts===0));
 f.mode('provider');f.advance();const before=structuredClone(state.graphFailures);await w.pump();state=await f.kv.get(ENRICHMENT_NAMESPACE,'s');assert.deepEqual(state.graphFailures,before);assert.equal((await f.kv.get(KV.sessions,'s')).enrichmentProgress.graph.status,'waiting_provider');
});
test('background pause admits no requests and keeps failure state',async()=>{
 const f=fixture();await f.seed();installBackgroundControl({isPaused:()=>true,run:fn=>fn()});await f.worker().pump();assert.equal(f.calls.length,0);assert.equal(await f.kv.get(ENRICHMENT_NAMESPACE,'s'),null);installBackgroundControl(null);
});

test('graph diagnostics cover malformed JSON, shape, enum, weight, dangling index, grounding',()=>{
 const entity={type:'concept',name:'safe'};
 const cases=[['{','root','json_invalid'],['null','root','shape_invalid'],['{"entities":{},"relationships":[]}','entities','type_invalid'],[JSON.stringify({entities:[{...entity,type:'BAD_SECRET'}],relationships:[]}),'entities.type','enum_invalid'],[JSON.stringify({entities:[entity],relationships:[{type:'uses',source:0,target:5,weight:.5}]}),'relationships.target','reference_invalid'],[JSON.stringify({entities:[entity],relationships:[{type:'uses',source:0,target:0,weight:2}]}),'relationships.weight','range_invalid'],[JSON.stringify({entities:[{type:'concept',name:'UNGROUNDED_SECRET'}],relationships:[]}),'entities.name','grounding_invalid']];
 for(const [json,field,errorCode]of cases)assert.throws(()=>parseGraphStructuredOutput(json,['s'],x=>x,'safe'),e=>e.diagnostics?.field===field&&e.diagnostics?.errorCode===errorCode&&!JSON.stringify(e.diagnostics).includes('SECRET'));
});

test('legacy failure summary enters retained history without retroactive field diagnosis',async()=>{
 const f=fixture();await f.seed();const legacy={attempts:10,retryAt:0,lastError:'Error: graph_invalid_structured_output'};await f.kv.set(ENRICHMENT_NAMESPACE,'s',{graphFailures:{o0:legacy},graphDone:{},compressFailures:{}});
 await f.worker().pump();const state=await f.kv.get(ENRICHMENT_NAMESPACE,'s');
 const failure=state.graphFailures.o0;
 assert.deepEqual(failure.history[0],{legacy:true,...legacy});assert.equal(failure.attempts,11);assert.equal(failure.singleAttempts,1);assert.equal(failure.history[0].diagnostics,undefined);
});
