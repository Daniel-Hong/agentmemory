import {afterEach,expect,it,vi} from 'vitest';
import {registerSummarizeFunction} from '../src/functions/summarize.js';
import {summaryFingerprint,summaryObservations} from '../src/functions/summary-state.js';
import {KV} from '../src/state/schema.js';
import {INCREMENTAL_SUMMARY_SYSTEM} from '../src/ops/long-session.mjs';
const workers:any[]=[];afterEach(async()=>{await Promise.all(workers.splice(0).map(w=>w.stop()));vi.unstubAllEnvs();});
const xml=(narrative='small')=>`<summary><title>synthetic</title><narrative>${narrative}</narrative><decisions></decisions><files></files><concepts></concepts></summary>`;
async function fixture(oldNarrative:string,response:(system:string,prompt:string)=>Promise<string>){
 vi.stubEnv('SUMMARIZE_INPUT_CHARS','3200');
 const rows=new Map<string,any>();const handlers=new Map<string,any>();const kv={get:async(s:string,k:string)=>structuredClone(rows.get(s+'|'+k)??null),set:async(s:string,k:string,v:any)=>{rows.set(s+'|'+k,structuredClone(v));return v;},list:async(s:string)=>structuredClone([...rows].filter(([k])=>k.startsWith(s+'|')).map(([,v])=>v)),update:async(s:string,k:string,changes:any[])=>{const v=rows.get(s+'|'+k);for(const c of changes)v[c.path]=c.value;}};
 const session={id:'synthetic',project:'fixture',cwd:'/fixture',startedAt:'2026-01-01',status:'completed'};const first={id:'one',sessionId:session.id,timestamp:'2026-01-01',title:'first',narrative:'first evidence',type:'decision',facts:[],files:[],concepts:[]};const second={...first,id:'two',timestamp:'2026-01-02',title:'second'};
 await kv.set(KV.sessions,session.id,session);for(const row of [first,second])await kv.set(KV.observations(session.id),row.id,row);
 await kv.set(KV.summaries,session.id,{sessionId:session.id,project:session.project,createdAt:'2026-01-01',title:'prior',narrative:oldNarrative,keyDecisions:[],filesModified:[],concepts:[],observationCount:1,coveredFingerprint:summaryFingerprint(session as never,summaryObservations([first]as never))});
 const model=vi.fn(response);const sdk={registerFunction:(id:string,fn:any)=>handlers.set(id,fn),trigger:async(r:any)=>handlers.get(r.function_id)?.(r.payload)};
 workers.push(registerSummarizeFunction(sdk as never,kv as never,{name:'synthetic',compress:async()=>'',summarize:model}as never,undefined,{schedule:false}));
 return{model,run:()=>handlers.get('mem::summarize')({sessionId:session.id})};
}
it('routes a large prior summary through bounded incremental input instead of an unbounded reduce',async()=>{
 const f=await fixture('synthetic prior '.repeat(700),async(system)=>system===INCREMENTAL_SUMMARY_SYSTEM?JSON.stringify({title:'synthetic',narrative:'small',keyDecisions:[],filesModified:[],concepts:[]}):xml());
 expect(await f.run()).toMatchObject({success:true});expect(f.model.mock.calls.length).toBeGreaterThan(0);for(const [,prompt]of f.model.mock.calls)expect(prompt.length).toBeLessThanOrEqual(3200);
});
it('rejects oversized generated reduce input before a second provider call',async()=>{
 const f=await fixture('small',async()=>xml('synthetic generated '.repeat(700)));expect(await f.run()).toMatchObject({success:false,error:'summary_input_budget_exceeded'});expect(f.model).toHaveBeenCalledOnce();
});
