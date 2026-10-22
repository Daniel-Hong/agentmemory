import {afterEach,beforeEach,expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStateDurabilityFence} from '../src/ops/state-durability.mjs';
let dir:string;
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'am-proof-groups-'));});
afterEach(async()=>{await rm(dir,{recursive:true,force:true});});
async function fixture(count=3,timeoutMs=250){
 const obs='mem:obs:synthetic',retry='mem:embedding-retry:v1';
 const data=new Map<string,unknown>();const observations:Record<string,unknown>={},intents:Record<string,unknown>={};
 const groups=Array.from({length:count},(_,i)=>{const key='synthetic-'+i;observations[key]={id:key,text:'preserved synthetic'};intents[key]={generation:i};data.set(obs+'\0'+key,observations[key]);data.set(retry+'\0'+key,intents[key]);return[{scope:obs,key},{scope:retry,key}];});
 await writeFile(join(dir,encodeURIComponent(obs)+'.bin'),JSON.stringify(observations));await writeFile(join(dir,encodeURIComponent(retry)+'.bin'),JSON.stringify(intents));
 const fence=createStateDurabilityFence({storePath:dir,timeoutMs,pollIntervalMs:5});
 const kv={get:async(scope:string,key:string)=>data.get(scope+'\0'+key)??null};return{fence,kv,groups,obs,retry,observations,intents,data};
}
it('shares physical reads while an incorrect item cannot certify or poison valid peers',async()=>{
 const f=await fixture();f.observations['synthetic-1']={id:'synthetic-1',text:'different'};await writeFile(join(dir,encodeURIComponent(f.obs)+'.bin'),JSON.stringify(f.observations));
 expect(f.fence.waitForKeyGroups).toBeTypeOf('function');
 const results=await f.fence.waitForKeyGroups(f.kv,f.groups);
 expect(results.map((r:any)=>r.status)).toEqual(['fulfilled','rejected','fulfilled']);
 expect(results[0].value.synced).toBe(true);expect(results[2].value.synced).toBe(true);
 expect(results[1].reason.code).toBe('STATE_DURABILITY_TIMEOUT');
 expect(f.fence.snapshot().readSharing.completeReads).toBe(2);
 expect(f.fence.snapshot().measurements.recent.filter((r:any)=>r.outcome==='failed')).toHaveLength(1);
});
it('bounds SDK capture concurrency and keeps real current-value reads',async()=>{
 const f=await fixture(5,1000);let active=0,peak=0;const get=f.kv.get;
 f.kv.get=async(scope,key)=>{active++;peak=Math.max(peak,active);try{await new Promise(r=>setTimeout(r,5));return await get(scope,key);}finally{active--;}};
 expect(f.fence.waitForKeyGroups).toBeTypeOf('function');
 const result=await f.fence.waitForKeyGroups(f.kv,f.groups);
 expect(result.every((x:any)=>x.status==='fulfilled')).toBe(true);expect(peak).toBeLessThanOrEqual(4);expect(active).toBe(0);
 expect(f.fence.snapshot().readSharing.completeReads).toBeGreaterThanOrEqual(2);
 expect(f.fence.snapshot().readSharing.completeReads).toBeLessThanOrEqual(10);
});
it('does not extend the absolute deadline or start queued SDK requests after it',async()=>{
 const f=await fixture(5,1000);let calls=0;const tasks:Promise<unknown>[]=[];
 f.kv.get=async()=>{calls++;const p=new Promise(r=>setTimeout(()=>r(null),80));tasks.push(p);return p;};
 expect(f.fence.waitForKeyGroups).toBeTypeOf('function');
 const began=Date.now();const result=await f.fence.waitForKeyGroups(f.kv,f.groups,{deadline:began+25});
 expect(result.every((x:any)=>x.status==='rejected')).toBe(true);expect(Date.now()-began).toBeLessThan(150);
 await Promise.all(tasks);await new Promise(r=>setTimeout(r,5));expect(calls).toBe(4);
});
it('fails closed when one SDK capture rejects without an error value',async()=>{
 const f=await fixture();const get=f.kv.get;f.kv.get=async(s,k)=>{if(k==='synthetic-1')throw undefined;return get(s,k);};
 expect(f.fence.waitForKeyGroups).toBeTypeOf('function');
 const result=await f.fence.waitForKeyGroups(f.kv,f.groups);
 expect(result.map((x:any)=>x.status)).toEqual(['fulfilled','rejected','fulfilled']);
 expect(result[1].reason.code).toBe('STATE_DURABILITY_TIMEOUT');
});
it('keeps unresolved SDK calls in their slots across subsequent group deadlines',async()=>{
 const f=await fixture(5,25);let calls=0,release!:(value:null)=>void;const held=new Promise<null>(r=>release=r);
 f.kv.get=async()=>{calls++;return held;};
 await f.fence.waitForKeyGroups(f.kv,f.groups);expect(calls).toBe(4);
 const second=await f.fence.waitForKeyGroups(f.kv,f.groups);expect(second.every((x:any)=>x.status==='rejected')).toBe(true);expect(calls).toBe(4);
 release(null);await new Promise(r=>setTimeout(r,5));expect(calls).toBe(4);
});
it('recaptures a changed tracked generation instead of certifying stale captured values',async()=>{
 const f=await fixture(3,500);const get=f.kv.get;let changed=false;
 f.kv.get=async(s,k)=>{
  const value=await get(s,k);
  if(!changed&&s===f.obs&&k==='synthetic-2'){
   changed=true;await f.fence.mutate(f.retry,'synthetic-0',async()=>{f.intents['synthetic-0']={generation:99};f.data.set(f.retry+'\0synthetic-0',f.intents['synthetic-0']);await writeFile(join(dir,encodeURIComponent(f.retry)+'.bin'),JSON.stringify(f.intents));});
  }return value;
 };
 const result=await f.fence.waitForKeyGroups(f.kv,f.groups);
 expect(result.every((x:any)=>x.status==='fulfilled')).toBe(true);expect(changed).toBe(true);
});
it('does not spend healthy pairs deadlines waiting for one hanging capture',async()=>{
 const f=await fixture(3,100),get=f.kv.get;let release!:(value:null)=>void;const held=new Promise<null>(r=>release=r);
 f.kv.get=async(s,k)=>k==='synthetic-1'?held:get(s,k);
 const results=await f.fence.waitForKeyGroups(f.kv,f.groups);release(null);
 expect(results.map((x:any)=>x.status)).toEqual(['fulfilled','rejected','fulfilled']);
 expect(results[0].value.waitMs).toBeLessThan(100);expect(results[2].value.waitMs).toBeLessThan(100);
});
