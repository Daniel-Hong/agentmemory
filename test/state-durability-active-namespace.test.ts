import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rename, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const hooks=vi.hoisted(()=>({reads:0,onDirectorySync:null as null|(()=>Promise<void>),onRead:null as null|(()=>Promise<void>),slowRead:false}));
vi.mock('node:fs/promises',async importOriginal=>{
 const actual=await importOriginal<typeof import('node:fs/promises')>();
 return {...actual,open:async(...args:Parameters<typeof actual.open>)=>{
  const handle=await actual.open(...args),sync=handle.sync.bind(handle),read=handle.createReadStream.bind(handle);
  handle.createReadStream=(options:any)=>{hooks.reads++;const stream=read(options);if(hooks.slowRead||hooks.onRead){const iterator=stream[Symbol.asyncIterator].bind(stream);stream[Symbol.asyncIterator]=async function*(){await hooks.onRead?.();for await(const chunk of {[Symbol.asyncIterator]:iterator}){if(hooks.slowRead)await new Promise(resolve=>setTimeout(resolve,40));yield chunk;}};}return stream;};
  handle.sync=async()=>{if(!String(args[0]).endsWith('.bin'))await hooks.onDirectorySync?.();await sync();};
  return handle;
 }};
});
import { createStateDurabilityFence } from '../src/ops/state-durability.mjs';
const dirs:string[]=[];
afterEach(async()=>{hooks.reads=0;hooks.slowRead=false;hooks.onDirectorySync=null;hooks.onRead=null;await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});
async function fixture(){const dir=await mkdtemp(join(tmpdir(),'am-active-fence-'));dirs.push(dir);const path=join(dir,'synthetic.bin');await writeFile(path,'{"raw":{"sourceRaw":"unchanged"},"other":0}');const fence=createStateDurabilityFence({storePath:dir,timeoutMs:120,pollIntervalMs:5});await fence.mutate('synthetic','raw',async()=>{});return{dir,path,fence,kv:{get:async()=>({sourceRaw:'unchanged'})}};}
it('uses one validated namespace scan and final metadata checks for a disk acknowledgement',async()=>{
 const {fence,kv}=await fixture();expect(await fence.wait(kv)).toMatchObject({synced:true});expect(hooks.reads).toBe(1);expect(fence.keys()).toHaveLength(0);
});
it.each(['rename','inplace','delete'])('retains dirty keys when selected data changes during directory sync by %s',async mode=>{
 const {path,fence,kv}=await fixture();hooks.onDirectorySync=async()=>{if(mode==='rename'){await writeFile(path+'.next','{"raw":{"sourceRaw":"CORRUPT"}}');await rename(path+'.next',path);}else if(mode==='inplace')await writeFile(path,'{"raw":{"sourceRaw":"CORRUPT"}}');else await rm(path,{force:true});};
 await expect(fence.wait(kv)).rejects.toMatchObject({code:'STATE_DURABILITY_TIMEOUT'});expect(fence.keys()).toHaveLength(1);
});
it('does not acknowledge a namespace whose stream finishes after the deadline',async()=>{
 const {kv}=await fixture();hooks.slowRead=true;const slow=createStateDurabilityFence({storePath:dirs[0],timeoutMs:20,pollIntervalMs:5});await slow.mutate('synthetic','raw',async()=>{});
 await expect(slow.wait(kv)).rejects.toMatchObject({code:'STATE_DURABILITY_TIMEOUT'});expect(slow.keys()).toHaveLength(1);expect(slow.snapshot().lastVerification.causeCode).toBe('STATE_READBACK_TIMEOUT');
});
it('retries an atomic unrelated publication and preserves the selected large raw record exactly',async()=>{
 const {dir,path}=await fixture();const raw={sourceRaw:'가😀\\" synthetic raw '.repeat(4096)};
 const rows={raw,...Object.fromEntries(Array.from({length:16},(_,i)=>['other'+i,{sourceRaw:'s'.repeat(64*1024)}]))};
 await writeFile(path,JSON.stringify(rows));
 await writeFile(path+'.next',JSON.stringify({...rows,other0:{sourceRaw:'unrelated updated value'}}));
 const fence=createStateDurabilityFence({storePath:dir,timeoutMs:3000,pollIntervalMs:5});await fence.mutate('synthetic','raw',async()=>{});
 const revision=fence.keys()[0].revision;
 // Start the rename only after the reader captured the original file's signature.
 hooks.onRead=async()=>{hooks.onRead=null;expect(fence.keys()[0].revision).toBe(revision);await rename(path+'.next',path);};
 expect(await fence.wait({get:async()=>raw})).toMatchObject({synced:true});
 expect(hooks.reads).toBe(2);expect(fence.keys()).toHaveLength(0);
 expect(JSON.parse(await readFile(path,'utf8')).raw).toEqual(raw);
});

it('retains a selected key touched again during the final sync',async()=>{
 const {fence,kv}=await fixture();hooks.onDirectorySync=async()=>{await fence.mutate('synthetic','raw',async()=>{});};
 expect(await fence.wait(kv)).toMatchObject({synced:true});expect(fence.keys()).toHaveLength(1);
});
it('retains an unpublished selected value after a rejected mutation',async()=>{
 const {fence}=await fixture();await expect(fence.mutate('synthetic','raw',async()=>{throw Error('write_rejected');})).rejects.toThrow('write_rejected');
 await expect(fence.wait({get:async()=>({sourceRaw:'unpublished'})})).rejects.toMatchObject({code:'STATE_DURABILITY_TIMEOUT'});
 expect(fence.keys()).toHaveLength(1);expect(fence.snapshot().mutationFailures).toBe(1);
});
