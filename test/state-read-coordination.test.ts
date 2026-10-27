import{afterEach,expect,it}from'vitest';import{mkdtemp,writeFile,rm}from'node:fs/promises';import{join}from'node:path';import{tmpdir}from'node:os';import{createStateDurabilityFence}from'../src/ops/state-durability.mjs';
const dirs:string[]=[];afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});const turn=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
async function fixture(timeoutMs=15000){const dir=await mkdtemp(join(tmpdir(),'am-coord-fence-'));dirs.push(dir);await writeFile(join(dir,'scope.bin'),'{"key":1}');const fence=createStateDurabilityFence({storePath:dir,timeoutMs,pollIntervalMs:1});return{fence,kv:{get:async()=>1}};}
it('accounts a blocked admission in the original deadline without fetching, forgetting dirty keys or mutating failure budgets',async()=>{
 const {fence,kv}=await fixture(15);expect(fence.withBulkRead).toBeTypeOf('function');let release:any,gets=0;const bulk=fence.withBulkRead(()=>new Promise(resolve=>release=resolve));await turn();await fence.mutate('scope','key',async()=>{});
 const pending=fence.waitForKeys({get:async()=>{gets++;return kv.get();}},[{scope:'scope',key:'key'}]);
 try{await expect(pending).rejects.toMatchObject({code:'STATE_DURABILITY_TIMEOUT'});expect(gets).toBe(0);expect(fence.keys()).toHaveLength(1);expect(fence.snapshot().mutationFailures).toBe(0);expect(fence.snapshot().measurements.totals).toMatchObject({completed:1,failed:1,failedStages:{admission:1}});}
 finally{release();await bulk;await fence.drain();}
 await expect(fence.waitForKeys(kv,[{scope:'scope',key:'key'}])).resolves.toMatchObject({synced:true});
});
it('keeps grouped certificates shared and grants bulk only after their proofs finish',async()=>{
 const {fence,kv}=await fixture();expect(fence.withBulkRead).toBeTypeOf('function');let bulkRan=false,allProofsDone=false;
 const proofs=fence.waitForKeyGroups(kv,Array.from({length:5},()=>[{scope:'scope',key:'key'}])).then((r:any)=>{allProofsDone=true;return r;});
 const bulk=fence.withBulkRead(async()=>{bulkRan=true;expect(fence.snapshot().readSharing.activeReads).toBe(0);});
 const results=await proofs;await bulk;expect(results.every((r:any)=>r.status==='fulfilled'&&r.value.synced)).toBe(true);expect(allProofsDone&&bulkRan).toBe(true);expect(fence.snapshot().readSharing.startedReads).toBe(1);await fence.drain();
});
