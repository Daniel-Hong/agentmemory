import {test,expect,afterEach,vi} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {StateKV} from '../src/state/kv.js';
import {createBackgroundControl} from '../src/ops/background-control.mjs';
const dirs:string[]=[];
afterEach(async()=>{vi.unstubAllEnvs();await Promise.all(dirs.splice(0).map(x=>rm(x,{recursive:true,force:true})))});
async function fixture(rows:Record<string,any>={}){
 const root=await mkdtemp(join(tmpdir(),'summary-sdk-budget-'));dirs.push(root);vi.stubEnv('AGENTMEMORY_STATE_STORE_PATH',root);
 await writeFile(join(root,'mem%3Asummaries.bin'),JSON.stringify(rows));
 const map=new Map(Object.entries(rows)),scopes=new Map<string,Map<string,any>>([['mem:summaries',map]]),calls:any[]=[];
 const scopeMap=(scope:string)=>{if(!scopes.has(scope))scopes.set(scope,new Map());return scopes.get(scope)!};
 let hook:any;
 const trigger=async(req:any)=>{calls.push(req.function_id+':'+req.payload.scope);if(hook){const reply=await hook(req);if(reply?.handled)return reply.value;}
 if(req.function_id==='state::set'){scopeMap(req.payload.scope).set(req.payload.key,req.payload.value);return {old_value:null,new_value:req.payload.value}}
 if(req.function_id==='state::get')return scopeMap(req.payload.scope).get(req.payload.key)??null;
 if(req.function_id==='state::list')return [...scopeMap(req.payload.scope).values()];throw Error('unexpected_function')};
 return {kv:new StateKV({trigger} as never),map,calls,seed:(scope:string,key:string,value:any)=>scopeMap(scope).set(key,value),peek:(scope:string,key:string)=>scopeMap(scope).get(key),setHook:(fn:any)=>{hook=fn}};
}
test('oversized summary collection is refused before the shared SDK read, without poisoning mutation state',async()=>{
 const f=await fixture({big:{sessionId:'big',segments:['S'.repeat(16*1024*1024)]}});
 const refused=await f.kv.list('mem:summaries').then(()=>({code:'unexpected_success'}),(e:any)=>({code:e.code}));
 expect(refused.code).toBe('SUMMARY_COLLECTION_TOO_LARGE');
 expect(f.calls).toEqual([]);expect(f.kv.mutationOutcomeUncertain).toBe(false);
 expect(f.kv.durability!.snapshot().mutationFailures).toBe(0);
});
test('pending replacement sizes replace old disk sizes instead of being double counted',async()=>{
 const f=await fixture({big:{sessionId:'big',segments:['S'.repeat(16*1024*1024)]}});
 await f.kv.set('mem:summaries','big',{sessionId:'big',title:'small'});
 expect(await f.kv.list('mem:summaries')).toEqual([{sessionId:'big',title:'small'}]);
});
test('budget check and SDK list serialize with summary writes but do not pause other namespaces',async()=>{
 const f=await fixture({a:{sessionId:'a'}});let release:any,entered:any;
 const waiting=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);
 f.setHook(async(req:any)=>{if(req.function_id==='state::list'){entered();await held;}return null});
 const read=f.kv.list('mem:summaries');await waiting;
 const write=f.kv.set('mem:summaries','b',{sessionId:'b'});
 await f.kv.set('mem:health','health',{status:'healthy'});
 try{
  expect(f.calls.filter(x=>x==='state::set:mem:summaries')).toHaveLength(0);
  expect(f.kv.durability!.snapshot().activeMutations).toBe(1);
 }finally{release();await read;await write;}
 expect(f.calls.filter(x=>x==='state::set:mem:summaries')).toHaveLength(1);
});
test('uncertain mutation stays latched and cannot be cleared by an otherwise small read',async()=>{
 const f=await fixture({a:{sessionId:'a'}});
 f.setHook(async(req:any)=>{if(req.function_id==='state::set')throw Object.assign(Error('timeout'),{code:'TIMEOUT'});return null});
 await expect(f.kv.set('mem:summaries','a',{sessionId:'a'})).rejects.toMatchObject({code:'TIMEOUT'});
 await expect(f.kv.list('mem:summaries')).rejects.toThrow('summary_list_mutation_uncertain');
 expect(f.kv.mutationOutcomeUncertain).toBe(true);expect(f.kv.durability!.snapshot().mutationFailures).toBe(1);
 expect(f.calls.filter(x=>x==='state::list:mem:summaries')).toHaveLength(0);
});

