import{afterEach,expect,it}from'vitest';import{readFileSync}from'node:fs';
import{createBackgroundControl,installBackgroundControl,controlBackgroundFunctions}from'../src/ops/background-control.mjs';
import{registerSessionFinalizeFunction}from'../src/functions/session-finalize.js';
afterEach(()=>installBackgroundControl(null));
it('keeps new finalizer and recovery entrypoints outside paused admission',async()=>{
 let changed=0,recover=0;const functions=new Map<string,any>();let saved:any={paused:true};
 const kv={get:async()=>saved,set:async(_s:any,_k:any,v:any)=>{saved=v;changed++;},durability:{wait:async()=>({synced:true,mutationFailures:0}),waitForKeys:async()=>{}}};
 const control=createBackgroundControl();await control.init(kv);installBackgroundControl(control);const sdk={registerFunction:(id:string,fn:any)=>functions.set(id,fn),trigger:async()=>{recover++;return{};}};controlBackgroundFunctions(sdk);registerSessionFinalizeFunction(sdk as never,{...kv,get:async()=>({})}as never);
 for(const id of['mem::summary-recover','mem::summary-repair','mem::compression-retry'])sdk.registerFunction(id,async()=>{changed++;return{};});
 changed=0;for(const id of['mem::session-finalize','mem::summary-recover','mem::summary-repair','mem::compression-retry'])expect(await functions.get(id)({})).toMatchObject({deferred:true});
 expect(changed).toBe(0);expect(recover).toBe(0);
});
it('uses tracked pause-aware periodic and initial finalizer execution at worker boot',()=>{
 const source=readFileSync(new URL('../src/index.ts',import.meta.url),'utf8');expect(source).toContain('registerBackgroundInterval(lifecycle, runSessionFinalize, FINALIZE_TICK_MS)');expect(source).toContain('trackBoot(backgroundTask(runSessionFinalize)()');expect(source).not.toContain('setInterval(runSessionFinalize, FINALIZE_TICK_MS)');
});
