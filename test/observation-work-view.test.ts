import {afterEach,it,expect,vi} from 'vitest';import {mkdtemp,writeFile,rename,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createObservationReader} from '../src/ops/observation-pages.mjs';
const dirs:string[]=[];afterEach(async()=>{for(const p of dirs.splice(0))await rm(p,{recursive:true,force:true});});
it('reuses complete work metadata across a maintenance round of nine sessions and both consumers',async()=>{
 const f=await fixture(),scopes=Array.from({length:9},(_,i)=>'mem:obs:round'+i);
 for(const scope of scopes)await writeFile(join(f.dir,encodeURIComponent(scope)+'.bin'),JSON.stringify(f.rows));
 const views=[];
 for(const scope of scopes)for(const options of [{kind:'summary'},{kind:'enrichment',compressEnabled:false,inputChars:3200}]){
  views.push(await f.reader.work(scope,options));
 }
 const firstReadChunks=f.chunks();expect(firstReadChunks).toBe(18);
 for(const scope of scopes)for(const options of [{kind:'summary'},{kind:'enrichment',compressEnabled:false,inputChars:3200}]){
  const view=await f.reader.work(scope,options);expect(view.rows.map((r:any)=>r.id)).toEqual(['one']);
  expect(JSON.stringify(view.rows)).not.toContain('private synthetic raw');
 }
 expect(f.chunks()).toBe(firstReadChunks);
});
it('still evicts complete work views under aggregate encoded metadata pressure',async()=>{
 const f=await fixture(),id='x'.repeat(3*1024*1024),payload=JSON.stringify({[id]:{id}});
 const scopes=['mem:obs:budget-a','mem:obs:budget-b','mem:obs:budget-c'];
 for(const scope of scopes){
  await writeFile(join(f.dir,encodeURIComponent(scope)+'.bin'),payload);
  expect((await f.reader.work(scope,{kind:'summary'})).rows).toHaveLength(1);
 }
 const before=f.chunks();expect((await f.reader.work(scopes[0],{kind:'summary'})).rows[0].id.length).toBe(id.length);
 expect(f.chunks()).toBeGreaterThan(before);
},10000);
async function fixture(options:any={}){const dir=await mkdtemp(join(tmpdir(),'am-work-view-'));dirs.push(dir);const scope='mem:obs:synthetic',file=join(dir,encodeURIComponent(scope)+'.bin');const rows:any={one:{id:'one',timestamp:'2026-01-01',type:'decision',importance:9,title:'yes',narrative:'text',sourceRaw:{hookType:'prompt_submit',toolOutput:'private synthetic raw'}}};await writeFile(file,JSON.stringify(rows));let chunks=0;const get=vi.fn(async(_s:string,k:string)=>structuredClone(rows[k]??null));const kv:any={get,durability:{withBulkRead:async(w:any)=>{chunks++;return w();}}};const reader:any=createObservationReader({storePath:dir,kv,...options});return{dir,scope,file,rows,get,reader,chunks:()=>chunks};}
it('reuses a validated work projection without retaining full sources or exposing mutable cache rows',async()=>{const f=await fixture();const a=await f.reader.work(f.scope,{kind:'summary'}),b=await f.reader.work(f.scope,{kind:'summary'});expect(f.chunks()).toBe(1);expect(a.rows).not.toBe(b.rows);expect(JSON.stringify(a.rows)).not.toContain('private synthetic raw');expect(a.rows[0]).toMatchObject({id:'one',type:'decision',importance:8,sourceRaw:{hookType:'prompt_submit'}});expect(Object.isFrozen(a.rows[0])).toBe(true);expect(await a.load(a.rows[0])).toEqual(f.rows.one);});
it('invalidates replacement and preserves pending SDK upserts and deletes over an unchanged disk generation',async()=>{const f=await fixture();await f.reader.work(f.scope,{kind:'summary'});f.rows.two={id:'two',timestamp:'2026-01-02',narrative:'new'};f.reader.record(f.scope,'two',f.rows.two);let v=await f.reader.work(f.scope,{kind:'summary'});expect(v.rows.map((r:any)=>r.id)).toEqual(['one','two']);expect(f.chunks()).toBe(1);delete f.rows.one;f.reader.record(f.scope,'one',null,true);v=await f.reader.work(f.scope,{kind:'summary'});expect(v.rows.map((r:any)=>r.id)).toEqual(['two']);await writeFile(f.file+'.next',JSON.stringify({three:{id:'three'}}));await rename(f.file+'.next',f.file);expect((await f.reader.work(f.scope,{kind:'summary'})).rows.map((r:any)=>r.id)).toEqual(['three','two']);expect(f.chunks()).toBe(2);});
it('refuses missing or changed selected rows and unverified contexts without certifying completion',async()=>{let context:any={};const f=await fixture({workContext:()=>context});const view=await f.reader.work(f.scope,{kind:'summary'});f.rows.one.narrative='changed';await expect(view.load(view.rows[0])).rejects.toMatchObject({code:'observation_work_source_changed'});delete f.rows.one;await expect(view.load(view.rows[0])).rejects.toMatchObject({code:'observation_work_source_changed'});context=null;await expect(f.reader.work(f.scope,{kind:'summary'})).rejects.toMatchObject({code:'observation_work_context_unverified'});context={};await f.reader.work(f.scope,{kind:'summary'});expect(f.chunks()).toBe(2);});
it('cache overflow keeps the full projection available uncached instead of dropping work',async()=>{const f=await fixture({workCacheBytes:1});for(let i=0;i<2;i++)expect((await f.reader.work(f.scope,{kind:'summary'})).rows).toHaveLength(1);expect(f.chunks()).toBe(2);});
it('keeps graph projection fingerprints bound to settings and exact current content',async()=>{const f=await fixture();f.rows.one.narrative='x'.repeat(2500);await writeFile(f.file,JSON.stringify(f.rows));const a=await f.reader.work(f.scope,{kind:'enrichment',compressEnabled:false,inputChars:3200}),b=await f.reader.work(f.scope,{kind:'enrichment',compressEnabled:false,inputChars:200});expect(a.rows[0]._workGraphFingerprint).not.toBe(b.rows[0]._workGraphFingerprint);expect(a.rows[0]._workGraphChars).toBeGreaterThan(b.rows[0]._workGraphChars);expect(f.chunks()).toBe(2);});
it('refuses an aborted caller and does not keep an aborted complete value as raw cache',async()=>{const f=await fixture();const c=new AbortController();c.abort();await expect(f.reader.work(f.scope,{kind:'summary',signal:c.signal})).rejects.toMatchObject({name:'AbortError'});expect(f.chunks()).toBe(0);const view=await f.reader.work(f.scope,{kind:'summary',signal:new AbortController().signal});expect(view.rows).toHaveLength(1);});
it('rejects a new mutation or epoch that arrives during the final file stat',async()=>{
 const {createObservationWorkReader}=await import('../src/ops/observation-work.mjs');const {stat}=await import('node:fs/promises');
 for(const change of ['mutation','context']){
  const f=await fixture();let revision=0,token:any={},calls=0,release:any,entered:any;
  const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
  const work=createObservationWorkReader({storePath:f.dir,kv:{get:f.get},bulkRead:(fn:any)=>fn(),pending:new Map(),mutationRevision:()=>revision,pendingMutations:()=>0,context:()=>token,
   fileRevision:async()=>{const s=await stat(f.file,{bigint:true});if(++calls===3){entered();await gate;}return[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');}});
  const pending=work(f.scope,{kind:'summary'});await ready;if(change==='mutation')revision++;else token={};release();await expect(pending).rejects.toMatchObject({code:'observation_work_source_changed'});
 }
});
it('retains every ID over cache overflow, concurrent misses, deletion and corrupt publication retry',async()=>{
 const f=await fixture({workCacheBytes:512});for(let i=0;i<40;i++)f.rows['id'+i]={id:'id'+i,narrative:'raw '+i};await writeFile(f.file,JSON.stringify(f.rows));
 const views=await Promise.all([f.reader.work(f.scope,{kind:'summary'}),f.reader.work(f.scope,{kind:'summary'})]);for(const v of views)expect(v.rows).toHaveLength(41);
 await writeFile(f.file,'{"broken":');await expect(f.reader.work(f.scope,{kind:'summary'})).rejects.toHaveProperty('code','state_namespace_incomplete');
 await writeFile(f.file,JSON.stringify(f.rows));expect((await f.reader.work(f.scope,{kind:'summary'})).rows).toHaveLength(41);
});
it('binds the actual StateKV work path to an admitted lease and invalidates it when the SDK peer epoch is lost',async()=>{
 const {StateKV}=await import('../src/state/kv.js'),{acquireFileWriterLease}=await import('../src/ops/file-writer-lease.mjs'),{engineFixture}=await import('./helpers/engine-evidence.js');
 const f=await fixture();vi.stubEnv('AGENTMEMORY_STATE_STORE_PATH',f.dir);let current=true;const {evidence}=engineFixture(f.dir),lease=acquireFileWriterLease(f.dir,{evidence:{...evidence,current:()=>current}});
 const sdk:any={trigger:vi.fn(async()=>f.rows.one)},durability:any={withBulkRead:async(fn:any)=>fn()};
 try{
  const unbound=new StateKV(sdk,{durability});await expect(unbound.observationReader!.work(f.scope,{kind:'summary'})).rejects.toMatchObject({code:'observation_work_context_unverified'});
  const bound=new StateKV(sdk,{writerLease:lease,durability});expect((await bound.observationReader!.work(f.scope,{kind:'summary'})).rows).toHaveLength(1);current=false;
  await expect(bound.observationReader!.work(f.scope,{kind:'summary'})).rejects.toMatchObject({code:'observation_work_context_unverified'});expect(sdk.trigger).not.toHaveBeenCalled();
 }finally{lease.close();vi.unstubAllEnvs();}
});
it('cancels an in-progress scan without admitting a partial metadata set',async()=>{
 const f=await fixture();const c=new AbortController();let first=true;const reader=createObservationReader({storePath:f.dir,kv:{get:f.get,durability:{withBulkRead:async(fn:any)=>{if(first){first=false;c.abort();}return fn();}}} as any});
 await expect(reader.work(f.scope,{kind:'summary',signal:c.signal})).rejects.toMatchObject({name:'AbortError'});expect((await reader.work(f.scope,{kind:'summary'})).rows).toHaveLength(1);
});
it('cancels overlay hydration and selected hydration without returning an unchecked row',async()=>{
 const f=await fixture();const overlayAbort=new AbortController();await f.reader.work(f.scope,{kind:'summary'});f.rows.two={id:'two'};f.reader.record(f.scope,'two',f.rows.two);f.get.mockImplementation(async(_s:string,key:string)=>{overlayAbort.abort();return structuredClone(f.rows[key]);});
 await expect(f.reader.work(f.scope,{kind:'summary',signal:overlayAbort.signal})).rejects.toMatchObject({name:'AbortError'});
 const loadAbort=new AbortController();f.get.mockImplementation(async(_s:string,key:string)=>structuredClone(f.rows[key]));const view=await f.reader.work(f.scope,{kind:'summary',signal:loadAbort.signal});
 f.get.mockImplementation(async(_s:string,key:string)=>{loadAbort.abort();return structuredClone(f.rows[key]);});await expect(view.load(view.rows[0])).rejects.toMatchObject({name:'AbortError'});
});
it('does not accumulate phantom retained bytes when admitted same-key cache misses finish concurrently',async()=>{
 const f=await fixture();delete f.rows.one;const id='x'.repeat(256*1024);f.rows[id]={id,narrative:'synthetic'};await writeFile(f.file,JSON.stringify(f.rows));
 await Promise.all(Array.from({length:36},()=>f.reader.work(f.scope,{kind:'summary'})));
 const other='mem:obs:other';await writeFile(join(f.dir,encodeURIComponent(other)+'.bin'),JSON.stringify({other:{id:'other'}}));await f.reader.work(other,{kind:'summary'});const before=f.chunks();
 expect((await f.reader.work(f.scope,{kind:'summary'})).rows).toHaveLength(1);expect(f.chunks()).toBe(before);
});
it('releases published overlay metadata without losing a later upsert or tombstone',async()=>{
 const {createObservationWorkReader,observationWorkHash}=await import('../src/ops/observation-work.mjs'),{stat}=await import('node:fs/promises');const f=await fixture();
 const pending=new Map([[f.scope,new Map<string,any>([['one',{fingerprint:observationWorkHash(f.rows.one)}],['deleted',null]])]]);
 const work=createObservationWorkReader({storePath:f.dir,kv:{get:f.get},bulkRead:(fn:any)=>fn(),pending,mutationRevision:()=>0,pendingMutations:()=>0,fileRevision:async()=>{const s=await stat(f.file,{bigint:true});return[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');}});
 expect((await work(f.scope,{kind:'summary'})).rows).toHaveLength(1);expect(pending.size).toBe(0);
});
it('admits fresh-store read projections without granting historical recovery or altering a dirty marker',async()=>{
 const {StateKV}=await import('../src/state/kv.js'),m=await import('../src/ops/file-writer-lease.mjs'),{engineFixture}=await import('./helpers/engine-evidence.js');const {readFile,unlink}=await import('node:fs/promises');
 const f=await fixture();vi.stubEnv('AGENTMEMORY_STATE_STORE_PATH',f.dir);let current=true;const {evidence}=engineFixture(f.dir);await unlink(join(f.dir,'.agentmemory-writer.lock'));const lease=m.acquireFileWriterLease(f.dir,{evidence:{...evidence,current:()=>current}}),before=await readFile(join(f.dir,'.agentmemory-writer.lock'),'utf8');
 try{expect(m.fileWriterRecoveryAdmitted(lease)).toBe(false);expect(m.fileWriterReadCurrent(lease)).toBe(true);const kv=new StateKV({trigger:vi.fn()} as any,{writerLease:lease,durability:{withBulkRead:async(fn:any)=>fn()} as any});expect((await kv.observationReader!.work(f.scope,{kind:'summary'})).rows).toHaveLength(1);expect(kv.recoveryMutationSafe).toBe(false);expect(()=>m.markFileWriterClean(lease)).toThrow('WRITER_EPOCH_UNVERIFIED');expect(await readFile(join(f.dir,'.agentmemory-writer.lock'),'utf8')).toBe(before);current=false;expect(m.fileWriterReadCurrent(lease)).toBe(false);await expect(kv.observationReader!.work(f.scope,{kind:'summary'})).rejects.toMatchObject({code:'observation_work_context_unverified'});}finally{lease.close();vi.unstubAllEnvs();}
});
