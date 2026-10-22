import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const hooks=vi.hoisted(()=>({elapsed:0,cost:0,reads:[] as number[],captured:0,onDirectorySync:null as null|(()=>Promise<void>)}));
vi.mock('node:fs/promises',async original=>{
 const fs=await original<typeof import('node:fs/promises')>();
 return {...fs,stat:async(...args:Parameters<typeof fs.stat>)=>{
  if(String(args[0]).endsWith('.bin'))hooks.elapsed+=hooks.cost;
  return fs.stat(...args);
 },open:async(...args:Parameters<typeof fs.open>)=>{
  if(String(args[0]).endsWith('.bin'))hooks.elapsed+=hooks.cost;
  const handle=await fs.open(...args),read=handle.createReadStream.bind(handle),sync=handle.sync.bind(handle);
  handle.createReadStream=(...options:Parameters<typeof read>)=>{hooks.reads.push(hooks.captured);return read(...options);};
  handle.sync=async()=>{if(!String(args[0]).endsWith('.bin'))await hooks.onDirectorySync?.();await sync();};return handle;
 }};
});
import {createStateDurabilityFence} from '../src/ops/state-durability.mjs';
const dirs:string[]=[];
afterEach(async()=>{hooks.elapsed=0;hooks.cost=0;hooks.reads=[];hooks.captured=0;hooks.onDirectorySync=null;await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});
async function fixture(counts:number[]){
 const path=await mkdtemp(join(tmpdir(),'am-scope-publication-'));dirs.push(path);const rows=new Map<string,Record<string,unknown>>();
 const fence=createStateDurabilityFence({storePath:path,pollIntervalMs:1,clock:()=>hooks.elapsed});
 for(const [number,count] of counts.entries()){const scope='synthetic:'+number,data=Object.fromEntries(Array.from({length:count},(_,i)=>['k'+i,{sourceRaw:'synthetic original '+i}]));rows.set(scope,data);await writeFile(join(path,encodeURIComponent(scope)+'.bin'),JSON.stringify(data));for(const key of Object.keys(data))await fence.mutate(scope,key,async()=>{});}
 const kv={get:async(scope:string,key:string)=>{hooks.captured++;return rows.get(scope)?.[key]??null;}};return{path,fence,kv,rows};
}
it.each(['wait','flushStable'] as const)('%s gives every selected namespace its own unchanged publication deadline',async method=>{
 const {fence,kv}=await fixture([3,3,3,3,3,3,3,3,1,1]);hooks.cost=2000;
 const result=method==='wait'?await fence.wait(kv):await fence.flushStable(kv,{minAgeMs:0});
 expect(result).toMatchObject({keys:26,scopes:10,synced:true});expect(hooks.elapsed).toBeGreaterThan(15000);expect(fence.keys()).toHaveLength(0);
});
it('keeps direct multi-namespace source/retry certification under one strict 15 second budget',async()=>{
 const {fence,kv}=await fixture([3,3,3,3,3,3,3,3,1,1]);hooks.cost=2000;
 await expect(fence.waitForKeys(kv,fence.keys())).rejects.toMatchObject({code:'STATE_DURABILITY_TIMEOUT',diagnostics:{stage:'readback',scopeCount:10,keyCount:26}});expect(fence.keys()).toHaveLength(26);
});
it('bounds one namespace to at most 200 selected keys per publication',async()=>{
 const {fence,kv}=await fixture([501]);await fence.wait(kv);expect(hooks.reads).toEqual([200,400,501]);expect(fence.keys()).toHaveLength(0);
});
it('continues other namespaces after a failed publication and retains only the failed keys',async()=>{
 const {path,fence,kv}=await fixture([1,1,1]);await rm(join(path,'synthetic%3A1.bin'));hooks.cost=2000;
 await expect(fence.wait(kv)).rejects.toMatchObject({code:'STATE_DURABILITY_TIMEOUT'});
 expect(fence.keys().map((item:any)=>item.scope)).toEqual(['synthetic:1']);expect(fence.snapshot().lastVerification.status).toBe('failed');
});
it('gives a smaller namespace a turn after a failed 200-key stable selection',async()=>{
 const {path,fence,kv}=await fixture([201,1]);await rm(join(path,'synthetic%3A0.bin'));hooks.cost=2000;
 expect(await fence.flushStable(kv,{minAgeMs:0})).toMatchObject({success:false,retained:true});
 expect(await fence.flushStable(kv,{minAgeMs:0})).toMatchObject({success:false,retained:true});
 expect(fence.keys()).toHaveLength(201);expect(fence.keys().every((item:any)=>item.scope==='synthetic:0')).toBe(true);
});
it('retains a newer dirty revision while subsequent namespaces finish',async()=>{
 const {fence,kv}=await fixture([1,1]);let touched=false;
 hooks.onDirectorySync=async()=>{if(!touched){touched=true;await fence.mutate('synthetic:0','k0',async()=>{});}};
 expect(await fence.wait(kv)).toMatchObject({synced:true,keys:2,scopes:2});expect(fence.keys().map((item:any)=>item.scope)).toEqual(['synthetic:0']);
});