test('queued list sees the uncertainty latch before the namespace gate releases',async()=>{
 const f=await fixture({a:{sessionId:'a'}});let release:any,entered:any;
 const waiting=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);
 f.setHook(async(req:any)=>{if(req.function_id==='state::set'){entered();await held;throw Object.assign(Error('timeout'),{code:'TIMEOUT'});}return null});
 const write=f.kv.set('mem:summaries','a',{sessionId:'a'}).catch(e=>e);
 await waiting;const read=f.kv.list('mem:summaries').catch(e=>e);release();
 expect((await write).code).toBe('TIMEOUT');expect((await read).message).toBe('summary_list_mutation_uncertain');
 expect(f.calls.filter(x=>x==='state::list:mem:summaries')).toHaveLength(0);
});

const controlScope='mem:background-control:v1';
const recoveryRecord=()=>({version:2,paused:false,resumePending:true,holds:[],recovery:{attempts:0,nextAttemptAt:0}});
test('guarded bulk-read refusal still permits the supported current-epoch recovery without rewriting old evidence',async()=>{
 const f=await fixture({big:{sessionId:'big',segments:['S'.repeat(16*1024*1024)]}});
 const historical={status:'unknown',completed:false,verified:false,applicationFlushVerified:false};
 f.seed('synthetic:history','old',structuredClone(historical));f.seed(controlScope,'manual-pause',recoveryRecord());
 const refused=await f.kv.list('mem:summaries').then(()=>({code:'unexpected_success'}),(e:any)=>({code:e.code}));
 expect(refused.code).toBe('SUMMARY_COLLECTION_TOO_LARGE');
 const control=createBackgroundControl();await control.init(f.kv);expect(control.isPaused()).toBe(true);
 await control.change('resume');expect(control.snapshot().status).toBe('running');
 expect(control.snapshot().recovery).toMatchObject({attempts:0,nextAttemptAt:0});
 expect(f.kv.durability!.snapshot().mutationFailures).toBe(0);
 expect(f.peek('synthetic:history','old')).toEqual(historical);
});
test('supported resume cannot erase a real mutation uncertainty in the same epoch',async()=>{
 const f=await fixture({a:{sessionId:'a'}});f.seed(controlScope,'manual-pause',recoveryRecord());
 f.setHook(async(req:any)=>{if(req.function_id==='state::set'&&req.payload.scope==='mem:summaries')throw Object.assign(Error('timeout'),{code:'TIMEOUT'});return null});
 await expect(f.kv.set('mem:summaries','a',{sessionId:'a'})).rejects.toMatchObject({code:'TIMEOUT'});
 const control=createBackgroundControl();await control.init(f.kv);
 await expect(control.change('resume')).rejects.toThrow();
 expect(control.isPaused()).toBe(true);expect(control.snapshot().status).toBe('error');
 expect(f.kv.mutationOutcomeUncertain).toBe(true);expect(f.kv.durability!.snapshot().mutationFailures).toBe(1);
});

test.each(['metadata','recent'])('the %s snapshot waits for an already active summary mutation',async(kind)=>{
 const row={sessionId:'a',project:'p',createdAt:'2026-01-01T00:00:00Z',title:'old'};
 const f=await fixture({a:row});let release:any,entered:any;
 const waiting=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);
 f.setHook(async(req:any)=>{if(req.function_id==='state::set'&&req.payload.scope==='mem:summaries'){f.map.set('a',req.payload.value);entered();await held;return {handled:true,value:{old_value:row,new_value:req.payload.value}};}return null});
 const write=f.kv.set('mem:summaries','a',{...row,title:'new'});await waiting;
 const reader=(f.kv as any).summaryCount,spy=vi.spyOn(reader,kind);
 const reading=kind==='metadata'?f.kv.getSummaryMetadata():f.kv.getRecentProjectSummaries('p',1);
 try{expect(spy).not.toHaveBeenCalled();}finally{release();await write;}
 expect((await reading)[0].title).toBe('new');expect(spy).toHaveBeenCalledTimes(1);
});

test('wire admission uses the actual SDK acknowledged value instead of a smaller caller-side guess',async()=>{
 const f=await fixture();const stored={sessionId:'a',segments:['S'.repeat(16*1024*1024)]};
 f.setHook(async(req:any)=>{if(req.function_id==='state::set'){f.map.set('a',stored);return {handled:true,value:{old_value:null,new_value:stored}};}return null});
 await f.kv.set('mem:summaries','a',{sessionId:'a',title:'small caller snapshot'});
 const refused=await f.kv.list('mem:summaries').then(()=>({code:'unexpected_success'}),(e:any)=>({code:e.code}));
 expect(refused.code).toBe('SUMMARY_COLLECTION_TOO_LARGE');
 expect(f.calls.filter(x=>x==='state::list:mem:summaries')).toHaveLength(0);
 expect(f.kv.mutationOutcomeUncertain).toBe(false);
});
