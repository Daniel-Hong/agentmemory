import{afterEach,expect,it,vi}from'vitest';import{mkdtemp,writeFile,rm}from'node:fs/promises';import{join}from'node:path';import{tmpdir}from'node:os';import{createObservationReader}from'../src/ops/observation-pages.mjs';import{createStateDurabilityFence}from'../src/ops/state-durability.mjs';
const dirs:string[]=[];afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
async function fixture(){const dir=await mkdtemp(join(tmpdir(),'am-list-coord-'));dirs.push(dir);const scope='mem:obs:synthetic',value={id:'k',timestamp:'2026-01-01T00:00:00Z',narrative:'old'};await writeFile(join(dir,encodeURIComponent(scope)+'.bin'),JSON.stringify({k:value}));return{dir,scope,value};}
it('wraps both raw bulk paths and releases their leases before overlay SDK reads',async()=>{
 const{dir,scope,value}=await fixture();let bulk=0,held=false,gets=0;const next={...value,narrative:'new'};
 const kv={durability:{withBulkRead:async(work:any)=>{bulk++;held=true;try{return await work();}finally{held=false;}}},get:async()=>{expect(held).toBe(false);gets++;return next;}};
 const reader=createObservationReader({storePath:dir,kv});reader.record(scope,'k',next);expect((await reader.list(scope))[0]).toEqual(next);await reader.captureSummary(scope);expect(bulk).toBe(2);expect(gets).toBe(1);
});
it('atomically keeps simultaneous full list work behind a held certificate capture',async()=>{
 const{dir,scope,value}=await fixture();const fence=createStateDurabilityFence({storePath:dir});let release:any,gets=0,listFinished=false;
 const kv={durability:fence,get:async()=>{gets++;return new Promise(resolve=>release=()=>resolve(value));}};const reader=createObservationReader({storePath:dir,kv});
 const list=reader.list(scope).then((v:any)=>{listFinished=true;return v;});const proof=fence.waitForKeys(kv,[{scope,key:'k'}]);await vi.waitFor(()=>expect(gets).toBe(1));
 try{expect(listFinished).toBe(false);expect(fence.snapshot().readCoordination).toMatchObject({activeCritical:1,activeBulk:false,queuedBulk:1});}
 finally{release();await proof;await list;await fence.drain();}
 expect(listFinished).toBe(true);expect(fence.snapshot().measurements.totals.failed).toBe(0);
});
