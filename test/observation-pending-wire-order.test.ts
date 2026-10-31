import {afterEach,it,expect,vi} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createObservationReader} from '../src/ops/observation-pages.mjs';
import {observationWorkHash} from '../src/ops/observation-work.mjs';
const dirs:string[]=[];afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
const ordered=(v:any):any=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])])):v;
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'pending-wire-'));dirs.push(dir);const scope='mem:obs:synthetic';
 const original:any={timestamp:'2026-01-01',id:'one',sourceRaw:{z:'retained',a:['first','second']},narrative:'same',title:'synthetic',type:'tool'};
 let sdkValue=ordered(original);const get=vi.fn(async()=>structuredClone(sdkValue));
 const kv:any={get,durability:{withBulkRead:(fn:any)=>fn()}};const reader:any=createObservationReader({storePath:dir,kv});
 const persist=async(v:any)=>writeFile(join(dir,encodeURIComponent(scope)+'.bin'),JSON.stringify(v?{one:v}:{}));await persist(sdkValue);
 return{reader,scope,original,get,persist,setSdk(v:any){sdkValue=v;}};
}
it.each(['work','ids','indexCandidates','list'])('retires semantically persisted pending on %s without warm SDK rereads',async(kind)=>{
 const f=await fixture();f.reader.record(f.scope,'one',f.original);
 const visit=()=>kind==='work'?f.reader.work(f.scope,{kind:'summary'}):f.reader[kind](f.scope);
 await visit();await visit();expect(f.get).not.toHaveBeenCalled();
});
it('accepts reordered SDK selected values but rejects changed nested content and array order',async()=>{
 const f=await fixture();await f.persist(f.original);const view=await f.reader.work(f.scope,{kind:'summary'});
 await expect(view.load(view.rows[0])).resolves.toEqual(ordered(f.original));
 f.setSdk({...ordered(f.original),sourceRaw:{a:['second','first'],z:'retained'}});
 await expect(view.load(view.rows[0])).rejects.toMatchObject({code:'observation_work_source_changed'});
 f.setSdk({...ordered(f.original),sourceRaw:{a:['first','second'],z:'changed'}});
 await expect(view.load(view.rows[0])).rejects.toMatchObject({code:'observation_work_source_changed'});
});
it('does not retire an unpersisted value merely because SDK get succeeds',async()=>{
 const f=await fixture(),changed={...f.original,narrative:'new SDK value'};f.setSdk(ordered(changed));f.reader.record(f.scope,'one',changed);
 const first=await f.reader.work(f.scope,{kind:'summary'});expect((await first.load(first.rows[0])).narrative).toBe('new SDK value');
 f.get.mockClear();await f.reader.work(f.scope,{kind:'summary'});expect(f.get).toHaveBeenCalledTimes(1);
 await f.persist(ordered(changed));f.get.mockClear();await f.reader.work(f.scope,{kind:'summary'});await f.reader.work(f.scope,{kind:'summary'});expect(f.get).not.toHaveBeenCalled();
});
it('retains deletion until disk absence and rejects a concurrent mutation during reconciliation',async()=>{
 const f=await fixture();f.reader.record(f.scope,'one',null,true);expect((await f.reader.work(f.scope,{kind:'summary'})).rows).toEqual([]);await f.persist(null);expect((await f.reader.work(f.scope,{kind:'summary'})).rows).toEqual([]);
 await f.persist(ordered(f.original));const changed={...f.original,narrative:'new'};f.reader.record(f.scope,'one',changed);
 f.get.mockImplementationOnce(async()=>{f.reader.record(f.scope,'one',{...changed,narrative:'concurrent'});return ordered(changed);});
 await expect(f.reader.work(f.scope,{kind:'summary'})).rejects.toMatchObject({code:'observation_work_source_changed'});
});
it('normalizes JSON wire semantics only, preserving arrays and raw string bytes',()=>{
 // SHA-256 of the independently fixed wire string {"a":0,"z":{"a":1,"b":2}}.
 expect(observationWorkHash({z:{b:2,a:1},a:0})).toBe('59d176cd99b72175a563664f429ecec5d1cb31754d7d090b0592bda9b53fc021');
 expect(observationWorkHash({z:{b:2,a:1},a:0})).toBe(observationWorkHash({a:0,z:{a:1,b:2}}));
 expect(observationWorkHash({a:undefined,b:[undefined,NaN]})).toBe(observationWorkHash({b:[null,null]}));
 expect(observationWorkHash({a:new Date('2026-01-01T00:00:00Z')})).toBe(observationWorkHash({a:'2026-01-01T00:00:00.000Z'}));
 expect(observationWorkHash({a:new Number(3)})).toBe(observationWorkHash({a:3}));
 expect(observationWorkHash({a:['x','y']})).not.toBe(observationWorkHash({a:['y','x']}));
 expect(observationWorkHash({raw:'{"a":1,"b":2}'})).not.toBe(observationWorkHash({raw:'{"b":2,"a":1}'}));
 const cycle:any={};cycle.self=cycle;expect(()=>observationWorkHash(cycle)).toThrow();expect(()=>observationWorkHash({n:1n})).toThrow();
 const before=JSON.stringify({z:1,a:2});const obj={z:1,a:2};observationWorkHash(obj);expect(JSON.stringify(obj)).toBe(before);
});
it('preserves a legal __proto__ own JSON field and its nested value',()=>{
 const value=JSON.parse('{"z":1,"__proto__":{"b":2,"a":1}}');
 const reordered=JSON.parse('{"__proto__":{"a":1,"b":2},"z":1}');
 expect(Object.hasOwn(value,'__proto__')).toBe(true);
 expect(observationWorkHash(value)).toBe(observationWorkHash(reordered));
 expect(observationWorkHash(value)).not.toBe(observationWorkHash({z:1}));
 expect(observationWorkHash(value)).not.toBe(observationWorkHash(JSON.parse('{"__proto__":{"a":9,"b":2},"z":1}')));
 expect(Object.hasOwn(value,'__proto__')).toBe(true);
});
it('rejects a delayed old SDK reconciliation response after a newer local write',async()=>{
 const f=await fixture(),first={...f.original,narrative:'first'},newer={...f.original,narrative:'newer'};
 f.reader.record(f.scope,'one',first);
 let release!:(value:any)=>void,entered!:()=>void;
 const gate=new Promise<any>(r=>{release=r;}),ready=new Promise<void>(r=>{entered=r;});
 f.get.mockImplementationOnce(async()=>{entered();return gate;});
 const waiting=expect(f.reader.work(f.scope,{kind:'summary'})).rejects.toMatchObject({code:'observation_work_source_changed'});
 await ready;f.reader.record(f.scope,'one',newer);f.setSdk(ordered(newer));release(ordered(first));await waiting;
 const latest=await f.reader.work(f.scope,{kind:'summary'});
 expect((await latest.load(latest.rows[0])).narrative).toBe('newer');
});
it('rejects a delayed selected-value SDK response after a newer local write completes',async()=>{
 const f=await fixture(),view=await f.reader.work(f.scope,{kind:'summary'});
 let release!:(value:any)=>void,entered!:()=>void;
 const gate=new Promise<any>(r=>{release=r;}),ready=new Promise<void>(r=>{entered=r;});
 f.get.mockImplementationOnce(async()=>{entered();return gate;});
 const waiting=expect(view.load(view.rows[0])).rejects.toMatchObject({code:'observation_work_source_changed'});
 await ready;const newer={...f.original,narrative:'newer'};
 f.reader.record(f.scope,'one',newer);f.setSdk(ordered(newer));release(ordered(f.original));await waiting;
});
