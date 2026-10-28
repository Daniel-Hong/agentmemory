import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtemp,writeFile,rm,open,rename} from 'node:fs/promises';
import {tmpdir}from'node:os';import{join}from'node:path';
import{createObservationReader}from'../src/ops/observation-pages.mjs';
vi.mock('node:fs/promises',async load=>{const actual=await load<typeof import('node:fs/promises')>();return {...actual,open:vi.fn(actual.open)};});
const dirs:string[]=[];const scope='mem:obs:synthetic-sharing';const original={id:'synthetic',timestamp:'2026-01-01',title:'synthetic',facts:['original'],nested:{value:1}};
const openMock=vi.mocked(open);
beforeEach(()=>{openMock.mockClear();});afterEach(async()=>{vi.unstubAllGlobals();openMock.mockRestore();for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
async function fixture(){const dir=await mkdtemp(join(tmpdir(),'observation-list-sharing-'));dirs.push(dir);const file=join(dir,encodeURIComponent(scope)+'.bin');await writeFile(file,JSON.stringify({synthetic:original}));let current:any=original;const reader=createObservationReader({storePath:dir,kv:{get:async()=>current}as never});return{dir,file,reader,setCurrent:(v:any)=>{current=v;}};}
it('reads one unchanged namespace for six overlapping callers and keeps owner/follower mutations isolated',async()=>{
 const f=await fixture();const calls=Array.from({length:6},()=>f.reader.list(scope));const owner=calls[0].then(rows=>{rows[0].facts.push('owner changed');return rows;});const results=await Promise.all([owner,...calls.slice(1)]);
 expect(openMock).toHaveBeenCalledTimes(1);expect(results[1][0].facts).toEqual(['original']);results[1][0].nested.value=9;expect(results[2][0].nested.value).toBe(1);
 await f.reader.list(scope);expect(openMock).toHaveBeenCalledTimes(2);
});
it('shares a rejected read and releases it before a repaired file is read',async()=>{
 const f=await fixture();await writeFile(f.file,'{"broken":');const results=await Promise.allSettled(Array.from({length:4},()=>f.reader.list(scope)));expect(results.every(r=>r.status==='rejected')).toBe(true);expect(openMock).toHaveBeenCalledTimes(1);
 await writeFile(f.file,JSON.stringify({synthetic:original}));expect((await f.reader.list(scope))[0]).toEqual(original);expect(openMock).toHaveBeenCalledTimes(2);
});
it('does not join different consistency contracts',async()=>{
 const f=await fixture();await Promise.all([f.reader.list(scope),f.reader.list(scope,{consistency:'opened-generation'})]);expect(openMock).toHaveBeenCalledTimes(2);
});
it('does not join across an SDK mutation revision and retains the pending overlay',async()=>{
 const f=await fixture();const realOpen=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');let release:()=>void=()=>{};let opened:()=>void=()=>{};const began=new Promise<void>(r=>opened=r),gate=new Promise<void>(r=>release=r);
 openMock.mockImplementationOnce(async(...args:any[])=>{const h=await (realOpen.open as any)(...args);opened();await gate;return h;});
 const first=f.reader.list(scope);await began;const next={...original,nested:{value:2}};f.setCurrent(next);f.reader.record(scope,'synthetic',next);const second=f.reader.list(scope);release();const results=await Promise.all([first,second]);expect(openMock).toHaveBeenCalledTimes(2);expect(results.map(r=>r[0].nested.value)).toEqual([2,2]);
});
it('rejects all consumers on clone failure and releases the failed job',async()=>{
 const f=await fixture();const clone=globalThis.structuredClone;vi.stubGlobal('structuredClone',()=>{throw Error('synthetic clone failure');});
 const results=await Promise.allSettled([f.reader.list(scope),f.reader.list(scope)]);expect(results.every(r=>r.status==='rejected')).toBe(true);expect(openMock).toHaveBeenCalledTimes(1);
 vi.stubGlobal('structuredClone',clone);expect((await f.reader.list(scope))[0]).toEqual(original);expect(openMock).toHaveBeenCalledTimes(2);
});
it('preserves independent reads beyond eight followers rather than retaining an unlimited group',async()=>{
 const f=await fixture();const results=await Promise.all(Array.from({length:9},()=>f.reader.list(scope)));expect(openMock).toHaveBeenCalledTimes(2);expect(results).toHaveLength(9);expect(results.every(r=>r[0].id==='synthetic')).toBe(true);
});
it('rechecks current-path publication while opened-generation retains the opened file',async()=>{
 const f=await fixture();const actual=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');let release:()=>void=()=>{},began:()=>void=()=>{};const gate=new Promise<void>(r=>release=r),opened=new Promise<void>(r=>began=r);
 openMock.mockImplementation(async(...args:any[])=>{const handle=await (actual.open as any)(...args);const realStat=handle.stat.bind(handle);let first=true;handle.stat=async(...statArgs:any[])=>{const result=await realStat(...statArgs);if(first){first=false;began();await gate;}return result;};return handle;});
 const stable=f.reader.list(scope,{consistency:'opened-generation'});await opened;const replacement={...original,title:'published'};await writeFile(f.file+'.new',JSON.stringify({synthetic:replacement}));await rename(f.file+'.new',f.file);release();
 expect((await stable)[0].title).toBe('synthetic');expect((await f.reader.list(scope))[0].title).toBe('published');
});
it('preserves pending deletes for every joined consumer',async()=>{
 const f=await fixture();f.setCurrent(null);f.reader.record(scope,'synthetic',null,true);const rows=await Promise.all([f.reader.list(scope),f.reader.list(scope)]);expect(rows).toEqual([[],[]]);expect(openMock).toHaveBeenCalledTimes(1);
});
