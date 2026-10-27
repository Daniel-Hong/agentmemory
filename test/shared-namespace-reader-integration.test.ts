import {afterEach,expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createSharedNamespaceReader} from '../src/ops/shared-namespace-reader.mjs';
import {readNamespaceEntries} from '../src/ops/namespace-reader.mjs';
const dirs:string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});
async function fixture(body:string){const dir=await mkdtemp(join(tmpdir(),'am-shared-projection-'));dirs.push(dir);const path=join(dir,'synthetic.bin');await writeFile(path,body);return path;}
it('bounds shared selected serialized bytes and preserves larger values through baseline fallback',async()=>{
 const value='synthetic'.repeat(100),path=await fixture(JSON.stringify({a:value}));const reader=createSharedNamespaceReader({maxSelectedBytes:32});
 const results=await Promise.all([1,2].map(()=>reader.read(path,{keys:new Set(['a'])})));
 expect(results.map(x=>x.values.get('a'))).toEqual([value,value]);
 expect(reader.snapshot()).toMatchObject({startedReads:3,projectionFallbacks:2,sharedRequests:1,sharedJobs:0,activeReads:0,activeWaiters:0});
});
it('does not mask unselected corrupt data when oversized selected projection falls back',async()=>{
 const path=await fixture('{"a":"synthetic oversized value","bad":NaN}'),reader=createSharedNamespaceReader({maxSelectedBytes:4});
 const results=await Promise.allSettled([1,2].map(()=>reader.read(path,{keys:new Set(['a'])})));
 expect(results.every(x=>x.status==='rejected'&&x.reason.code==='state_namespace_corrupt')).toBe(true);
});
it('does not retain a large unselected value or skip its validation',async()=>{
 const path=await fixture(JSON.stringify({a:1,unselected:'x'.repeat(2*1024*1024)}));const reader=createSharedNamespaceReader({maxSelectedBytes:32});
 const results=await Promise.all([1,2].map(()=>reader.read(path,{keys:new Set(['a'])})));
 expect(results.every(x=>x.values.size===1&&x.values.get('a')===1)).toBe(true);
 expect(reader.snapshot()).toMatchObject({startedReads:1,projectionFallbacks:0});
});
it.each([-1,0.5,NaN])('rejects invalid reader projection budgets %s without reading a file',async maxSelectedBytes=>{
 await expect(readNamespaceEntries('/synthetic/not-present',{maxSelectedBytes} as any)).rejects.toMatchObject({code:'state_namespace_projection_limit_invalid'});
});

it('reads a singleton selected value above the shared budget only once',async()=>{
 const value='x'.repeat(5*1024*1024),path=await fixture(JSON.stringify({a:value}));
 const reader=createSharedNamespaceReader();
 const result=await reader.read(path,{keys:new Set(['a'])});
 expect(result.values.get('a')).toBe(value);
 expect(reader.snapshot()).toMatchObject({startedReads:1,projectionFallbacks:0,sharedRequests:0,activeReads:0,activeWaiters:0,sharedJobs:0});
});
it('lets an explicit projection policy continue the same private scan once',async()=>{
 const value='x'.repeat(80),path=await fixture(JSON.stringify({a:value,b:value}));let calls=0;
 const result=await readNamespaceEntries(path,{keys:new Set(['a','b']),maxSelectedBytes:32,allowProjectionOverflow:()=>{calls++;return true;}} as any);
 expect([...result.values.values()]).toEqual([value,value]);expect(calls).toBe(1);
});
it('propagates projection policy failure and cancellation without reporting a completed scan',async()=>{
 const path=await fixture(JSON.stringify({a:'x'.repeat(80)})),controller=new AbortController(),reports:any[]=[];
 await expect(readNamespaceEntries(path,{keys:new Set(['a']),maxSelectedBytes:32,allowProjectionOverflow:()=>{throw Object.assign(Error('synthetic policy'),{code:'POLICY_FAILED'});},onRead:info=>reports.push(info)} as any)).rejects.toMatchObject({code:'POLICY_FAILED'});
 await expect(readNamespaceEntries(path,{keys:new Set(['a']),maxSelectedBytes:32,signal:controller.signal,allowProjectionOverflow:()=>{controller.abort();return true;},onRead:info=>reports.push(info)} as any)).rejects.toMatchObject({name:'AbortError'});
 expect(reports).toHaveLength(2);expect(reports.every(x=>!x.complete)).toBe(true);
});
it('keeps a real oversized private scan separate from followers after the limit boundary',async()=>{
 const value='x'.repeat(5*1024*1024),path=await fixture(JSON.stringify({a:value}));let release!:()=>void,entered!:()=>void,reads=0;
 const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);
 const reader=createSharedNamespaceReader({read:async(path,options)=>{
  const first=++reads===1;
  return readNamespaceEntries(path,{...options,allowProjectionOverflow:async()=>{
   const permitted=options.allowProjectionOverflow();if(first){entered();await gate;}return permitted;
  }});
 }});
 const first=reader.read(path,{keys:new Set(['a'])});await ready;
 const follower=await reader.read(path,{keys:new Set(['a'])});release();
 expect((await first).values.get('a')).toBe(value);expect(follower.values.get('a')).toBe(value);
 expect(reader.snapshot()).toMatchObject({startedReads:2,projectionFallbacks:0,sharedRequests:0,activeReads:0,activeWaiters:0});
});
it('still validates corrupt unselected data after continuing a private oversized projection',async()=>{
 const path=await fixture('{"a":"'+ 'x'.repeat(80)+'","bad":NaN}'),reader=createSharedNamespaceReader({maxSelectedBytes:32});
 await expect(reader.read(path,{keys:new Set(['a'])})).rejects.toMatchObject({code:'state_namespace_corrupt'});
 expect(reader.snapshot()).toMatchObject({startedReads:1,projectionFallbacks:0,completeReads:0});
});
it('rejects an invalid projection policy before opening a file',async()=>{
 await expect(readNamespaceEntries('/synthetic/not-present',{allowProjectionOverflow:true} as any)).rejects.toMatchObject({code:'state_namespace_projection_policy_invalid'});
});
it('bounds a real hinted union over 4 MiB and falls back to each pair own selection',async()=>{
 const value='x'.repeat(3*1024*1024),path=await fixture(JSON.stringify({a:value,b:value})),selections:string[][]=[];
 const reader=createSharedNamespaceReader({read:async(path,options)=>{selections.push([...options.keys]);return readNamespaceEntries(path,options);}});
 const results=await Promise.all(['a','b'].map(key=>reader.read(path,{keys:new Set([key]),joinKeys:new Set(['a','b'])})));
 expect(results.map(x=>[...x.values.keys()])).toEqual([['a'],['b']]);expect(selections).toEqual([['a','b'],['a'],['b']]);
 expect(reader.snapshot()).toMatchObject({projectionFallbacks:2,startedReads:3,activeReads:0,activeWaiters:0});
});
it('keeps distinct chunk admission callbacks out of shared jobs',async()=>{
 const path=await fixture('{"key":1}'),reader=createSharedNamespaceReader();let a=0,b=0;
 await Promise.all([reader.read(path,{keys:new Set(['key']),withReadChunk:async(work:any)=>{a++;return work();}}),reader.read(path,{keys:new Set(['key']),withReadChunk:async(work:any)=>{b++;return work();}})]);
 expect(a).toBe(1);expect(b).toBe(1);await reader.drain();expect(reader.snapshot().sharedRequests).toBe(0);
});
