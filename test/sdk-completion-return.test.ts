import {afterEach,expect,it,vi} from 'vitest';
import {StateKV} from '../src/state/kv.js';
afterEach(()=>vi.unstubAllEnvs());
function fixture(){
 vi.stubEnv('AGENTMEMORY_STATE_STORE_PATH','/synthetic-sdk-completion-only');
 const rows=new Map<string,unknown>();
 const sdk={trigger:vi.fn(async({function_id,payload}:any)=>{
  const key=payload.scope+'/'+payload.key;
  if(function_id==='state::set'){rows.set(key,payload.value);return payload.value;}
  if(function_id==='state::get')return rows.get(key);
  throw Error('unexpected_sdk_call');
 })};
 return {kv:new StateKV(sdk as never),sdk,rows};
}
it('defaults ordinary file-backed work to explicit SDK completion, never a disk proof',async()=>{
 const {kv}=fixture();
 expect(kv.durability?.snapshot()).toMatchObject({completion:'sdk'});
 await kv.set('synthetic','item',{kept:true});
 expect(await kv.durability!.waitForKeys(kv,[{scope:'synthetic',key:'item'}])).toMatchObject({completed:true,completion:'sdk',synced:false,mutationFailures:0});
});
it('preserves a rejected SDK mutation instead of converting a new wait into success',async()=>{
 const {kv,sdk}=fixture();
 expect(kv.durability?.snapshot()).toMatchObject({completion:'sdk'});
 sdk.trigger.mockRejectedValueOnce(Error('synthetic SDK error'));
 await expect(kv.set('synthetic','item',1)).rejects.toThrow();
 await expect(kv.durability!.wait(kv)).rejects.toMatchObject({code:'SDK_MUTATION_UNCERTAIN'});
 expect(kv.mutationOutcomeUncertain).toBe(true);
});
it('compares pinned SDK expectations and never treats a mismatch as storage completion',async()=>{
 const {kv}=fixture();await kv.set('synthetic','item',{n:2});
 await expect(kv.durability!.waitForKeys(kv,[{scope:'synthetic',key:'item'}],{expectedValues:[{n:1}]})).rejects.toMatchObject({diagnostics:{errorCode:'STATE_EXPECTATION_CHANGED'}});
 expect(await kv.get('synthetic','item')).toEqual({n:2});
 expect(kv.durability!.snapshot()).toMatchObject({sdkCompletion:{failed:1,completed:0}});
});
it('retains timed-out in-flight mutations for drain and rejects writes after freeze',async()=>{
 const {createStateDurabilityFence}=await import('../src/ops/state-durability.mjs');
 vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']});
 try{
  const fence=createStateDurabilityFence({storePath:'/synthetic',completion:'sdk',timeoutMs:20});let release!:()=>void;
  const mutation=fence.mutate('s','a',()=>new Promise<void>(r=>release=r));
  const pending=fence.waitForKeys({get:async()=>1},[{scope:'s',key:'a'}]).catch(error=>error);
  await vi.advanceTimersByTimeAsync(25);expect(await pending).toMatchObject({code:'STATE_DURABILITY_TIMEOUT'});
  expect(fence.snapshot().activeMutations).toBe(1);let drained=false;const drain=fence.drain().then(()=>{drained=true;});
  await Promise.resolve();expect(drained).toBe(false);release();await mutation;await drain;
  fence.freeze();await expect(fence.mutate('s','b',async()=>{})).rejects.toMatchObject({code:'STATE_FROZEN'});
 }finally{vi.useRealTimers();}
});
