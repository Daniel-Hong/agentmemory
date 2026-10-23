import {afterEach,expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {readNamespaceEntries} from '../src/ops/namespace-reader.mjs';
const dirs:string[]=[];afterEach(async()=>{for(const p of dirs.splice(0))await rm(p,{recursive:true,force:true});});
async function file(){const d=await mkdtemp(join(tmpdir(),'am-progress-'));dirs.push(d);const p=join(d,'PRIVATE.bin');await writeFile(p,JSON.stringify({PRIVATE_KEY:{secret:'PRIVATE_VALUE'},tail:'x'.repeat(2048)}));return p;}
it('reports only bounded phase timing metadata while retaining exact selected values',async()=>{
 const samples:any[]=[];const result=await readNamespaceEntries(await file(),{keys:new Set(['PRIVATE_KEY']),chunkSize:128,checkIntervalBytes:256,onProgress:(s:any)=>samples.push(s)}as any);
 expect(result.values.get('PRIVATE_KEY')).toEqual({secret:'PRIVATE_VALUE'});
 expect(samples.map(s=>s.readerPhase)).toEqual(expect.arrayContaining(['open','stat','stream','processing','close','complete']));
 expect(samples.at(-1)).toMatchObject({readerPhase:'complete',bytesRead:result.bytesRead});
 expect(JSON.stringify(samples)).not.toContain('PRIVATE');
 for(const s of samples)for(const n of Object.values(s.readerTimings))expect(n).toBeGreaterThanOrEqual(0);
});
it('does not allow sync or async progress observer errors to change validation outcomes',async()=>{
 const p=await file();await expect(readNamespaceEntries(p,{onProgress:()=>{throw Error('PRIVATE');}}as any)).resolves.toMatchObject({entries:2});
 await writeFile(p,'{"bad":');await expect(readNamespaceEntries(p,{onProgress:async()=>{throw Error('PRIVATE');}}as any)).rejects.toMatchObject({code:'state_namespace_incomplete'});
 await new Promise(r=>setImmediate(r));
});
it('reports aborted partial processing as incomplete and still closes the handle',async()=>{
 const c=new AbortController(),samples:any[]=[];
 await expect(readNamespaceEntries(await file(),{chunkSize:128,signal:c.signal,onEntry:()=>c.abort(),onProgress:(s:any)=>samples.push(s)}as any)).rejects.toMatchObject({name:'AbortError'});
 expect(samples.at(-1)).toMatchObject({readerPhase:'complete'});expect(samples.at(-1).bytesRead).toBeGreaterThan(0);
});
it('retains the failed processing phase after cleanup completes',async()=>{
 const p=await file(),samples:any[]=[];await writeFile(p,'{"k":invalid}');
 await expect(readNamespaceEntries(p,{onProgress:(s:any)=>samples.push(s)}as any)).rejects.toMatchObject({code:'state_namespace_corrupt'});
 expect(samples.at(-1)).toMatchObject({readerPhase:'complete',readerFailurePhase:'processing',complete:false});
});
