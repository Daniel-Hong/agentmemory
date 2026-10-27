import{expect,it,vi}from'vitest';import{mkdtemp,writeFile,rm}from'node:fs/promises';import{join}from'node:path';import{tmpdir}from'node:os';
const probe=vi.hoisted(()=>({first:null as null|(()=>void),done:false,announced:false}));
vi.mock('../src/ops/namespace-reader.mjs',async original=>{
 const m=await original<any>();return{...m,readNamespaceEntries:async(path:string,o:any)=>m.readNamespaceEntries(path,o.onEntry?{...o,onProgress:(p:any)=>{o.onProgress?.(p);if(p.readerPhase==='processing'&&!probe.announced){probe.announced=true;probe.first?.();}},onRead:(p:any)=>{probe.done=true;o.onRead?.(p);}}:o)};
});
import{createObservationReader}from'../src/ops/observation-pages.mjs';import{createStateDurabilityFence}from'../src/ops/state-durability.mjs';
it('admits a new certificate between chunks of an already-running full list while retaining complete list and durable proof',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am-read-handoff-'));try{
  const scope='mem:obs:synthetic',value={id:'k',timestamp:'2026-01-01T00:00:00Z',narrative:'x'.repeat(150000)};await writeFile(join(dir,encodeURIComponent(scope)+'.bin'),JSON.stringify({k:value}));const fence=createStateDurabilityFence({storePath:dir});let beforeComplete=false;
  const kv={durability:fence,get:async()=>{beforeComplete=!probe.done;return value;}};const reader=createObservationReader({storePath:dir,kv});
  const first=new Promise<void>(resolve=>probe.first=resolve);const proof=first.then(()=>fence.waitForKeys(kv,[{scope,key:'k'}]));const list=reader.list(scope);const[stored,rows]=await Promise.all([proof,list]);
  expect(stored.synced).toBe(true);expect(rows).toEqual([value]);expect(beforeComplete).toBe(true);await fence.drain();expect(fence.snapshot().readCoordination).toMatchObject({activeCritical:0,activeBulk:false,queued:0});
 }finally{await rm(dir,{recursive:true,force:true});}
});
