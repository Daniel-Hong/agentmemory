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
