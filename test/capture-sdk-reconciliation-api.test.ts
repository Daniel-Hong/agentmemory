import{it,expect,vi,afterEach}from'vitest';import{createHash}from'node:crypto';
import{mockKV,mockSdk}from'./helpers/mocks.js';import{registerCaptureFunctions,captureKey}from'../src/functions/capture.js';import{registerApiTriggers}from'../src/triggers/api.js';import{createRecordRecoveryGate}from'../src/state/recovery-write-gate.js';import{KV}from'../src/state/schema.js';import{capturePayloadDigest}from'../src/capture/receipt-digest.js';import{SearchIndex}from'../src/state/search-index.js';import{VectorIndex}from'../src/state/vector-index.js';import*as search from'../src/functions/search.js';
const cleanup:Array<()=>void>=[];afterEach(()=>{cleanup.splice(0).forEach(f=>f());vi.restoreAllMocks()});
const requestId='00000000-0000-4000-8000-000000000001',payload={sessionId:'synthetic',project:'synthetic',cwd:'/synthetic',hookType:'post_tool_use',timestamp:'2026-10-29T00:00:00Z',data:{tool_output:'private synthetic original'}},eventId='synthetic_reconcile_001',key=captureKey(payload.project,payload.sessionId,eventId),id='obs_synthetic_reconcile';
async function fixture(){
 const kv=mockKV(),sdk=mockSdk({looseTrigger:true}),gate=createRecordRecoveryGate(),keyword=new SearchIndex(),vector=new VectorIndex();
 const baseSet=kv.set.bind(kv);kv.set=(s,k,v)=>gate.read(s,k,()=>baseSet(s,k,structuredClone(v)));Object.assign(kv,{backend:'file',durability:{completion:'sdk'},recoveryWrite:gate,recoveryMutationSafe:true,mutationOutcomeUncertain:false});
 const obs={id,sessionId:payload.sessionId,captureKey:key,title:'Synthetic',narrative:'Stored once',facts:[],concepts:[],files:[],timestamp:payload.timestamp,importance:1,type:'other',sourceRaw:{id,sessionId:payload.sessionId,captureKey:key,eventId,hookType:payload.hookType,timestamp:payload.timestamp,raw:payload.data}};
 await kv.set(KV.captureInbox,key,{key,eventId,eventSource:'client',sessionId:payload.sessionId,project:payload.project,hookType:payload.hookType,observationId:id,status:'dead',attempts:6,acceptedAt:payload.timestamp,updatedAt:payload.timestamp,payload});
 await kv.set(KV.captureReview,key,{key,eventId,sessionId:payload.sessionId,project:payload.project,hookType:payload.hookType,observationId:id,status:'dead',totalAttempts:6,manualRetries:0,acceptedAt:payload.timestamp,updatedAt:payload.timestamp,failures:[{at:payload.timestamp,attempt:6,code:'CAPTURE_STORE_TIMEOUT'}],requests:{}});
 await kv.set(KV.observations(payload.sessionId),id,obs);await kv.set(KV.embeddingCommitted,id,{id,sessionId:payload.sessionId,kind:'synthetic',fingerprint:createHash('sha256').update('Synthetic Stored once').digest('hex')});
 keyword.add(obs as never);vector.add(id,payload.sessionId,new Float32Array([1,0]));vi.spyOn(search,'getSearchIndex').mockReturnValue(keyword);vi.spyOn(search,'getVectorIndex').mockReturnValue(vector);
 const control=registerCaptureFunctions(sdk as never,kv as never);registerApiTriggers(sdk as never,kv as never,'synthetic-secret');cleanup.push(()=>control.stop());
 const writes=vi.spyOn(kv,'set'),body={key,requestId,sourceDigest:capturePayloadDigest(payload),captureCompletion:'sdk-v1'},headers={authorization:'Bearer synthetic-secret','x-agentmemory-capture-reconcile':'1'};
 const call=(b:any=body,h:any=headers)=>sdk.fns.get('api::capture-reconcile-sdk')!({body:b,headers:h})as Promise<any>;
 return{kv,sdk,control,writes,body,headers,call};
}
it('requires existing bearer, explicit SDK contract and per-request confirmation before mutations',async()=>{const f=await fixture();expect((await f.call(f.body,{})).status_code).toBe(401);expect((await f.call(f.body,{authorization:'Bearer synthetic-secret'})).status_code).toBe(400);expect((await f.call({...f.body,captureCompletion:'disk'})).status_code).toBe(400);expect((await f.call({...f.body,all:true})).status_code).toBe(400);expect(f.writes).not.toHaveBeenCalled()});
it('returns SDK completion through registered controller work and retains originals and failure history',async()=>{const f=await fixture();const result=await f.call();expect(result).toMatchObject({status_code:200,body:{completed:true,completion:'sdk',verified:false,synced:false,originalReplay:false}});const source=await f.kv.get<any>(KV.captureInbox,key);expect(source).toMatchObject({storageCompletion:'sdk',sdkResolutionState:'committed',status:'pending',payload});expect((await f.kv.get<any>(KV.captureReview,key)).failures).toHaveLength(1);const calls=f.writes.mock.calls.length;expect((await f.call()).body.status).toBe('already_reconciled');expect(f.writes).toHaveBeenCalledTimes(calls);});
it('reads explicit recorded outcome without claiming disk proof or current source verification',async()=>{const f=await fixture();await f.call();const status=await f.sdk.fns.get('api::capture-reconcile-sdk-status')!({headers:f.headers,query_params:{key,requestId}})as any;expect(status).toMatchObject({status_code:200,body:{recordedCompleted:true,verified:false,synced:false,evidence:'recorded_resolution_metadata',readOnly:true}})});
it('exposes current index membership in one body-free readonly function',async()=>{const f=await fixture();const result=await f.sdk.fns.get('api::capture-index-membership')!({headers:f.headers,query_params:{ids:id}})as any;expect(result).toMatchObject({status_code:200,body:{sourceVerified:false,diskVerified:false,items:[{id,keywordPresent:true,vectorPresent:true}]}});expect(JSON.stringify(result)).not.toContain('private synthetic original');expect(f.writes).not.toHaveBeenCalled()});
it('stops admission after capture shutdown and drains existing tracked work',async()=>{const f=await fixture();f.control.stop();expect((await f.call()).body.completed).toBe(false);await f.control.drain();expect(f.writes).not.toHaveBeenCalled()});

