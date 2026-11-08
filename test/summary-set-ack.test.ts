import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StateKV} from '../src/state/kv.js';
const dirs:string[]=[];
afterEach(async()=>{vi.unstubAllEnvs();await Promise.all(dirs.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function fixture(trigger:ReturnType<typeof vi.fn>,compactSummaryWrites=true){
 const root=await mkdtemp(join(tmpdir(),'am-summary-ack-'));dirs.push(root);
 vi.stubEnv('AGENTMEMORY_STATE_STORE_PATH',root);
 await writeFile(join(root,'mem%3Asummaries.bin'),'{}');
 return new StateKV({trigger}as never,{compactSummaryWrites});
}
it('sends a pinned JSON snapshot through compact ack and retains the stored summary projection',async()=>{
 let entered!:()=>void,release!:()=>void;
 const waiting=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);
 const trigger=vi.fn(async(req:any)=>{entered();await held;return true;});
 const kv=await fixture(trigger),value={sessionId:'a',title:'sent',optional:undefined};
 const saving=kv.set('mem:summaries','a',value);await waiting;value.title='changed';release();
 expect(await saving).toEqual({sessionId:'a',title:'sent'});
 expect(trigger).toHaveBeenCalledWith({function_id:'state::set_ack',payload:{scope:'mem:summaries',key:'a',value:{sessionId:'a',title:'sent'}}});
 expect(await kv.getSummaryMetadata()).toMatchObject([{sessionId:'a',title:'sent'}]);
 expect(kv.mutationOutcomeUncertain).toBe(false);
});
it.each([false,null,{}, {new_value:'unexpected'}])('rejects a malformed acknowledgement without certifying a write: %j',async ack=>{
 const kv=await fixture(vi.fn(async()=>ack));
 await expect(kv.set('mem:summaries','a',{sessionId:'a'})).rejects.toMatchObject({code:'STATE_SET_ACK_UNVERIFIED'});
 expect(kv.mutationOutcomeUncertain).toBe(true);
 expect(kv.durability!.snapshot().mutationFailures).toBe(1);
});
it('propagates failed acknowledgement and retains the storage uncertainty latch',async()=>{
 const kv=await fixture(vi.fn(async()=>{throw Object.assign(Error('adapter failed'),{code:'SET_ERROR'});}));
 await expect(kv.set('mem:summaries','a',{sessionId:'a'})).rejects.toMatchObject({code:'SET_ERROR'});
 expect(kv.mutationOutcomeUncertain).toBe(true);
});
it('keeps ordinary namespaces and compatibility-mode summary writes on the existing API',async()=>{
 const trigger=vi.fn(async(req:any)=>({old_value:null,new_value:req.payload.value}));
 const kv=await fixture(trigger);await kv.set('mem:other','a',{kept:true});
 const legacy=await fixture(trigger,false);await legacy.set('mem:summaries','a',{sessionId:'a'});
 expect(trigger.mock.calls.map(([r])=>r.function_id)).toEqual(['state::set','state::set']);
});
it('keeps byte-budgeted summary listing available after compact acknowledgement',async()=>{
 const value={sessionId:'a',title:'kept'};
 const trigger=vi.fn(async(req:any)=>req.function_id==='state::set_ack'?true:[value]);
 const kv=await fixture(trigger);await kv.set('mem:summaries','a',value);
 expect(await kv.list('mem:summaries')).toEqual([value]);
 expect(trigger.mock.calls.map(([req])=>req.function_id)).toEqual(['state::set_ack','state::list']);
});
