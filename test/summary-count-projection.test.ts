import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateKV } from '../src/state/kv.js';
import { createConsolidationStatusReader } from '../src/triggers/api.js';
const dirs:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})));});
async function fixture(rows:Record<string,unknown>={}){
 const dir=await mkdtemp(join(tmpdir(),'am-summary-count-'));dirs.push(dir);vi.stubEnv('AGENTMEMORY_STATE_STORE_PATH',dir);
 const path=join(dir,encodeURIComponent('mem:summaries')+'.bin');await writeFile(path,JSON.stringify(rows));
 const trigger=vi.fn(async({function_id,payload}:any)=>{if(function_id==='state::set')return payload.value;if(function_id==='state::delete')return true;throw Error('unexpected_full_sdk_read');});
 return {kv:new StateKV({trigger} as never),trigger,path};
}
it('counts summary keys without returning their values through the SDK',async()=>{
 const {kv,trigger}=await fixture({a:{text:'x'.repeat(128*1024)},b:null});
 expect(await kv.countSummaries()).toBe(2);expect(trigger).not.toHaveBeenCalled();
});
it('shares an initial summary-key scan and reuses only the unchanged file generation',async()=>{
 const {kv,path}=await fixture({a:null,b:{text:'retained synthetic body'}}),reads=vi.spyOn(kv.durability!,'withBulkRead');
 expect(await Promise.all([kv.countSummaries(),kv.countSummaries(),kv.countSummaries()])).toEqual([2,2,2]);
 expect(reads).toHaveBeenCalledTimes(1);expect(await kv.countSummaries()).toBe(2);expect(reads).toHaveBeenCalledTimes(1);
 await writeFile(path+'.next','{"c":{}}');await rename(path+'.next',path);
 expect(await kv.countSummaries()).toBe(1);expect(reads).toHaveBeenCalledTimes(2);
 await kv.set('mem:summaries','pending',null);await kv.delete('mem:summaries','c');
 expect(await kv.countSummaries()).toBe(1);expect(reads).toHaveBeenCalledTimes(2);
});
it('never falls back to previously cached summary counts after corrupt publication',async()=>{
 const {kv,path}=await fixture({a:{}});expect(await kv.countSummaries()).toBe(1);
 await writeFile(path,'{"broken":');
 const results=await Promise.allSettled([kv.countSummaries(),kv.countSummaries()]);
 expect(results.every(result=>result.status==='rejected')).toBe(true);
 await writeFile(path,'{"fixed":{},"other":{}}');expect(await kv.countSummaries()).toBe(2);
});
it('counts every summary key without retaining an over-budget generation',async()=>{
 const {kv,path}=await fixture();await writeFile(path,JSON.stringify(Object.fromEntries(Array.from({length:16385},(_,i)=>['key'+i,null]))));
 const reads=vi.spyOn(kv.durability!,'withBulkRead');expect(await kv.countSummaries()).toBe(16385);const first=reads.mock.calls.length;
 expect(first).toBeGreaterThan(0);expect(await kv.countSummaries()).toBe(16385);expect(reads.mock.calls.length).toBe(first*2);
});
it('does not retain source keys whose encoded bytes exceed the key cache budget',async()=>{
 const {kv,path}=await fixture();await writeFile(path,JSON.stringify({['k'.repeat(4*1024*1024+1)]:null}));
 const reads=vi.spyOn(kv.durability!,'withBulkRead');expect(await kv.countSummaries()).toBe(1);const first=reads.mock.calls.length;
 expect(await kv.countSummaries()).toBe(1);expect(reads.mock.calls.length).toBe(first*2);
},10000);
it('invalidates a cached absence at first publication without losing later SDK tombstones',async()=>{
 const {kv,path}=await fixture();await rm(path);expect(await kv.countSummaries()).toBe(0);
 await writeFile(path,'{"published":null}');expect(await kv.countSummaries()).toBe(1);
 await kv.set('mem:summaries','pending',null);expect(await kv.countSummaries()).toBe(2);
 await writeFile(path+'.next','{"published":null,"pending":null}');await rename(path+'.next',path);
 await kv.delete('mem:summaries','pending');expect(await kv.countSummaries()).toBe(1);
});
it('overlays SDK completed insert, replacement, null set and deletion before publication',async()=>{
 const {kv,path}=await fixture({a:{text:'old'},b:{text:'old'}});
 await kv.set('mem:summaries','a',{text:'new'});await kv.set('mem:summaries','c',null);await kv.delete('mem:summaries','b');
 expect(await kv.countSummaries()).toBe(2);
 await writeFile(path,JSON.stringify({a:{text:'new'},c:null}));expect(await kv.countSummaries()).toBe(2);
 expect(await new StateKV({trigger:vi.fn()} as never).countSummaries()).toBe(2);
});
it('does not translate corrupt or uncertain storage into zero summaries',async()=>{
 const {kv,path,trigger}=await fixture();await writeFile(path,'{"broken":');await expect(kv.countSummaries()).rejects.toThrow(/state_namespace/);
 await writeFile(path,'{}');trigger.mockRejectedValueOnce(Error('synthetic_timeout'));await expect(kv.set('mem:summaries','x',{})).rejects.toThrow('synthetic_timeout');
 await expect(kv.countSummaries()).rejects.toThrow(/uncertain/i);
});
it('renders the actual consolidation input count without a full summaries invocation',async()=>{
 const {kv,trigger}=await fixture({a:{text:'summary one'},b:{text:'summary two'}});
 trigger.mockImplementation(async({function_id,payload}:any)=>{
  if(function_id==='state::get')return null;
  if(function_id==='state::list'&&payload.scope!=='mem:summaries')return [];
  throw Error('full_summary_transport_forbidden');
 });
 expect((await createConsolidationStatusReader(kv)()).summaries).toBe(2);
});
it('keeps Redis counts on its supported SDK backend',async()=>{
 const kv=new StateKV({trigger:async()=>[{id:'one'},{id:'two'}]} as never,{backend:'redis'});
 expect(await kv.countSummaries()).toBe(2);
});
it('ignores an opaque archive trailer without counting it as records',async()=>{
 const {kv,path}=await fixture({a:{text:'small'}});
 await writeFile(path,Buffer.concat([Buffer.from('{"a":{"text":"small"}}'),Buffer.alloc(128*1024,255)]));
 expect(await kv.countSummaries()).toBe(1);
});
it('includes completed SDK records before the first file publication',async()=>{
 const {kv,path}=await fixture();await rm(path);expect(await kv.countSummaries()).toBe(0);
 await kv.set('mem:summaries','pending',{text:'kept'});expect(await kv.countSummaries()).toBe(1);
 await kv.delete('mem:summaries','pending');expect(await kv.countSummaries()).toBe(0);
});
it('retains the latest SDK deletion across a later publication of an older set',async()=>{
 const {kv,path}=await fixture();await kv.set('mem:summaries','k',{});await kv.delete('mem:summaries','k');
 expect(await kv.countSummaries()).toBe(0);
 await writeFile(path,'{"k":{}}');expect(await kv.countSummaries()).toBe(0);
});
it('bounds retained overlay metadata without turning a successful SDK write into failure',async()=>{
 const {kv}=await fixture();await expect(kv.set('mem:summaries','k'.repeat(4*1024*1024+1),{text:'saved'})).resolves.toEqual({text:'saved'});
 await expect(kv.countSummaries()).rejects.toThrow('summary_count_overlay_limit_or_unknown');
});
it('does not guess record presence after an unrecognized update result',async()=>{
 const {kv,trigger}=await fixture();trigger.mockResolvedValueOnce(undefined);await kv.update('mem:summaries','unknown',[]);
 await expect(kv.countSummaries()).rejects.toThrow('summary_count_overlay_limit_or_unknown');
});