it('holds drain until an in-flight reconciliation exits and stops before further writes after shutdown',async()=>{
 const f=await fixture();let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(r=>entered=r),blocked=new Promise<void>(r=>release=r);const get=f.kv.get.bind(f.kv);let intercepted=false;
 f.kv.get=async(s,k)=>{if(!intercepted&&s===KV.captureInbox&&k===key){intercepted=true;entered();await blocked;}return get(s,k)};
 const active=f.call();await reached;f.control.stop();let drained=false;const drain=f.control.drain().then(()=>drained=true);await Promise.resolve();expect(drained).toBe(false);release();expect((await active).body.completed).toBe(false);await drain;expect(drained).toBe(true);expect(f.writes).not.toHaveBeenCalled();
});
it('rejects invalid status identifiers without SDK dispatch',async()=>{const f=await fixture();const result=await f.sdk.fns.get('api::capture-reconcile-sdk-status')!({headers:f.headers,query_params:{key:'bad',requestId:'bad'}})as any;expect(result.status_code).toBe(400);expect(f.writes).not.toHaveBeenCalled()});
it('generic duplicate and count consumers refuse invalid resolution markers',async()=>{const f=await fixture();await f.call();const h=await f.kv.get<any>(KV.captureReview,key);h.sdkResolution.version=99;await f.kv.set(KV.captureReview,key,h);expect((await f.control.status()).inbox.sdkCompleted).toBe(0);expect(await f.sdk.trigger('mem::capture',{payload,eventId})).toMatchObject({status:'duplicate',state:'pending'})});
it('bounds SDK archive status history reads to four while preserving validated completion counts',async()=>{
 const f=await fixture();await f.call();
 const valid=await f.kv.get<any>(KV.captureInbox,key);
 const history=await f.kv.get<any>(KV.captureReview,key);
 for(let i=0;i<8;i++){
  const ordinaryKey='cap_'+String(i+1).padStart(40,'0');
  const {sdkResolutionId,sdkResolutionState,...ordinary}=valid;
  await f.kv.set(KV.captureInbox,ordinaryKey,{...ordinary,key:ordinaryKey});
 }
 const invalidKey='cap_'+'f'.repeat(40);
 await f.kv.set(KV.captureInbox,invalidKey,{...valid,key:invalidKey});
 await f.kv.set(KV.captureReview,invalidKey,{...history,key:invalidKey,sdkResolution:{...history.sdkResolution,version:99}});
 const get=f.kv.get.bind(f.kv);let active=0,peak=0,reviewReads=0;
 f.kv.get=async(scope,itemKey)=>{
  if(scope!==KV.captureReview)return get(scope,itemKey);
  reviewReads++;active++;peak=Math.max(peak,active);
  try{await new Promise(resolve=>setTimeout(resolve,0));return await get(scope,itemKey)}finally{active--}
 };
 const result=await f.control.status();
 expect(result.inbox?.sdkCompleted).toBe(9);
 expect(reviewReads).toBe(10);
 expect(active).toBe(0);
 expect(peak).toBeLessThanOrEqual(4);
});
