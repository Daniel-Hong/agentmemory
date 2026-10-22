import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StateKV,applyUpdateOps} from '../src/state/kv.js';

const metadataScopes=['mem:memories','mem:embedding-retry:v1','mem:embedding-committed:v1','mem:index:vec-pending'];
const directories:string[]=[];
afterEach(async()=>{vi.unstubAllEnvs();await Promise.all(directories.splice(0).map(path=>rm(path,{recursive:true,force:true})));});

async function fixture(){
 const path=await mkdtemp(join(tmpdir(),'am-mutation-tracking-'));directories.push(path);
 vi.stubEnv('AGENTMEMORY_STATE_STORE_PATH',path);
 const rows=new Map<string,Map<string,unknown>>();
 const responses:{resolve:()=>void;reject:(error:Error)=>void}[]=[];
 const sdk={trigger:vi.fn(({function_id,payload}:{function_id:string;payload:any})=>{
  const {scope,key}=payload;
  if(function_id==='state::get')return Promise.resolve(structuredClone(rows.get(scope)?.get(key)??null));
  if(!rows.has(scope))rows.set(scope,new Map());
  const table=rows.get(scope)!,old=table.get(key)??null;let result:unknown;
  if(function_id==='state::set'){result=structuredClone(payload.value);table.set(key,result);}
  else if(function_id==='state::update'){const value=applyUpdateOps(old,payload.ops);table.set(key,value);result={old_value:old,new_value:value,errors:[]};}
  else if(function_id==='state::delete'){result=table.delete(key);}
  else throw Error('unexpected synthetic RPC');
  return new Promise((resolve,reject)=>responses.push({resolve:()=>resolve(result),reject}));
 })};
 const kv=new StateKV(sdk as never),reader=kv.observationReader!;
 return{kv,reader,rows,responses};
}

for(const scope of metadataScopes)for(const method of ['set','update','delete']as const)for(const rejected of [false,true]){
 it(`tracks ${scope} ${method} before its applied RPC ${rejected?'rejects':'resolves'}`,async()=>{
  const f=await fixture();f.rows.set(scope,new Map([['item',{id:'item',value:'before'}]]));
  const pending=method==='set'?f.kv.set(scope,'item',{id:'item',value:'after'}):method==='update'?f.kv.update(scope,'item',[{type:'set',path:'value',value:'after'}]):f.kv.delete(scope,'item');
  const outcome=pending.then(value=>({value}),error=>({error}));
  expect(f.reader.pendingMutations(scope)).toBe(1);
  expect(f.reader.mutationRevision(scope)).toBe(1);
  await vi.waitFor(()=>expect(f.responses).toHaveLength(1));
  expect(await f.kv.get(scope,'item')).toEqual(method==='delete'?null:{id:'item',value:'after'});
  expect(f.reader.pendingMutations(scope)).toBe(1);
  const error=Error('synthetic applied response failure');
  if(rejected)f.responses[0].reject(error);else f.responses[0].resolve();
  const result=await outcome;if(rejected)expect(result).toEqual({error});else expect(result).not.toHaveProperty('error');
  expect(f.reader.pendingMutations(scope)).toBe(0);
  expect(f.reader.mutationRevision(scope)).toBe(2);
 });
}

it('declares exact supported scopes and leaves unsupported scopes untracked',async()=>{
 const {reader}=await fixture();
 for(const scope of ['mem:obs:session',...metadataScopes])expect(reader.tracksMutations(scope)).toBe(true);
 for(const scope of ['mem:obs','mem:sessions','mem:memories:other','mem:embedding-retry:v2','mem:embedding-committed:v1:other','mem:index:vec-pending:other','mem:index:other','']){
  expect(reader.tracksMutations(scope)).toBe(false);
  const before=await reader.revision(scope),finish=reader.beginMutation(scope);
  expect(reader.pendingMutations(scope)).toBe(0);expect(reader.mutationRevision(scope)).toBe(0);
  finish();finish();expect(reader.mutationRevision(scope)).toBe(0);expect(await reader.revision(scope)).toBe(before);
 }
});

it.each(['mem:obs:session',...metadataScopes])('finalizes %s mutations once while preserving other active mutations',async scope=>{
 const {reader}=await fixture(),first=reader.beginMutation(scope),second=reader.beginMutation(scope);
 expect(reader.pendingMutations(scope)).toBe(2);expect(reader.mutationRevision(scope)).toBe(2);
 first();first();expect(reader.pendingMutations(scope)).toBe(1);expect(reader.mutationRevision(scope)).toBe(3);
 second();second();expect(reader.pendingMutations(scope)).toBe(0);expect(reader.mutationRevision(scope)).toBe(4);
});

it.each(metadataScopes)('detects %s ABA with concurrent applied writes and reversed response completion',async scope=>{
 const f=await fixture(),original={id:'item',value:'A'};f.rows.set(scope,new Map([['item',original]]));
 const before=f.reader.mutationRevision(scope);
 const first=f.kv.set(scope,'item',{id:'item',value:'B'}),second=f.kv.set(scope,'item',original);
 await vi.waitFor(()=>expect(f.responses).toHaveLength(2));
 expect(await f.kv.get(scope,'item')).toEqual(original);
 expect(f.reader.mutationRevision(scope)).toBeGreaterThan(before);expect(f.reader.pendingMutations(scope)).toBe(2);
 f.responses[1].resolve();await second;expect(f.reader.pendingMutations(scope)).toBe(1);
 f.responses[0].resolve();await first;expect(f.reader.pendingMutations(scope)).toBe(0);expect(f.reader.mutationRevision(scope)).toBe(4);
});

it('keeps observation cache, budget and revision unchanged across metadata writes',async()=>{
 const f=await fixture(),scope='mem:obs:unrelated';
 f.reader.record(scope,'observation',{id:'observation',title:'retained',narrative:'synthetic source',timestamp:'2026-10-22T00:00:00Z'});
 const before={revision:await f.reader.revision(scope),rows:await f.reader.snapshot(scope),budget:await f.reader.captureSummary(scope)};
 for(const metadataScope of metadataScopes){
  const pending=f.kv.set(metadataScope,'item',{id:'item'});await vi.waitFor(()=>expect(f.responses.length).toBeGreaterThan(0));
  f.responses.shift()!.resolve();await pending;
 }
 expect({revision:await f.reader.revision(scope),rows:await f.reader.snapshot(scope),budget:await f.reader.captureSummary(scope)}).toEqual(before);
});
