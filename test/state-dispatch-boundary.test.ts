import {it,expect,vi,afterEach} from 'vitest';
import {pinStateClient} from '../src/ops/state-epoch.mjs';
import {StateKV} from '../src/state/kv.js';
import {createStateDurabilityFence} from '../src/ops/state-durability.mjs';
afterEach(()=>vi.unstubAllEnvs());
const prefix='state::22222222-2222-4222-8222-222222222222::';
it('pre-dispatch rejection does not latch mutation uncertainty or a failed mutation',async()=>{
 vi.stubEnv('AGENTMEMORY_STATE_STORE_PATH','');let current=false;const trigger=vi.fn(async()=>true);const sdk=pinStateClient({trigger} as any,prefix,()=>current);
 const durability=createStateDurabilityFence({storePath:'/synthetic/unused',completion:'sdk'});const kv=new StateKV(sdk,{backend:'file',durability});
 await expect(kv.set('fixture','one',{})).rejects.toThrow('STATE_WRITER_IDENTITY_CHANGED');expect(trigger).not.toHaveBeenCalled();expect(kv.mutationOutcomeUncertain).toBe(false);expect(durability.snapshot().mutationFailures).toBe(0);
 current=true;await kv.set('fixture','two',{});expect(kv.mutationOutcomeUncertain).toBe(false);expect(trigger).toHaveBeenCalledOnce();
});
it.each(['post','transport','forged'])('preserves uncertain latch for %s dispatch failure',async(mode)=>{
 vi.stubEnv('AGENTMEMORY_STATE_STORE_PATH','');let current=true;const sdk=pinStateClient({trigger:async()=>{if(mode==='post'){current=false;return true;}throw Object.assign(Error('STATE_WRITER_IDENTITY_CHANGED'),{dispatched:false,phase:'before_dispatch'});}} as any,prefix,()=>current);
 const durability=createStateDurabilityFence({storePath:'/synthetic/unused',completion:'sdk'});const kv=new StateKV(sdk,{backend:'file',durability});await expect(kv.set('fixture','one',{})).rejects.toThrow();expect(kv.mutationOutcomeUncertain).toBe(true);expect(durability.snapshot().mutationFailures).toBe(1);
});
it('does not clear an existing uncertain outcome when a later precheck rejects',async()=>{
 vi.stubEnv('AGENTMEMORY_STATE_STORE_PATH','');let current=true;const sdk=pinStateClient({trigger:async()=>{current=false;return true;}} as any,prefix,()=>current);
 const durability=createStateDurabilityFence({storePath:'/synthetic/unused',completion:'sdk'});const kv=new StateKV(sdk,{backend:'file',durability});
 await expect(kv.set('fixture','first',{})).rejects.toThrow();await expect(kv.set('fixture','second',{})).rejects.toThrow();
 expect(kv.mutationOutcomeUncertain).toBe(true);expect(durability.snapshot().mutationFailures).toBe(1);
});
