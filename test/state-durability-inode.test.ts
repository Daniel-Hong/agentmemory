import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const hooks=vi.hoisted(()=>({directorySync:null as null|(()=>Promise<void>),synced:[] as string[]}));
vi.mock('node:fs/promises',async importOriginal=>{
 const actual=await importOriginal<typeof import('node:fs/promises')>();
 return {...actual,open:async(...args:Parameters<typeof actual.open>)=>{
  const handle=await actual.open(...args),sync=handle.sync.bind(handle);
  handle.sync=async()=>{if(String(args[0]).endsWith('.bin')) hooks.synced.push(String((await handle.stat({bigint:true})).ino));else await hooks.directorySync?.();await sync();};
  return handle;
 }};
});
import { createStateDurabilityFence } from '../src/ops/state-durability.mjs';
const dirs:string[]=[];
afterEach(async()=>{hooks.directorySync=null;hooks.synced=[];await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});
it('syncs the current inode after identical namespace replacement during directory sync',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am-fence-inode-'));dirs.push(dir);
 const path=join(dir,'synthetic.bin');await writeFile(path,'{"raw":{"sourceRaw":"unchanged"}}');
 const fence=createStateDurabilityFence({storePath:dir,timeoutMs:200,pollIntervalMs:5});
 await fence.mutate('synthetic','raw',async()=>{});
 let replaced=false;hooks.directorySync=async()=>{if(replaced)return;replaced=true;await writeFile(path+'.next','{"raw":{"sourceRaw":"unchanged"}}');await rename(path+'.next',path);};
 expect(await fence.wait({get:async()=>({sourceRaw:'unchanged'})})).toMatchObject({synced:true});
 const current=String((await stat(path,{bigint:true})).ino);
 expect(hooks.synced).toContain(current);expect(fence.keys()).toHaveLength(0);
});
