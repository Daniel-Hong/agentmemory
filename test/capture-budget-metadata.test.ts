import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createObservationReader } from "../src/ops/observation-pages.mjs";
import { budgetLiveObservationSource } from "../src/functions/observation-source-budget.js";
import { withoutObservationSource } from "../src/functions/observation-source.js";
import { payloadByteLength } from "../src/state/frame-guard.js";
import type { CompressedObservation } from "../src/types.js";

const probe=vi.hoisted(()=>({reads:0,onRead:null as null|(()=>void)}));
vi.mock("../src/ops/namespace-reader.mjs",async original=>{
 const actual=await original<typeof import("../src/ops/namespace-reader.mjs")>();
 return {...actual,readNamespaceEntries:async(...args:Parameters<typeof actual.readNamespaceEntries>)=>{
  probe.reads++;probe.onRead?.();return actual.readNamespaceEntries(...args);
 }};
});
const dirs:string[]=[];
afterEach(async()=>{probe.reads=0;probe.onRead=null;vi.unstubAllEnvs();await Promise.all(dirs.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
const row=(id:string,size=32)=>({id,sessionId:"synthetic",timestamp:"2026-10-19T00:00:00Z",type:"discovery",title:"한글😀",narrative:"synthetic",facts:[],concepts:[],files:[],source:{hookType:"post_tool_use",originalBytes:size,truncated:false,toolOutput:"x".repeat(size)},sourceRaw:{raw:"r".repeat(2048)}} as CompressedObservation);
function totals(rows:CompressedObservation[],exclude=""){
 const kept=rows.filter(r=>r.id!==exclude);
 return {count:rows.length,summaryCount:kept.length,summaryBytes:kept.reduce((n,r)=>n+payloadByteLength(withoutObservationSource(r)),0),sourceBytes:kept.reduce((n,r)=>n+(r.source?payloadByteLength(r.source)+10:0),0)};
}
async function fixture(rows:CompressedObservation[]){
 const dir=await mkdtemp(join(tmpdir(),"am-capture-budget-"));dirs.push(dir);
 const scope="mem:obs:synthetic",path=join(dir,encodeURIComponent(scope)+".bin");
 const store=new Map(rows.map(r=>[r.id,r]));
 await writeFile(path,JSON.stringify(Object.fromEntries(store)));
 const reader=createObservationReader({storePath:dir,kv:{get:async(_s:string,key:string)=>store.get(key)??null} as never});
 return {reader,scope,path,store};
}

it("loads compact budget metadata once and tracks set/update/delete before disk publication",async()=>{
 const initial=[row("a"),row("b")];const {reader,scope,store}=await fixture(initial);
 expect(await reader.captureSummary(scope)).toEqual(totals(initial));expect(probe.reads).toBe(1);
 const replacement=row("a",200),added=row("c",80);
 store.set("a",replacement);reader.record(scope,"a",replacement);
 store.set("c",added);reader.record(scope,"c",added);
 store.delete("b");reader.record(scope,"b",null,true);
 expect(await reader.captureSummary(scope,"a")).toEqual(totals([replacement,added],"a"));
 expect(await reader.captureSummary(scope)).toEqual(totals([replacement,added]));expect(probe.reads).toBe(1);
});

it("keeps mutations made while the initial read is in flight",async()=>{
 const initial=row("a");const {reader,scope,store}=await fixture([initial]);const added=row("b");
 probe.onRead=()=>{probe.onRead=null;store.set("b",added);reader.record(scope,"b",added);};
 expect(await reader.captureSummary(scope)).toEqual(totals([initial,added]));
});

it("shares a concurrent cold load and rebuilds after restart",async()=>{
 const rows=[row("a")];const {reader,scope,path}=await fixture(rows);
 await Promise.all([reader.captureSummary(scope),reader.captureSummary(scope)]);expect(probe.reads).toBe(1);
 const added=row("b");await writeFile(path,JSON.stringify({a:rows[0],b:added}));
 const fresh=createObservationReader({storePath:join(path,".."),kv:{get:async()=>null} as never});
 expect(await fresh.captureSummary(scope)).toEqual(totals([...rows,added]));
});

it("does not cache a failed scan as an empty session",async()=>{
 const rows=[row("a")];const {reader,scope,path}=await fixture(rows);await writeFile(path,'{"a":invalid}');
 await expect(reader.captureSummary(scope)).rejects.toThrow();
 await writeFile(path,JSON.stringify({a:rows[0]}));expect(await reader.captureSummary(scope)).toEqual(totals(rows));
});

it.each([0,16_000,1_000_000,9_000_000])("preserves exact live source allocation with compact metadata for %s source bytes",async size=>{
 const existing=[row("old",size)],incoming=row("new",20_000);
 const {reader,scope}=await fixture(existing);
 expect(budgetLiveObservationSource(incoming,await reader.captureSummary(scope,incoming.id))).toEqual(budgetLiveObservationSource(incoming,existing));
});

it("preserves omission when projected summaries exhaust the response frame",async()=>{
 const old=row("old");old.narrative="z".repeat(16*1024*1024);const incoming=row("new");
 const meta=totals([old]);expect(budgetLiveObservationSource(incoming,meta)).toEqual(budgetLiveObservationSource(incoming,[old]));
});

it("keeps storage keys distinct from legacy observation IDs",async()=>{
 const {reader,scope,path}=await fixture([]);const a=row("same"),b=row("same",90);
 await writeFile(path,JSON.stringify({storage_a:a,storage_b:b}));
 expect(await reader.captureSummary(scope)).toEqual(totals([a,b]));
 reader.record(scope,"storage_a",null,true);expect(await reader.captureSummary(scope)).toEqual(totals([b]));
});

it("new concurrent captures use StateKV mutation metadata and keep the exact session limit",async()=>{
 const {StateKV,applyUpdateOps}=await import("../src/state/kv.js");
 const {registerObserveFunction}=await import("../src/functions/observe.js");
 const {KV}=await import("../src/state/schema.js");
 const seed=[row("seed_a"),row("seed_b")];const {scope,path}=await fixture(seed);
 vi.stubEnv("AGENTMEMORY_STATE_STORE_PATH",join(path,".."));
 const store=new Map<string,Map<string,unknown>>([[scope,new Map(seed.map(r=>[r.id,r]))]]);
 const handlers=new Map<string,(v:any)=>Promise<any>>();
 const sdk={registerFunction:(id:string,fn:(v:any)=>Promise<any>)=>handlers.set(id,fn),trigger:async({function_id,payload:p}:any):Promise<any>=>{
  if(function_id==='state::get')return store.get(p.scope)?.get(p.key)??null;
  if(function_id==='state::set'){if(!store.has(p.scope))store.set(p.scope,new Map());store.get(p.scope)!.set(p.key,p.value);return p.value;}
  if(function_id==='state::update'){const old=store.get(p.scope)?.get(p.key);const next=applyUpdateOps(old,p.ops);store.get(p.scope)?.set(p.key,next);return {old_value:old,new_value:next,errors:[]};}
  if(function_id==='state::delete')return store.get(p.scope)?.delete(p.key);
  return handlers.get(function_id)?.(p)??null;
 }};
 const kv=new StateKV(sdk as never);await kv.observationReader!.captureSummary(scope);
 const originalList=kv.list.bind(kv);
 const list=vi.spyOn(kv,"list").mockImplementation(async scope=>{if(scope.startsWith("mem:obs:"))throw Error("full namespace list forbidden after warmup");return originalList(scope);});
 registerObserveFunction(sdk as never,kv,undefined,4);
 const send=(i:number)=>handlers.get("mem::observe")!({sessionId:"synthetic",project:"synthetic",cwd:"/tmp",hookType:"post_tool_use",timestamp:"2026-10-19T00:00:00Z",observationId:`obs_synthetic_${i}`,eventId:`synthetic_${i}`,data:{tool_name:"Read",tool_output:`raw_${i}`}});
 const results=await Promise.all([0,1,2,3].map(send));expect(results.filter(r=>r.observationId)).toHaveLength(2);expect(results.filter(r=>r.success===false)).toHaveLength(2);
 expect(await send(0)).toMatchObject({observationId:"obs_synthetic_0",deduplicated:true});
 expect((await kv.observationReader!.captureSummary(scope)).count).toBe(4);expect(list.mock.calls.filter(([scope])=>scope.startsWith("mem:obs:"))).toHaveLength(0);
 await kv.update(scope,"obs_synthetic_0",[{type:"set",path:"narrative",value:"changed"}]);
 await kv.delete(scope,"obs_synthetic_1");expect((await kv.observationReader!.captureSummary(scope)).count).toBe(3);
 expect(await send(4)).toMatchObject({observationId:"obs_synthetic_4"});
 const stored=await kv.get<CompressedObservation>(scope,"obs_synthetic_4");expect(stored?.sourceRaw?.toolOutput).toBe("raw_4");
});

it("refuses a warm budget after an ambiguous StateKV write failure",async()=>{
 const {StateKV}=await import("../src/state/kv.js");const {path,scope}=await fixture([row("a")]);
 vi.stubEnv("AGENTMEMORY_STATE_STORE_PATH",join(path,".."));
 const kv=new StateKV({trigger:async()=>{throw Error("write timed out; commit unknown");}} as never);
 await kv.observationReader!.captureSummary(scope);
 await expect(kv.set(scope,"b",row("b"))).rejects.toThrow("commit unknown");
 await expect(kv.observationReader!.captureSummary(scope)).rejects.toThrow("observation_budget_mutation_uncertain");
});
