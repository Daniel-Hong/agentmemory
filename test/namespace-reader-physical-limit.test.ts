import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const measured=vi.hoisted(()=>({bytes:0}));
vi.mock('node:fs/promises',async original=>{
 const fs=await original<typeof import('node:fs/promises')>();
 return {...fs,open:async(...args:Parameters<typeof fs.open>)=>{
  const handle=await fs.open(...args),stream=handle.createReadStream.bind(handle);
  handle.createReadStream=(options:any)=>{const result=stream(options);result.on('data',(chunk:Buffer)=>{measured.bytes+=chunk.length;});return result;};return handle;
 }};
});
import {readNamespaceEntries} from '../src/ops/namespace-reader.mjs';
let dir:string;
afterEach(async()=>{if(dir)await rm(dir,{recursive:true,force:true});measured.bytes=0;});
it('does not physically fetch beyond a finite cap when an opened file grows before streaming',async()=>{
 dir=await mkdtemp(join(tmpdir(),'am-physical-cap-'));const path=join(dir,'data');await writeFile(path,'{"key":1}');
 await expect(readNamespaceEntries(path,{keys:new Set(['key']),maxFileBytes:32,chunkSize:1024*1024,onOpen:()=>appendFileSync(path,' '.repeat(1024))})).rejects.toBeDefined();
 expect(measured.bytes).toBeLessThanOrEqual(32);
});
