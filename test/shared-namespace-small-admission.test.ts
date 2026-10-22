import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createSharedNamespaceReader} from '../src/ops/shared-namespace-reader.mjs';
let dir:string;
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'am-small-admission-'));});
afterEach(async()=>{await rm(dir,{recursive:true,force:true});});
async function fixture(){
 const big=join(dir,'big'),small=join(dir,'small'),next=join(dir,'next');
 await Promise.all([writeFile(big,'x'.repeat(128)),writeFile(small,'tiny'),writeFile(next,'x'.repeat(128))]);
 const calls:any[]=[];
 const reader=createSharedNamespaceReader({maxParallelReads:1,maxSmallParallelReads:1,smallReadMaxBytes:32,read:(path:string,opts:any)=>new Promise((resolve,reject)=>{
  const call={path,opts,finish(){opts.onRead?.({bytesRead:path===small?4:128,complete:true});resolve({values:new Map([['key',1]]),signature:'synthetic'});},fail:reject};calls.push(call);
 })});
 const request=(path:string,signal?:AbortSignal)=>reader.read(path,{keys:new Set(['key']),signal});
 return{big,small,next,calls,reader,request};
}
it('lets a bounded small read finish while a large read and another large request are pending',async()=>{
 const f=await fixture(),big=f.request(f.big);await vi.waitFor(()=>expect(f.calls).toHaveLength(1));
 const next=f.request(f.next),small=f.request(f.small);await vi.waitFor(()=>expect(f.calls.some(c=>c.path===f.small)).toBe(true));
 expect(f.calls.filter(c=>c.path!==f.small)).toHaveLength(1);
 const smallCall=f.calls.find(c=>c.path===f.small);expect(smallCall.opts.maxFileBytes).toBe(32);smallCall.finish();expect((await small).values.get('key')).toBe(1);
 f.calls[0].finish();await big;await vi.waitFor(()=>expect(f.calls.some(c=>c.path===f.next)).toBe(true));f.calls.find(c=>c.path===f.next).finish();await next;await f.reader.drain();
 expect(f.reader.snapshot().activeReads).toBe(0);
});
it('does not share a bounded file query with an incompatible unbounded query',async()=>{
 const f=await fixture();const a=f.reader.read(f.big,{keys:new Set(['key']),maxFileBytes:10}),b=f.reader.read(f.big,{keys:new Set(['key'])});
 await vi.waitFor(()=>expect(f.calls).toHaveLength(1));f.calls[0].finish();await a;
 await vi.waitFor(()=>expect(f.calls).toHaveLength(2));f.calls[1].finish();await b;
 expect(f.reader.snapshot().sharedRequests).toBe(0);
});
it('bounds the small lane to one physical read and preserves queued cancellation',async()=>{
 const f=await fixture();const other=join(dir,'other');await writeFile(other,'tiny');
 const big=f.request(f.big),first=f.request(f.small);await vi.waitFor(()=>expect(f.calls).toHaveLength(2));
 const controller=new AbortController(),second=f.request(other,controller.signal),rejected=expect(second).rejects.toMatchObject({name:'AbortError'});
 await vi.waitFor(()=>expect(f.reader.snapshot().admission.smallQueued).toBe(1));controller.abort();await rejected;
 expect(f.calls.map(c=>c.path)).not.toContain(other);for(const call of f.calls)call.finish();await Promise.all([big,first]);await f.reader.drain();
 expect(f.reader.snapshot().admission).toMatchObject({active:0,queued:0,smallActive:0});
});
it('moves a file that grew after classification to the regular lane without reading large bytes in the small lane',async()=>{
 const {readNamespaceEntries}=await import('../src/ops/namespace-reader.mjs');const big=join(dir,'big'),small=join(dir,'small');
 await writeFile(big,'x'.repeat(128));await writeFile(small,'{"key":1}');
 let finish!:()=>void;const metadata:any[]=[];let grown=false;
 const reader=createSharedNamespaceReader({maxParallelReads:1,maxSmallParallelReads:1,smallReadMaxBytes:32,read:async(path:string,opts:any)=>{
  if(path===big)return new Promise(resolve=>{finish=()=>resolve({values:new Map(),signature:'synthetic'});});
  if(!grown){grown=true;await writeFile(small,JSON.stringify({key:'x'.repeat(100)}));}
  return readNamespaceEntries(path,opts);
 }});
 const large=reader.read(big,{keys:new Set(['key'])});await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
 let done=false;const result=reader.read(small,{keys:new Set(['key']),onRead:(v:any)=>metadata.push(v)}).then((v:any)=>{done=true;return v;});
 await vi.waitFor(()=>expect(metadata).toHaveLength(1));expect(metadata[0]).toMatchObject({bytesRead:0,complete:false});expect(done).toBe(false);
 expect(reader.snapshot().admission).toMatchObject({regularActive:1,smallActive:0,queued:1});finish();await large;
 expect((await result).values.get('key')).toBe('x'.repeat(100));await reader.drain();expect(metadata.at(-1).complete).toBe(true);
});
it('keeps the caller file-size limit after size classification',async()=>{
 const {readNamespaceEntries}=await import('../src/ops/namespace-reader.mjs');const path=join(dir,'small');await writeFile(path,'{"key":12345}');
 const reader=createSharedNamespaceReader({read:readNamespaceEntries,maxParallelReads:1,maxSmallParallelReads:1,smallReadMaxBytes:32});
 await expect(reader.read(path,{keys:new Set(['key']),maxFileBytes:8})).rejects.toMatchObject({code:'state_namespace_file_limit'});await reader.drain();expect(reader.snapshot().startedReads).toBe(1);
});
it('does not reuse a completed small result after restart or file replacement',async()=>{
 const path=join(dir,'small');await writeFile(path,'{"key":1}');
 const reader=createSharedNamespaceReader({maxParallelReads:1,maxSmallParallelReads:1,smallReadMaxBytes:32});
 expect((await reader.read(path,{keys:new Set(['key'])})).values.get('key')).toBe(1);
 await writeFile(path,'{"key":2}');expect((await reader.read(path,{keys:new Set(['key'])})).values.get('key')).toBe(2);
 const restarted=createSharedNamespaceReader({maxParallelReads:1,maxSmallParallelReads:1,smallReadMaxBytes:32});expect((await restarted.read(path,{keys:new Set(['key'])})).values.get('key')).toBe(2);
});
it('cancels a growth fallback without starting its regular read',async()=>{
 const f=await fixture();const big=f.request(f.big);await vi.waitFor(()=>expect(f.calls).toHaveLength(1));
 const controller=new AbortController(),small=f.request(f.small,controller.signal),rejected=expect(small).rejects.toMatchObject({name:'AbortError'});
 await vi.waitFor(()=>expect(f.calls).toHaveLength(2));f.calls[1].fail(Object.assign(Error('grown'),{code:'state_namespace_file_limit'}));
 await vi.waitFor(()=>expect(f.reader.snapshot().admission.queued).toBe(1));controller.abort();await rejected;
 f.calls[0].finish();await big;await f.reader.drain();expect(f.calls).toHaveLength(2);expect(f.reader.snapshot().admission).toMatchObject({active:0,queued:0});
});
it('bounds combined shared and direct queued work and fails closed under saturation',async()=>{
 const big=join(dir,'big');await writeFile(big,'x'.repeat(128));let finish!:()=>void;
 const reader=createSharedNamespaceReader({maxParallelReads:1,maxSmallParallelReads:1,maxQueuedReads:64,read:(_path:string,opts:any)=>new Promise(resolve=>{finish=()=>resolve({values:new Map(),signature:'synthetic'});})});
 const controller=new AbortController(),busy=reader.read(big,{keys:new Set(['key'])});await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
 const results=Array.from({length:65},()=>reader.read(big,{keys:new Set(['key']),onEntry:()=>{},signal:controller.signal}).then(()=>null,(error:any)=>typeof error.code==='string'?error.code:error.name));
 await vi.waitFor(()=>expect(reader.snapshot().admission.rejected).toBe(1));expect(reader.snapshot().admission.queued).toBe(64);controller.abort();
 const outcomes=await Promise.all(results);expect(outcomes.filter(v=>v==='state_namespace_admission_limit')).toHaveLength(1);expect(outcomes.filter(v=>v==='AbortError')).toHaveLength(64);
 finish();await busy;await reader.drain();expect(reader.snapshot().admission).toMatchObject({active:0,queued:0});
});
