import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
const hooks=vi.hoisted(()=>({entered:null as null|(()=>void),gate:null as null|Promise<void>}));
vi.mock('node:fs/promises',async original=>{const actual=await original<typeof import('node:fs/promises')>();return{...actual,open:async(...args:Parameters<typeof actual.open>)=>{const handle=await actual.open(...args),sync=handle.sync.bind(handle);handle.sync=async()=>{if(String(args[0]).endsWith('scope.bin')){hooks.entered?.();await hooks.gate;}return sync();};return handle;}};});
import {createStateDurabilityFence} from '../src/ops/state-durability.mjs';
const dirs:string[]=[];afterEach(async()=>{hooks.entered=null;hooks.gate=null;for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
const deferred=()=>{let resolve!:(v?:any)=>void;const promise=new Promise<any>(r=>resolve=r);return{promise,resolve};};
const turn=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
async function fixture(){const dir=await mkdtemp(join(tmpdir(),'am-cert-drain-'));dirs.push(dir);await writeFile(join(dir,'scope.bin'),'{"k":1}');return createStateDurabilityFence({storePath:dir});}
it('drains a pending certificate capture without retaining physical exclusion',async()=>{
 const fence=await fixture(),entered=deferred(),held=deferred();let drained=false;
 const proof=fence.waitForKeys({get:async()=>{entered.resolve();await held.promise;return 1;}},[{scope:'scope',key:'k'}]);await entered.promise;
 const draining=fence.drain().then(()=>{drained=true;});
 try{await turn();expect(fence.snapshot().readCoordination.activeCritical).toBe(0);expect(drained).toBe(false);}
 finally{held.resolve();await expect(proof).resolves.toMatchObject({synced:true});await draining;}
 expect(drained).toBe(true);
});
it('drains certificate fsync even after the shared physical reader has released its lease',async()=>{
 const fence=await fixture(),entered=deferred(),held=deferred();hooks.entered=()=>entered.resolve();hooks.gate=held.promise;
 const proof=fence.waitForKeys({get:async()=>1},[{scope:'scope',key:'k'}]);await entered.promise;let drained=false;const draining=fence.drain().then(()=>{drained=true;});
 try{await turn();expect(fence.snapshot().readCoordination.activeCritical).toBe(0);expect(drained).toBe(false);}
 finally{held.resolve();await expect(proof).resolves.toMatchObject({synced:true});await draining;}
});
it('fails a drain requested from its own certificate rather than waiting for itself',async()=>{
 const fence=await fixture();const proof=fence.waitForKeys({get:async()=>{await expect(fence.drain()).rejects.toMatchObject({code:'STATE_READ_COORDINATION_REENTRANT'});return 1;}},[{scope:'scope',key:'k'}]);await expect(proof).resolves.toMatchObject({synced:true});await fence.drain();
});
it('rejects a nested certificate from its own SDK capture without leaking the outer proof',async()=>{
 const fence=await fixture();const proof=fence.waitForKeys({get:async()=>{await expect(fence.waitForKeys({get:async()=>1},[{scope:'scope',key:'k'}])).rejects.toMatchObject({code:'STATE_READ_COORDINATION_REENTRANT'});return 1;}},[{scope:'scope',key:'k'}]);await expect(proof).resolves.toMatchObject({synced:true});await fence.drain();
});
