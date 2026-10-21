import {it,expect} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createStateDurabilityFence} from '../src/ops/state-durability.mjs';
it('never certifies a superseding B when a receipt requires the exact A snapshot',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am-pinned-'));try{
  await writeFile(join(dir,'s.bin'),'{"x":{"value":"B"}}');
  const fence=createStateDurabilityFence({storePath:dir,timeoutMs:40,pollIntervalMs:1});let calls=0;
  const kv={get:async()=>{if(++calls===1){await fence.mutate('s','x',async()=>{});return {value:'A'};}return {value:'B'};}};
  await expect(fence.waitForKeys(kv,[{scope:'s',key:'x'}],{expectedValues:[{value:'A'}]})).rejects.toThrow();
 }finally{await rm(dir,{recursive:true,force:true});}
});
it('can shorten a verification deadline without increasing the configured 15 second budget',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am-pinned-deadline-'));try{
  await writeFile(join(dir,'s.bin'),'{"x":1}');const fence=createStateDurabilityFence({storePath:dir,timeoutMs:1000});
  await expect(fence.waitForKeys({get:async()=>1},[{scope:'s',key:'x'}],{deadline:Date.now()-1})).rejects.toThrow();
 }finally{await rm(dir,{recursive:true,force:true});}
});
it('does not let a mutable SDK object change the pinned disk expectation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am-pinned-reference-'));try{
  await writeFile(join(dir,'s.bin'),'{"x":{"value":"B"}}');
  const fence=createStateDurabilityFence({storePath:dir,timeoutMs:40,pollIntervalMs:1}),shared={value:'A'};
  const kv={get:async()=>{setTimeout(()=>{shared.value='B';},0);return shared;}};
  await expect(fence.waitForKeys(kv,[{scope:'s',key:'x'}],{expectedValues:[{value:'A'}]})).rejects.toThrow();
 }finally{await rm(dir,{recursive:true,force:true});}
});
