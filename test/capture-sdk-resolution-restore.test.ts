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

import {createHash} from 'node:crypto';
import {createSdkCaptureReconciliation} from '../src/capture/sdk-reconciliation.js';
import {capturePayloadDigest} from '../src/capture/receipt-digest.js';
for(const missing of [false,true])it(`whole-review actual v2 restore consumer missing=${missing}`,async()=>{
 const f=fixture();await f.sdk.trigger('mem::capture',{payload:body,eventId:body.eventId});
 const rec=await f.kv.get<any>(KV.captureInbox,f.key);rec.status='dead';rec.nextAttemptAt='2026-10-31T00:00:00Z';rec.manualRequestId='finished';rec.unknownOriginal={retained:true};delete rec.storageCompletion;
 await f.kv.set(KV.captureInbox,f.key,rec);
 await f.kv.set(KV.captureReview,f.key,{key:f.key,eventId:body.eventId,sessionId:body.sessionId,project:body.project,hookType:body.hookType,observationId:rec.observationId,status:'dead',totalAttempts:rec.attempts,manualRetries:0,acceptedAt:rec.acceptedAt,updatedAt:rec.updatedAt,failures:[{at:rec.acceptedAt,attempt:rec.attempts,code:'CAPTURE_STORE_TIMEOUT'}],requests:{finished:{startedAt:rec.acceptedAt,outcome:'dead'}}});
 const originalHistory=await f.kv.get<any>(KV.captureReview,f.key);
 const obs=await f.kv.get<any>(KV.observations(body.sessionId),rec.observationId);
 await f.kv.set(KV.embeddingCommitted,rec.observationId,{id:rec.observationId,sessionId:body.sessionId,kind:'synthetic',fingerprint:createHash('sha256').update((obs.title+' '+obs.narrative).slice(0,16000)).digest('hex')});
 await f.kv.delete(KV.embeddingRetry,rec.observationId);
 const helper=createSdkCaptureReconciliation(f.kv as never,{admitted:()=>true,indexEvidence:()=>({keyword:{present:true,sessionId:body.sessionId},vectorSessionId:body.sessionId}),audit:async()=>{}});
 const requestId='00000000-0000-4000-8000-000000000001';
 await helper.reconcile({key:f.key,requestId,sourceDigest:capturePayloadDigest(rec.payload)});
 expect(await helper.status({key:f.key,requestId})).toMatchObject({recordedCompleted:true});
 if(missing)await f.kv.delete(KV.observations(body.sessionId),rec.observationId);
 const result=await f.call();

 expect(result.body).toMatchObject({completed:true});
 expect(await helper.status({key:f.key,requestId})).toMatchObject({recordedCompleted:true});
 const restored=await f.kv.get<any>(KV.captureInbox,f.key);expect(restored).toMatchObject({sdkRestoreState:'completed',payload:rec.payload,attempts:rec.attempts,nextAttemptAt:rec.nextAttemptAt,manualRequestId:rec.manualRequestId,unknownOriginal:rec.unknownOriginal,sdkRestoreAttempts:missing?1:0});expect(await f.kv.get<any>(KV.captureReview,f.key)).toMatchObject({failures:originalHistory.failures,requests:originalHistory.requests,totalAttempts:originalHistory.totalAttempts});
 const observationsBeforeRepeat=await f.kv.list(KV.observations(body.sessionId));
 const historyBeforeRepeat=await f.kv.get(KV.captureReview,f.key);
 expect((await f.call()).body).toMatchObject({status:'duplicate',completed:true});
 expect(await helper.status({key:f.key,requestId})).toMatchObject({recordedCompleted:true});
 expect(await f.kv.get(KV.captureInbox,f.key)).toMatchObject({sdkRestoreState:'completed',payload:rec.payload,attempts:rec.attempts,nextAttemptAt:rec.nextAttemptAt,manualRequestId:rec.manualRequestId,unknownOriginal:rec.unknownOriginal,sdkRestoreAttempts:restored.sdkRestoreAttempts});
 expect(await f.kv.get(KV.captureReview,f.key)).toEqual(historyBeforeRepeat);
 expect(await f.kv.list(KV.observations(body.sessionId))).toEqual(observationsBeforeRepeat);
 expect(observationsBeforeRepeat).toHaveLength(1);
});
