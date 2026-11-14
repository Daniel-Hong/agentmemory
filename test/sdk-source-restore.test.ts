import {afterEach,expect,it,vi} from 'vitest';
import {mockKV,mockSdk} from './helpers/mocks.js';
import {registerObserveFunction} from '../src/functions/observe.js';import {registerCaptureFunctions,captureKey,observationIdFor} from '../src/functions/capture.js';import {registerApiTriggers} from '../src/triggers/api.js';
import {KV} from '../src/state/schema.js';import {createRecordRecoveryGate} from '../src/state/recovery-write-gate.js';import {createStateDurabilityFence} from '../src/ops/state-durability.mjs';import {DedupMap} from '../src/functions/dedup.js';import {captureEventScope} from '../src/capture/event-record.js';
vi.mock('../src/logger.js',()=>({logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}}));
const clean:(()=>void)[]=[];afterEach(()=>{for(const f of clean.splice(0))f();});
const body={eventId:'synthetic_restore_001',captureCompletion:'sdk-v1',hookType:'post_tool_use',sessionId:'synthetic',project:'synthetic',cwd:'/synthetic',timestamp:'2026-10-27T00:00:00Z',data:{tool_name:'Read',tool_output:'original'}};
function fixture(){
 const kv=mockKV(),sdk=mockSdk({looseTrigger:true}),dedup=new DedupMap(),gate=createRecordRecoveryGate();const set=kv.set.bind(kv),del=kv.delete.bind(kv);
 Object.assign(kv,{backend:'file',recoveryMutationSafe:true,recoveryWrite:gate,durability:createStateDurabilityFence({storePath:'/synthetic-only',completion:'sdk'})});
 kv.set=(scope,key,value)=>gate.read(scope,key,()=>set(scope,key,value));kv.delete=(scope,key)=>gate.read(scope,key,()=>del(scope,key));
 registerObserveFunction(sdk as never,kv as never,dedup);const control=registerCaptureFunctions(sdk as never,kv as never);registerApiTriggers(sdk as never,kv as never,'synthetic-secret');clean.push(()=>{control.stop();dedup.stop();});
 const call=async(b:any=body)=>{const fn=sdk.fns.get('api::capture-restore-sdk');expect(fn).toBeTypeOf('function');return await fn!({body:b,headers:{authorization:'Bearer synthetic-secret'}}) as any;};
 return {kv,sdk,control,call,key:captureKey(body.project,body.sessionId,body.eventId),id:observationIdFor(captureKey(body.project,body.sessionId,body.eventId),body.timestamp,Date.now())};
}
it('restores all-missing selected SDK source and keeps duplicate restoration and originals idempotent',async()=>{
 const f=fixture();await f.kv.set(KV.captureRecovery,'control',{enabled:false,failures:2,openUntil:123});
 const first=await f.call();expect(first).toMatchObject({status_code:201,body:{status:'restored',completion:'sdk',durable:false,completed:true}});
 expect(await f.kv.list(KV.observations(body.sessionId))).toHaveLength(1);expect((await f.kv.get<any>(KV.captureInbox,f.key)).payload.data).toEqual(body.data);
 const second=await f.call();expect(second).toMatchObject({status_code:200,body:{status:'duplicate',completed:true}});expect(await f.kv.list(KV.observations(body.sessionId))).toHaveLength(1);
 expect(await f.kv.get(KV.captureRecovery,'control')).toEqual({enabled:false,failures:2,openUntil:123});
});
it('repairs SDK inbox-only state without spending or resetting existing attempt history',async()=>{
 const f=fixture();await f.sdk.trigger('mem::capture',{payload:body,eventId:body.eventId});const rec=await f.kv.get<any>(KV.captureInbox,f.key);await f.kv.delete(KV.observations(body.sessionId),rec.observationId);
 expect((await f.call()).status_code).toBe(201);expect(await f.kv.get<any>(KV.captureInbox,f.key)).toMatchObject({attempts:rec.attempts,cycleAttempts:rec.cycleAttempts,storageCompletion:'sdk'});
});
it.each(['mismatch','legacy','history','tombstone','writer'])('holds protected/conflicting source without modifying state: %s',async mode=>{
 const f=fixture();await f.sdk.trigger('mem::capture',{payload:body,eventId:body.eventId});await f.kv.delete(KV.observations(body.sessionId),f.id);
 if(mode==='legacy'){const rec=await f.kv.get<any>(KV.captureInbox,f.key);delete rec.storageCompletion;await f.kv.set(KV.captureInbox,f.key,rec);}
 if(mode==='history')await f.kv.set(KV.captureReview,f.key,{status:'dead',totalAttempts:19});
 if(mode==='tombstone')await f.kv.set(captureEventScope(f.key),f.key,{state:'deleted'});
 if(mode==='writer')Object.assign(f.kv,{recoveryMutationSafe:false});
 const before=JSON.stringify([...f.kv.store].map(([s,rows])=>[s,[...rows]]));const response=await f.call(mode==='mismatch'?{...body,data:{tool_output:'different'}}:body);
 expect(response.status_code).toBe(409);expect(response.body.completed).toBe(false);expect(JSON.stringify([...f.kv.store].map(([s,rows])=>[s,[...rows]]))).toBe(before);
});
it('never overwrites a same-ID observation with a conflicting source',async()=>{
 const f=fixture();await f.kv.set(KV.observations(body.sessionId),f.id,{id:f.id,sessionId:body.sessionId,sourceRaw:{raw:{tool_output:'different'}}});const before=await f.kv.get(KV.observations(body.sessionId),f.id);
 expect((await f.call()).status_code).toBe(409);expect(await f.kv.get(KV.observations(body.sessionId),f.id)).toEqual(before);
});
it('preserves original and pending metadata if storage fails and never reports completion',async()=>{
 const f=fixture(),actual=f.kv.set.bind(f.kv);vi.spyOn(f.kv,'set').mockImplementation(async(s,k,v)=>{if(s===KV.observations(body.sessionId))throw Error('synthetic storage failure');return actual(s,k,v);});
 const result=await f.call();expect(result.status_code).not.toBe(201);expect(result.body.completed).toBe(false);expect((await f.kv.get<any>(KV.captureInbox,f.key)).payload.data).toEqual(body.data);
});
it('requires existing authentication and explicit SDK policy',async()=>{
 const f=fixture(),fn=f.sdk.fns.get('api::capture-restore-sdk');expect(fn).toBeTypeOf('function');expect((await fn!({body,headers:{}})as any).status_code).toBe(401);
 expect((await f.call({...body,captureCompletion:undefined})).status_code).toBe(400);
});
it('does not count or overwrite a same-source observation created before the conditional write',async()=>{
 const f=fixture();await f.sdk.trigger('mem::capture',{payload:body,eventId:body.eventId});const original=await f.kv.get<any>(KV.observations(body.sessionId),f.id);await f.kv.delete(KV.observations(body.sessionId),f.id);
 const get=f.kv.get.bind(f.kv);let reads=0;vi.spyOn(f.kv,'get').mockImplementation(async(s,k)=>{const value=await get(s,k);if(s===KV.observations(body.sessionId)&&++reads===2){await f.kv.set(s,k,original);return null;}return value;});
 const result=await f.call();expect(result).toMatchObject({status_code:200,body:{status:'duplicate'}});expect(await f.kv.get(KV.observations(body.sessionId),f.id)).toEqual(original);expect((await f.kv.get<any>(KV.sessions,body.sessionId)).observationCount).toBe(1);
});
it('does not acknowledge completion when observation is deleted before final verification',async()=>{
 const f=fixture(),observe=f.sdk.fns.get('mem::observe')!;f.sdk.fns.set('mem::observe',async input=>{const result=await observe(input);await f.kv.delete(KV.observations(body.sessionId),f.id);return result;});
 const result=await f.call();expect(result.body.completed).toBe(false);expect((await f.kv.get<any>(KV.captureInbox,f.key)).payload.data).toEqual(body.data);
});
it('deduplicates simultaneous explicit source selections without resetting old budgets',async()=>{
 const f=fixture();const values=await Promise.all([f.call(),f.call()]);expect(values.map(v=>v.status_code).sort()).toEqual([200,201]);expect(await f.kv.list(KV.observations(body.sessionId))).toHaveLength(1);expect((await f.kv.get<any>(KV.captureInbox,f.key)).sdkRestoreAttempts).toBe(1);
});
it.each(['history','tombstone','dead'])('never ACKs after a new protected state appears before final check: %s',async mode=>{
 const f=fixture(),observe=f.sdk.fns.get('mem::observe')!;f.sdk.fns.set('mem::observe',async input=>{const result=await observe(input);if(mode==='history')await f.kv.set(KV.captureReview,f.key,{status:'dead',totalAttempts:19});else if(mode==='tombstone')await f.kv.set(captureEventScope(f.key),f.key,{state:'deleted'});else{const rec=await f.kv.get<any>(KV.captureInbox,f.key);await f.kv.set(KV.captureInbox,f.key,{...rec,status:'dead'});}return result;});
 const result=await f.call();expect(result.body.completed).toBe(false);expect((await f.kv.get<any>(KV.captureInbox,f.key)).payload.data).toEqual(body.data);
});
it.each([-1,'2',4,1.5])('holds malformed restoration metadata without resetting it: %s',async attempts=>{
 const f=fixture();await f.sdk.trigger('mem::capture',{payload:body,eventId:body.eventId});const rec=await f.kv.get<any>(KV.captureInbox,f.key);await f.kv.set(KV.captureInbox,f.key,{...rec,sdkRestoreAttempts:attempts});await f.kv.delete(KV.observations(body.sessionId),f.id);
 expect((await f.call()).body.completed).toBe(false);expect((await f.kv.get<any>(KV.captureInbox,f.key)).sdkRestoreAttempts).toBe(attempts);
});
it('retains concurrent SDK restores outside capacity while bounding genuine ordinary pending capture',async()=>{
 vi.stubEnv('AGENTMEMORY_CAPTURE_INBOX_MAX','1');try{
 const f=fixture();const values=await Promise.all([f.call(),f.call({...body,eventId:'synthetic_restore_002'})]);
 expect(values.map(r=>r.status_code)).toEqual([201,201]);
 const retained=await f.kv.list<any>(KV.captureInbox);expect(retained).toHaveLength(2);
 for(const row of retained)expect(row).toMatchObject({storageCompletion:'sdk',sdkRestoreState:'completed',payload:{data:body.data}});
 f.sdk.fns.set('mem::observe',async()=>{throw Error('synthetic ordinary pending');});
 const pending=await f.sdk.trigger('mem::capture',{payload:body,eventId:'synthetic_restore_003'});
 expect(pending).toMatchObject({status:'accepted',state:'retrying'});
 const blocked=await f.sdk.trigger('mem::capture',{payload:body,eventId:'synthetic_restore_004'});
 expect(blocked).toMatchObject({status:'rejected',retryable:true});expect(await f.kv.list(KV.captureInbox)).toHaveLength(3);
 for(const row of retained)expect(await f.kv.get(KV.captureInbox,row.key)).toEqual(row);
 }finally{vi.unstubAllEnvs();}
});
it('records a body-free attempt audit without calling it a durable completion receipt',async()=>{
 const f=fixture();expect((await f.call()).body.completed).toBe(true);const scopes=[...f.kv.store.keys()].filter(s=>s.startsWith('mem:audit:'));
 const entries=scopes.flatMap(s=>[...(f.kv.store.get(s)?.values()??[])]).filter((r:any)=>r.operation==='capture_sdk_source_restore');expect(entries).toHaveLength(1);expect(entries[0]).toMatchObject({details:{completion:'sdk',stage:'verify_pending'}});expect(JSON.stringify(entries)).not.toContain('tool_output');
});
it('drains an interrupted explicit restore and retains its source instead of acknowledging after stop',async()=>{
 const f=fixture(),observe=f.sdk.fns.get('mem::observe')!;let release!:()=>void,entered!:()=>void;const inside=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);f.sdk.fns.set('mem::observe',async data=>{entered();await hold;return observe(data);});
 const request=f.call();await inside;f.control.stop();let drained=false;const drain=f.control.drain().then(()=>drained=true);
 try{await Promise.resolve();await Promise.resolve();expect(drained).toBe(false);}finally{release();}
 expect((await request).body.completed).toBe(false);await drain;expect((await f.kv.get<any>(KV.captureInbox,f.key)).payload.data).toEqual(body.data);
});
it.each([{sdkRestoreAttempts:0},{sdkRestoreRequestId:'00000000-0000-4000-8000-000000000001'},{sdkRestoreState:'pending',sdkRestoreAttempts:0}])('does not repair partial restoration metadata by overwriting it: %j',async metadata=>{
 const f=fixture();await f.sdk.trigger('mem::capture',{payload:body,eventId:body.eventId});const rec=await f.kv.get<any>(KV.captureInbox,f.key);await f.kv.set(KV.captureInbox,f.key,{...rec,...metadata});await f.kv.delete(KV.observations(body.sessionId),f.id);const before=await f.kv.get(KV.captureInbox,f.key);
 expect((await f.call()).body.completed).toBe(false);expect(await f.kv.get(KV.captureInbox,f.key)).toEqual(before);
});
it('does not double-count a restored observation when the session count survived partial storage',async()=>{
 const f=fixture();await f.sdk.trigger('mem::capture',{payload:body,eventId:body.eventId});expect((await f.kv.get<any>(KV.sessions,body.sessionId)).observationCount).toBe(1);await f.kv.delete(KV.observations(body.sessionId),f.id);expect((await f.call()).body.completed).toBe(true);expect((await f.kv.get<any>(KV.sessions,body.sessionId)).observationCount).toBe(1);
});
it('preserves an ended session lifecycle and summary cursor while restoring only its missing observation',async()=>{
 const f=fixture();await f.sdk.trigger('mem::capture',{payload:body,eventId:body.eventId});const session=await f.kv.get<any>(KV.sessions,body.sessionId);const ended={...session,status:'ended',endedAt:'2026-10-27T01:00:00Z',updatedAt:'2026-10-27T01:00:00Z',summaryCursor:'keep'};await f.kv.set(KV.sessions,body.sessionId,structuredClone(ended));await f.kv.delete(KV.observations(body.sessionId),f.id);expect((await f.call()).body.completed).toBe(true);expect(await f.kv.get(KV.sessions,body.sessionId)).toEqual(ended);
});
