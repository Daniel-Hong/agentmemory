import {afterEach,expect,it,vi} from 'vitest';
import {mockKV,mockSdk} from './helpers/mocks.js';
import {KV} from '../src/state/schema.js';
import {registerObserveFunction} from '../src/functions/observe.js';
import {registerCaptureFunctions} from '../src/functions/capture.js';
import {DedupMap} from '../src/functions/dedup.js';
import {createStateDurabilityFence} from '../src/ops/state-durability.mjs';
vi.mock('../src/logger.js',()=>({logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}}));
const clean:(()=>void)[]=[];afterEach(()=>{for(const fn of clean.splice(0))fn();});
function setup(restPort?:number){
 const kv=mockKV(),sdk=mockSdk({looseTrigger:true}),dedup=new DedupMap();
 Object.assign(kv,{backend:'file',durability:createStateDurabilityFence({storePath:'/synthetic-sdk-only',completion:'sdk'})});
 registerObserveFunction(sdk as never,kv as never,dedup);
 const controller=registerCaptureFunctions(sdk as never,kv as never,{restPort});clean.push(()=>{controller.stop();dedup.stop();});
 return {kv,sdk,controller};
}
const payload={hookType:'post_tool_use',sessionId:'synthetic-session',project:'synthetic-project',cwd:'/synthetic',timestamp:'2026-10-27T00:00:00Z',data:{tool_name:'Read',tool_output:'synthetic original'}};
it('retains an SDK-stored original and never replays it or advertises timed durability',async()=>{
 const {kv,sdk,controller}=setup();
 const result=await sdk.trigger('mem::capture',{payload,eventId:'evc_000000000001'}) as any;
 expect(result).toMatchObject({status:'accepted',state:'sdk_completed'});
 const rows=await kv.list<any>(KV.captureInbox);expect(rows).toHaveLength(1);
 expect(rows[0]).toMatchObject({storageCompletion:'sdk',attempts:1,payload:expect.objectContaining({data:payload.data})});
 expect(controller.durability()).toBeNull();
 const before=JSON.stringify(rows);expect(await controller.sweep()).toMatchObject({processed:0});
 expect(JSON.stringify(await kv.list(KV.captureInbox))).toBe(before);
 expect((await controller.status()).inbox).toMatchObject({sdkCompleted:1});
});
it('blocks persisted manual retry work before changing source/history or budget in SDK mode',async()=>{
 const {kv,sdk}=setup();const record={key:'cap_'+'0'.repeat(40),status:'dead',attempts:19,cycleAttempts:3,payload};
 await kv.set(KV.captureInbox,record.key,record);
 const before=JSON.stringify([...kv.store].map(([scope,rows])=>[scope,[...rows]]));
 await expect(sdk.trigger('mem::capture-jobs-start',{requestId:'00000000-0000-4000-8000-000000000001',all:true})).rejects.toThrow('SDK_COMPLETION_ONLY');
 expect(JSON.stringify([...kv.store].map(([scope,rows])=>[scope,[...rows]]))).toBe(before);
});
it('does not settle time-marked managed spool files in SDK mode',async()=>{
 const {kv,sdk,controller}=setup(63000);
 const spool=await import('../src/capture/spool.js');
 const reconcile=vi.spyOn(spool,'reconcileSent');
 await controller.drainLocalSpool();await controller.prune();
 expect(reconcile).not.toHaveBeenCalled();expect(await kv.list(KV.captureEvents('00'))).toHaveLength(0);
 const body=await sdk.trigger('mem::capture-receipt',{key:'cap_'+'0'.repeat(40),digest:'0'.repeat(64)}) as any;
 expect(body.durable).toBe(false);reconcile.mockRestore();
});
it('does not acknowledge source ownership to old 2xx-only senders in SDK mode',async()=>{
 const {captureStatusCode,captureResponseBody}=await import('../src/triggers/api.js');
 for(const result of [
  {status:'accepted',state:'sdk_completed',eventId:'synthetic',observationId:'synthetic',attempts:1},
  {status:'accepted',state:'completed',eventId:'synthetic',observationId:'synthetic',attempts:1},
  {status:'duplicate',state:'completed',eventId:'synthetic',deduplicated:true},
  {status:'duplicate',state:'pending',eventId:'synthetic',deduplicated:true},
 ]){
  expect(captureStatusCode(result as any,'sdk')).toBe(503);
  expect(captureResponseBody(result as any,{bootId:'synthetic',durableAfterMs:1},'sdk')).toMatchObject({completion:'sdk',durable:false,retryable:true,reason:'SDK_COMPLETION_ONLY'});
  expect(captureResponseBody(result as any,null,'sdk')).not.toHaveProperty('bootId');
 }
});
it('keeps automatic recovery unsupported without changing persisted circuit or budgets',async()=>{
 const {kv}=setup();Object.assign(kv,{recoveryMutationSafe:true,recoveryWrite:{}});
 const control={version:1,kind:'control',failures:2,openUntil:Date.now()+60000,enabled:false};
 await kv.set(KV.captureRecovery,'control',control);
 const {createCaptureAutoRecovery}=await import('../src/capture/auto-recovery.js');
 const auto=createCaptureAutoRecovery(kv as never,{enabled:false,writerOwned:()=>true,admitted:()=>true,indexReady:()=>true});
 await auto.initialize();
 expect(auto.snapshot()).toMatchObject({supported:false,admitted:false,blockedReason:'SDK_COMPLETION_ONLY',breakerUntil:control.openUntil});
 expect(await auto.setEnabled(true)).toMatchObject({ok:false,code:'SDK_COMPLETION_ONLY'});
 expect(await kv.get(KV.captureRecovery,'control')).toEqual(control);
});
it('does not migrate, prune or delete audit originals using an SDK-only proof',async()=>{
 const {kv}=setup();await kv.set(KV.audit,'synthetic-original',{id:'synthetic-original',timestamp:'2020-01-01T00:00:00Z',operation:'index_persist'});
 const before=JSON.stringify([...kv.store].map(([scope,rows])=>[scope,[...rows]]));
 const {startAuditMigration,runAuditRetentionSweep}=await import('../src/functions/audit.js');const probe=vi.fn();
 await startAuditMigration(kv as never,{probe});expect(probe).not.toHaveBeenCalled();
 expect(await runAuditRetentionSweep(kv as never,1)).toEqual({droppedMonths:[],droppedRows:0});
 expect(JSON.stringify([...kv.store].map(([scope,rows])=>[scope,[...rows]]))).toBe(before);
});
it('does not migrate or delete legacy index originals on an SDK-only completion',async()=>{
 const {kv}=setup();
 const {VectorIndex}=await import('../src/state/vector-index.js');const {IndexPersistence}=await import('../src/state/index-persistence.js');
 const legacy=new VectorIndex();legacy.add('synthetic','synthetic-session',new Float32Array([1,0]));
 await kv.set(KV.bm25Index,'vectors',legacy.serialize());await kv.set(KV.bm25Index,'data','synthetic retained BM25');
 const before=JSON.stringify([...kv.store].map(([scope,rows])=>[scope,[...rows]]));
 const persistence=new IndexPersistence(kv as never,new VectorIndex());persistence.stop();
 try{const loaded=await persistence.load();expect(loaded.state).toBe('unavailable');expect(loaded.vector?.size).toBe(1);expect(JSON.stringify([...kv.store].map(([scope,rows])=>[scope,[...rows]]))).toBe(before);}
 finally{persistence.stop();}
});
