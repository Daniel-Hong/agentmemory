import {afterEach,expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {writeFileSync,renameSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readNamespaceEntries} from '../src/ops/namespace-reader.mjs';
const dirs:string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})));});
async function fixture(){const dir=await mkdtemp(join(tmpdir(),'am-early-change-'));dirs.push(dir);const path=join(dir,'synthetic.bin');await writeFile(path,JSON.stringify({head:1,payload:'x'.repeat(4*1024*1024)}));return path;}
it.each(['replace','in-place','delete'] as const)('rejects %s while reading before wasting a full large scan',async mode=>{
 const path=await fixture(),metadata:any[]=[];let changed=false;
 await expect(readNamespaceEntries(path,{chunkSize:64*1024,checkIntervalBytes:1024*1024,onEntry:()=>{
  if(changed)return;changed=true;
  if(mode==='replace'){writeFileSync(path+'.next','{"head":2}');renameSync(path+'.next',path);}
  else if(mode==='in-place')writeFileSync(path,JSON.stringify({head:2,payload:'y'.repeat(4*1024*1024)}));
  else unlinkSync(path);
 },onRead:(info:any)=>metadata.push(info)} as any)).rejects.toMatchObject({code:'state_namespace_changed'});
 expect(metadata).toHaveLength(1);expect(metadata[0].complete).toBe(false);expect(metadata[0].bytesRead).toBeLessThanOrEqual(1024*1024);expect(metadata[0].bytesRead).toBeGreaterThan(0);
});
it('keeps default reader behavior and still rejects replacement at final verification',async()=>{
 const path=await fixture(),metadata:any[]=[];let changed=false;
 await expect(readNamespaceEntries(path,{onEntry:()=>{if(!changed){changed=true;writeFileSync(path+'.next','{}');renameSync(path+'.next',path);}},onRead:(x:any)=>metadata.push(x)})).rejects.toMatchObject({code:'state_namespace_changed'});
 expect(metadata[0].bytesRead).toBeGreaterThan(4*1024*1024);
});
it('does not skip syntax validation in unselected entries when early checks are enabled',async()=>{
 const path=await fixture();await writeFile(path,'{"selected":1,"unselected":{"bad":NaN}}');
 await expect(readNamespaceEntries(path,{keys:new Set(['selected']),checkIntervalBytes:1} as any)).rejects.toMatchObject({code:'state_namespace_corrupt'});
});
it('preserves abort and closes the read before returning failure with early checks enabled',async()=>{
 const path=await fixture(),controller=new AbortController();let metadata:any;
 await expect(readNamespaceEntries(path,{checkIntervalBytes:1,chunkSize:64,signal:controller.signal,onEntry:()=>controller.abort(),onRead:(x:any)=>{metadata=x;}} as any)).rejects.toMatchObject({name:'AbortError'});
 expect(metadata.complete).toBe(false);expect(metadata.bytesRead).toBeLessThan(1024*1024);await rm(path);
});
it.each([-1,0.5,NaN,Infinity])('rejects invalid check interval %s before accessing files',async checkIntervalBytes=>{
 await expect(readNamespaceEntries('/synthetic/does-not-exist',{checkIntervalBytes} as any)).rejects.toMatchObject({code:'state_namespace_check_interval_invalid'});
});
it('keeps the file descriptor open for final verification after a stable large scan reaches EOF',async()=>{
 const path=await fixture();
 await expect(readNamespaceEntries(path,{keys:new Set(['head']),checkIntervalBytes:1024*1024} as any)).resolves.toMatchObject({entries:2,values:new Map([['head',1]])});
});
