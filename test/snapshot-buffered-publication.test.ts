import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {snapshotJsonChunks} from '../src/ops/snapshot-json.mjs';
import {publishSnapshotFile} from '../src/ops/snapshot-recovery.mjs';

const observed=vi.hoisted(()=>({sizes:[] as number[],onChunk:null as null|(()=>void)}));
vi.mock('node:fs/promises',async original=>{
 const fs=await original<typeof import('node:fs/promises')>();
 return {...fs,open:async(path:any,...args:any[])=>{
  const file=await fs.open(path,...args as [any]);
  if(!String(path).includes('state.json.')||!String(path).endsWith('.tmp'))return file;
  return {sync:()=>file.sync(),close:()=>file.close(),writeFile:async(content:any,options:any)=>{
   async function* inspect(){for await(const chunk of content){observed.sizes.push(typeof chunk==='string'?Buffer.byteLength(chunk):chunk.byteLength);observed.onChunk?.();yield chunk;}}
   return file.writeFile(inspect(),options);
  }};
 }};
});
const dirs:string[]=[];
async function fixture(){const dir=await mkdtemp(join(tmpdir(),'am-snapshot-buffer-'));dirs.push(dir);await writeFile(join(dir,'state.json'),'previous');return dir;}
afterEach(async()=>{observed.sizes=[];observed.onChunk=null;await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});

it('coalesces tiny snapshot fragments into bounded writes with byte-identical Unicode JSON',async()=>{
 const value={sessions:Array.from({length:700},(_,n)=>({id:`synthetic-${n}`,text:'한😀'.repeat(24)})),observations:{},accessLogs:[]};
 const expected=Buffer.from(JSON.stringify(value,null,2));const dir=await fixture();
 await publishSnapshotFile(dir,'state.json',snapshotJsonChunks(value));
 expect(await readFile(join(dir,'state.json'))).toEqual(expected);
 expect(Math.max(...observed.sizes)).toBeLessThanOrEqual(64*1024);
 expect(observed.sizes.length).toBeLessThanOrEqual(Math.ceil(expected.length/(64*1024))+2);
 expect((await readdir(dir)).sort()).toEqual(['state.json']);
});

it('bounds oversized chunks and preserves UTF-8 boundaries and binary views',async()=>{
 const chunks=['x'.repeat(65535)+'😀한','\ud800','\udc00',Buffer.from([0,255,128]),new DataView(new Uint8Array([1,2,3]).buffer)];
 const expected=Buffer.concat(chunks.map(x=>typeof x==='string'?Buffer.from(x):Buffer.from(x.buffer,x.byteOffset,x.byteLength)));const dir=await fixture();
 await publishSnapshotFile(dir,'state.json',chunks);
 expect(await readFile(join(dir,'state.json'))).toEqual(expected);
 expect(Math.max(...observed.sizes)).toBeLessThanOrEqual(64*1024);
});

it('retains the original and cleans partial buffered output on upstream failure',async()=>{
 const dir=await fixture();let closed=false;const failure=Object.assign(Error('synthetic source failure'),{code:'SYNTHETIC_SOURCE'});
 function* chunks(){try{yield 'a'.repeat(70000);yield 'pending';throw failure;}finally{closed=true;}}
 await expect(publishSnapshotFile(dir,'state.json',chunks())).rejects.toBe(failure);
 expect(closed).toBe(true);expect(await readFile(join(dir,'state.json'),'utf8')).toBe('previous');expect(await readdir(dir)).toEqual(['state.json']);
});

it('honors cancellation at a flush boundary and closes the source without publication',async()=>{
 const dir=await fixture();const controller=new AbortController();let closed=false;
 function* chunks(){try{for(let n=0;n<4;n++)yield 'a'.repeat(40000);}finally{closed=true;}}
 observed.onChunk=()=>controller.abort();
 await expect(publishSnapshotFile(dir,'state.json',chunks(),{signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});
 expect(closed).toBe(true);expect(await readFile(join(dir,'state.json'),'utf8')).toBe('previous');expect(await readdir(dir)).toEqual(['state.json']);
});
