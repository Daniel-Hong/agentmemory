import{afterEach,expect,it,vi}from'vitest';import{mkdtemp,writeFile,rename,rm}from'node:fs/promises';import{join}from'node:path';import{tmpdir}from'node:os';import{readNamespaceEntries}from'../src/ops/namespace-reader.mjs';import{createReadCoordinator}from'../src/ops/read-coordinator.mjs';
const dirs:string[]=[];afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
async function fixture(body='{"key":1}'){const dir=await mkdtemp(join(tmpdir(),'am-chunk-coordination-'));dirs.push(dir);const path=join(dir,'rows');await writeFile(path,body);const g=createReadCoordinator();return{dir,path,g,withReadChunk:(work:any,options:any)=>g.run('bulk',work,options)};}
it('cancels a queued chunk without processing it and closes its physical reader',async()=>{
 const f=await fixture();let release:any;const critical=f.g.run('critical',()=>new Promise(resolve=>release=resolve));await Promise.resolve();const c=new AbortController(),reports:any[]=[];
 const pending=readNamespaceEntries(f.path,{keys:new Set(['key']),signal:c.signal,withReadChunk:f.withReadChunk,onRead:(v:any)=>reports.push(v)});const rejected=expect(pending).rejects.toMatchObject({name:'AbortError'});
 try{await vi.waitFor(()=>expect(f.g.snapshot().queuedBulk).toBe(1));c.abort();await rejected;expect(reports).toMatchObject([{bytesRead:0,complete:false}]);}
 finally{release();await critical;await f.g.drain();}
 expect(f.g.snapshot()).toMatchObject({activeCritical:0,activeBulk:false,queued:0,signalSubscriptions:0});
});
it('rejects file replacement while a chunk waits and allows a fresh full read afterward',async()=>{
 const f=await fixture();let release:any;const critical=f.g.run('critical',()=>new Promise(resolve=>release=resolve));await Promise.resolve();
 const reading=readNamespaceEntries(f.path,{keys:new Set(['key']),withReadChunk:f.withReadChunk});const rejected=expect(reading).rejects.toMatchObject({code:'state_namespace_changed'});
 await vi.waitFor(()=>expect(f.g.snapshot().queuedBulk).toBe(1));await writeFile(join(f.dir,'next'),'{"key":2}');await rename(join(f.dir,'next'),f.path);release();await critical;await rejected;await f.g.drain();
 const fresh=await readNamespaceEntries(f.path,{keys:new Set(['key']),withReadChunk:f.withReadChunk});expect(fresh.values.get('key')).toBe(2);
});
it('still rejects malformed unselected data after chunk admission',async()=>{
 const f=await fixture('{"key":1,"unselected":NaN}');await expect(readNamespaceEntries(f.path,{keys:new Set(['key']),withReadChunk:f.withReadChunk})).rejects.toMatchObject({code:'state_namespace_corrupt'});await f.g.drain();expect(f.g.snapshot().activeBulk).toBe(false);
});
it('rejects an invalid chunk coordinator before opening a missing file',async()=>{await expect(readNamespaceEntries('/synthetic/not-present',{withReadChunk:1})).rejects.toMatchObject({code:'state_namespace_chunk_coordinator_invalid'});});
