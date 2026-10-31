import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,writeFile,rm,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createObservationReader} from '../src/ops/observation-pages.mjs';
const dirs:string[]=[];afterEach(async()=>{vi.restoreAllMocks();for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'am-body-flight-'));dirs.push(dir);const scope='mem:obs:synthetic',file=join(dir,encodeURIComponent(scope)+'.bin');
 const rows={one:{id:'one',narrative:'synthetic',sourceRaw:{text:'original'}}};await writeFile(file,JSON.stringify(rows));
 let chunks=0,release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const kv:any={get:async(_scope:string,key:string)=>structuredClone((rows as any)[key]??null),durability:{withBulkRead:async(work:any,options:any)=>{chunks++;await gate;options?.signal?.throwIfAborted();return work();}}};
 return {dir,scope,file,rows,reader:createObservationReader({storePath:dir,kv}),chunks:()=>chunks,release};
}
it('shares concurrent body disk work while returning independent mutable nested rows',async()=>{
 const f=await fixture(),a=f.reader.list<any>(f.scope),b=f.reader.list<any>(f.scope);
 await vi.waitFor(()=>expect(f.chunks()).toBeGreaterThan(0));f.release();const [x,y]=await Promise.all([a,b]);
 expect(f.chunks()).toBe(1);expect(x).toEqual(y);expect(x).not.toBe(y);expect(x[0]).not.toBe(y[0]);x[0].sourceRaw.text='changed';expect(y[0].sourceRaw.text).toBe('original');
 await f.reader.list(f.scope);expect(f.chunks()).toBe(2);
});
it('one cancelled consumer does not abort the remaining real read',async()=>{
 const f=await fixture(),c=new AbortController();const a=f.reader.list(f.scope,{signal:c.signal});const settled=expect(a).rejects.toMatchObject({name:'AbortError'});const b=f.reader.list(f.scope);
 await vi.waitFor(()=>expect(f.chunks()).toBeGreaterThan(0));c.abort();f.release();await settled;expect(await b).toEqual(Object.values(f.rows));expect(f.chunks()).toBe(1);
});
it('all cancelled consumers release the flight and allow a fresh read',async()=>{
 const f=await fixture(),a=new AbortController(),b=new AbortController();const p=f.reader.list(f.scope,{signal:a.signal}),q=f.reader.list(f.scope,{signal:b.signal});
 const done=Promise.allSettled([p,q]);await vi.waitFor(()=>expect(f.chunks()).toBeGreaterThan(0));a.abort();b.abort();f.release();expect((await done).every(x=>x.status==='rejected')).toBe(true);
 expect(await f.reader.list(f.scope)).toEqual(Object.values(f.rows));expect(f.chunks()).toBe(2);
});
it('never combines different file generations or consistency modes',async()=>{
 const f=await fixture(),a=f.reader.list(f.scope,{consistency:'opened-generation'});await vi.waitFor(()=>expect(f.chunks()).toBe(1));
 await writeFile(f.file+'.next',JSON.stringify({two:{id:'two'}}));await rename(f.file+'.next',f.file);const b=f.reader.list(f.scope);f.release();
 expect(await a).toEqual(Object.values(f.rows));expect(await b).toEqual([{id:'two'}]);expect(f.chunks()).toBe(2);
});
it('propagates shared corruption and removes failed work before retry',async()=>{
 const f=await fixture();await writeFile(f.file,'{"broken":wat}');const done=Promise.allSettled([f.reader.list(f.scope),f.reader.list(f.scope)]);
 await vi.waitFor(()=>expect(f.chunks()).toBeGreaterThan(0));f.release();expect((await done).every(x=>x.status==='rejected')).toBe(true);expect(f.chunks()).toBe(1);
 await writeFile(f.file,JSON.stringify(f.rows));expect(await f.reader.list(f.scope)).toEqual(Object.values(f.rows));expect(f.chunks()).toBe(2);
});
it('keeps consistency modes separate for the same unchanged inode',async()=>{
 const f=await fixture(),a=f.reader.list(f.scope),b=f.reader.list(f.scope,{consistency:'opened-generation'});
 await vi.waitFor(()=>expect(f.chunks()).toBe(2));f.release();expect(await a).toEqual(await b);
});
it('does not admit an unbounded number of joined body copies',async()=>{
 const f=await fixture(),calls=Array.from({length:5},()=>f.reader.list(f.scope));await vi.waitFor(()=>expect(f.chunks()).toBe(4));f.release();const rows=await Promise.all(calls);
 expect(f.chunks()).toBe(4);for(let i=1;i<rows.length;i++){expect(rows[i]).toEqual(rows[0]);expect(rows[i][0]).not.toBe(rows[0][0]);}
});
it('does not join a body read after the mutation revision changes',async()=>{
 const f=await fixture(),a=f.reader.list(f.scope);await vi.waitFor(()=>expect(f.chunks()).toBe(1));const finish=f.reader.beginMutation(f.scope);finish();
 const b=f.reader.list(f.scope);await vi.waitFor(()=>expect(f.chunks()).toBe(2));f.release();expect(await a).toEqual(await b);
});
it('retries a replaced current path once without publishing stale body rows',async()=>{
 const f=await fixture(),a=f.reader.list(f.scope),b=f.reader.list(f.scope);await vi.waitFor(()=>expect(f.chunks()).toBeGreaterThan(0));
 await writeFile(f.file+'.next',JSON.stringify({two:{id:'two',sourceRaw:{text:'new'}}}));await rename(f.file+'.next',f.file);f.release();
 const rows=await Promise.all([a,b]);expect(rows).toEqual([[{id:'two',sourceRaw:{text:'new'}}],[{id:'two',sourceRaw:{text:'new'}}]]);expect(rows[0][0]).not.toBe(rows[1][0]);
});
it('coalesces the real summarizer and enrichment body paths without model calls',async()=>{
 const {registerLongSessionSummarizer}=await import('../src/ops/long-session.mjs');const {registerEnrichmentWorker}=await import('../src/ops/background-enrichment.mjs');const {KV}=await import('../src/state/schema.js');
 const f=await fixture(),session:any={id:'synthetic',startedAt:'2026-01-01T00:00:00Z',status:'active',observationCount:1},data=new Map<string,any>();let bodyCalls=0;
 const kv:any={observationReader:f.reader,get:async(s:string,k:string)=>s===KV.sessions?session:data.get(s+'|'+k)??null,set:async(s:string,k:string,v:any)=>data.set(s+'|'+k,v),update:async()=>{},list:async(s:string)=>{if(s===KV.sessions)return [session];if(s===f.scope){bodyCalls++;return f.reader.list(s);}return [];}};
 const handlers=new Map<string,any>(),sdk:any={registerFunction:(id:string,fn:any)=>handlers.set(id,fn),trigger:vi.fn(async()=>{throw Error('unexpected model');})},logger={info:vi.fn(),warn:vi.fn()},withKeyedLock: any=async(_key:string,work:any)=>work();
 const summarizer=registerLongSessionSummarizer(sdk,kv,{name:'noop'},null,{KV,withKeyedLock,logger,safeAudit:async()=>{},schedule:false});
 const enrich=registerEnrichmentWorker({kv,sdk,KV,withKeyedLock,logger,isGraphEnabled:()=>true,isCompressEnabled:()=>false,readiness:{ensureReady:async()=>false,snapshot:()=>({})},schedule:false});
 try{const a=handlers.get('mem::summarize')({sessionId:'synthetic'}),b=enrich.pump();await vi.waitFor(()=>expect(bodyCalls).toBe(2));f.release();expect(await a).toMatchObject({error:'no_provider',retained:true});await b;expect(f.chunks()).toBe(1);expect(sdk.trigger).not.toHaveBeenCalled();}finally{f.release();await summarizer.stop();await enrich.stop();}
});
it('applies a mutation published during follower cloning independently to both callers',async()=>{
 const f=await fixture(),original=structuredClone;let changed=false;
 const clone=vi.spyOn(globalThis,'structuredClone').mockImplementation(value=>{
  if(!changed){changed=true;f.rows.one={...f.rows.one,sourceRaw:{text:'sdk-new'}};f.reader.record(f.scope,'one',f.rows.one);}
  return original(value);
 });
 try{const a=f.reader.list<any>(f.scope),b=f.reader.list<any>(f.scope);await vi.waitFor(()=>expect(f.chunks()).toBeGreaterThan(0));f.release();const [x,y]=await Promise.all([a,b]);expect(x[0].sourceRaw.text).toBe('sdk-new');expect(y[0].sourceRaw.text).toBe('sdk-new');x[0].sourceRaw.text='caller';expect(y[0].sourceRaw.text).toBe('sdk-new');}finally{clone.mockRestore();}
});
