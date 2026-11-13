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

it('does not read inbox for automatic viewer status and keeps result unknown',async()=>{
 const f=await fixture();const list=vi.spyOn(f.kv,'list');
 const {createStatusReporter}=await import('../src/triggers/api.js');
 const report=createStatusReporter(f.sdk as never,f.kv as never,{});
 const result=await report({health:null,scanUnindexed:false,scanCaptureInbox:false} as never);
 expect(list.mock.calls.filter(([scope])=>scope===KV.captureInbox)).toHaveLength(0);
 expect(result.capture?.inbox).toBeNull();
 expect(result.problems.some(p=>p.code==='capture-check-unavailable')).toBe(true);
});
it('retains the explicit authenticated capture inbox check',async()=>{
 const f=await fixture();const list=vi.spyOn(f.kv,'list');
 const status=await f.control.status();expect(status.inbox).not.toBeNull();
 expect(list.mock.calls.filter(([scope])=>scope===KV.captureInbox)).toHaveLength(1);
});
it('skips inbox reads in viewer snapshot and health events',async()=>{
 const f=await fixture();Object.assign(f.kv,{countSummaries:async()=>0});
 const {registerViewerStreamTriggers}=await import('../src/triggers/viewer-streams.js');
 registerViewerStreamTriggers(f.sdk as never,f.kv as never,{});
 const list=vi.spyOn(f.kv,'list');
 const snapshot=await f.sdk.fns.get('api::viewer-snapshot')!({headers:{}}) as any;
 expect(snapshot.status_code).toBe(200);expect(snapshot.body.report.capture.inbox).toBeNull();
 list.mockClear();
 const healthEvent=await f.sdk.fns.get('event::viewer::health-changed')!({key:'latest',event_type:'state:updated',new_value:{status:'healthy',alerts:[]}}) as any;
 expect(healthEvent).toMatchObject({emitted:true});
 expect(list.mock.calls.filter(([scope])=>scope===KV.captureInbox)).toHaveLength(0);
});
it('does not report healthy when capture pending work is unknown',async()=>{
 const f=await fixture();const {operationalState}=await import('../src/ops/context.js');
 const prior=operationalState.captureProgress;
 try{
  operationalState.captureProgress={snapshot:()=>({pending:null,stalled:false})} as never;
  await f.kv.set(KV.health,'latest',{status:'healthy',alerts:[]});
  const response=await f.sdk.fns.get('api::health')!({}) as any;
  expect(response.body.status).toBe('degraded');
  expect(response.body.captureProgress.pending).toBeNull();
 }finally{operationalState.captureProgress=prior}
});

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

it('real viewer health update omits the inbox scan',async()=>{const f=await fixture();Object.assign(f.kv,{countSummaries:async()=>0});const {registerViewerStreamTriggers}=await import('../src/triggers/viewer-streams.js');registerViewerStreamTriggers(f.sdk as never,f.kv as never,{});const list=vi.spyOn(f.kv,'list');const event=await f.sdk.fns.get('event::viewer::health-changed')!({key:'latest',event_type:'state:updated',new_value:{status:'healthy',alerts:[]}}) as any;expect(event).toMatchObject({emitted:true});expect(list.mock.calls.filter(([scope])=>scope===KV.captureInbox)).toHaveLength(0)});
it('returns a retryable service error when remember is refused by the vector hold',async()=>{const f=await fixture();f.sdk.fns.set('mem::remember',async()=>({success:false,error:'vector_recovery_paused',retryable:true}));const out=await f.sdk.fns.get('api::remember')!({headers:{authorization:'Bearer synthetic-secret'},body:{content:'synthetic'}}) as any;expect(out).toMatchObject({status_code:503,body:{success:false,error:'vector_recovery_paused',retryable:true}})});
it.each([['forget','mem::forget',{memoryId:'synthetic'}],['evict','mem::evict',{}],['evolve','mem::evolve',{memoryId:'synthetic',newContent:'synthetic'}],['governance-delete','mem::governance-delete',{memoryIds:['synthetic']}],['governance-bulk','mem::governance-bulk',{}]])('returns a retryable 503 for held %s',async(api,fn,body)=>{const f=await fixture();f.sdk.fns.set(fn,async()=>({success:false,error:'vector_recovery_paused',retryable:true}));const out=await f.sdk.fns.get('api::'+api)!({headers:{authorization:'Bearer synthetic-secret'},body,query_params:{}}) as any;expect(out).toMatchObject({status_code:503,body:{success:false,error:'vector_recovery_paused',retryable:true}})});
it.each([['auto-forget','mem::auto-forget',{}],['snapshot-restore','mem::snapshot-restore',{commitHash:'synthetic'}]])('returns retryable 503 for held %s',async(api,fn,body)=>{const f=await fixture();f.sdk.fns.set(fn,async()=>({success:false,error:'vector_recovery_paused',retryable:true}));const out=await f.sdk.fns.get('api::'+api)!({headers:{authorization:'Bearer synthetic-secret'},body,query_params:{}}) as any;expect(out).toMatchObject({status_code:503,body:{success:false,error:'vector_recovery_paused',retryable:true}})});
it.each([['import','mem::import',{exportData:{}}],['replay::import','mem::replay::import-jsonl',{}]])('returns retryable 503 for held %s',async(api,fn,body)=>{const f=await fixture();f.sdk.fns.set(fn,async()=>({success:false,error:'vector_recovery_paused',retryable:true}));const out=await f.sdk.fns.get('api::'+api)!({headers:{authorization:'Bearer synthetic-secret'},body,query_params:{}}) as any;expect(out).toMatchObject({status_code:503,body:{success:false,error:'vector_recovery_paused',retryable:true}})});
it('inspects an uncertain item by original identifiers and content without writes or replay',async()=>{const f=await fixture();const inspect=f.sdk.fns.get('api::capture-inspect-uncertain');expect(inspect).toBeTypeOf('function');const out=await inspect!({headers:f.headers,body:{key,eventId,sourceDigest:capturePayloadDigest(payload),project:payload.project,sessionId:payload.sessionId,cwd:payload.cwd,hookType:payload.hookType,timestamp:payload.timestamp}}) as any;expect(out).toMatchObject({status_code:200,body:{outcome:'observation_matches',readOnly:true,diskVerified:false,originalReplay:false,retryAuthorized:false}});expect(f.writes).not.toHaveBeenCalled()});
it('does not infer retry is safe when an uncertain observation is absent or source differs',async()=>{const f=await fixture();await f.kv.delete(KV.observations(payload.sessionId),id);const inspect=f.sdk.fns.get('api::capture-inspect-uncertain');expect(inspect).toBeTypeOf('function');const absent=await inspect!({headers:f.headers,body:{key,eventId,sourceDigest:capturePayloadDigest(payload),project:payload.project,sessionId:payload.sessionId,cwd:payload.cwd,hookType:payload.hookType,timestamp:payload.timestamp}}) as any;expect(absent).toMatchObject({status_code:200,body:{outcome:'observation_not_found',retryAuthorized:false,diskVerified:false}});const mismatch=await inspect!({headers:f.headers,body:{key,eventId,sourceDigest:'0'.repeat(64),project:payload.project,sessionId:payload.sessionId,cwd:payload.cwd,hookType:payload.hookType,timestamp:payload.timestamp}}) as any;expect(mismatch.status_code).toBe(409);expect(f.writes).not.toHaveBeenCalled()});
it('allows the SDK caller metadata without accepting extra inspection fields',async()=>{const f=await fixture();const direct=f.sdk.fns.get('mem::capture-inspect-uncertain')!;expect(await direct({key,eventId,sourceDigest:capturePayloadDigest(payload),project:payload.project,sessionId:payload.sessionId,cwd:payload.cwd,hookType:payload.hookType,timestamp:payload.timestamp,_caller_worker_id:'synthetic-worker'})).toMatchObject({outcome:'observation_matches',readOnly:true});await expect(direct({key,eventId,sourceDigest:capturePayloadDigest(payload),project:payload.project,sessionId:payload.sessionId,cwd:payload.cwd,hookType:payload.hookType,timestamp:payload.timestamp,extra:true})).rejects.toThrow();expect(f.writes).not.toHaveBeenCalled()});

it('requires a configured secret and exact original metadata for uncertain inspection',async()=>{const f=await fixture(),body={key,eventId,sourceDigest:capturePayloadDigest(payload),project:payload.project,sessionId:payload.sessionId,cwd:payload.cwd,hookType:payload.hookType,timestamp:payload.timestamp};const handler=f.sdk.fns.get('api::capture-inspect-uncertain')!;expect((await handler({headers:{},body}) as any).status_code).toBe(401);expect((await handler({headers:f.headers,body:{...body,cwd:'/different'}}) as any).status_code).toBe(409);registerApiTriggers(f.sdk as never,f.kv as never,'');const unconfigured=await f.sdk.fns.get('api::capture-inspect-uncertain')!({headers:{},body}) as any;expect(unconfigured.status_code).toBe(503);expect(f.writes).not.toHaveBeenCalled()});
it('refuses changing observations and reports read failures without mutation',async()=>{const f=await fixture(),body={key,eventId,sourceDigest:capturePayloadDigest(payload),project:payload.project,sessionId:payload.sessionId,cwd:payload.cwd,hookType:payload.hookType,timestamp:payload.timestamp},handler=f.sdk.fns.get('api::capture-inspect-uncertain')!,get=f.kv.get;let reads=0;f.kv.get=async<T>(scope:string,k:string)=>{const v=await get<T>(scope,k);if(scope===KV.observations(payload.sessionId)&&++reads===2)return {...v as object,title:'changed'} as T;return v};expect((await handler({headers:f.headers,body}) as any)).toMatchObject({status_code:409,body:{outcome:'changed_during_inspection',retryAuthorized:false}});f.kv.get=async()=>{throw Error('synthetic read unavailable')};expect((await handler({headers:f.headers,body}) as any)).toMatchObject({status_code:503,body:{error:'UNCERTAIN_INSPECTION_UNAVAILABLE'}});expect(f.writes).not.toHaveBeenCalled()});

it('keeps timed-out or overlapping inbox calculations single while returning unavailable rather than stale counts',async()=>{
 const f=await fixture();await f.call();
 const list=f.kv.list.bind(f.kv);let release!:()=>void,entered!:()=>void,inboxReads=0;
 const began=new Promise<void>(resolve=>entered=resolve),blocked=new Promise<void>(resolve=>release=resolve);
 f.kv.list=async(scope)=>{if(scope===KV.captureInbox){inboxReads++;entered();await blocked;}return list(scope)};
 const first=f.control.status();await began;
 expect(await Promise.race([first.then(()=>false),new Promise(resolve=>setTimeout(()=>resolve('caller_timed_out'),5))])).toBe('caller_timed_out');
 const overlapping=await f.control.status();
 expect(overlapping.inbox).toBeNull();expect(inboxReads).toBe(1);
 release();const result=await first;expect(result.inbox?.sdkCompleted).toBe(1);
 result.inbox!.sdkCompleted=999;
 const history=await f.kv.get<any>(KV.captureReview,key);history.sdkResolution.version=99;await f.kv.set(KV.captureReview,key,history);
 expect((await f.control.status()).inbox?.sdkCompleted).toBe(0);expect(inboxReads).toBe(2);
});
it('retains physical history-key verification rather than counting a mis-keyed resolution as complete',async()=>{
 const f=await fixture();await f.call();const rec=await f.kv.get<any>(KV.captureInbox,key),history=await f.kv.get<any>(KV.captureReview,key);
 const {sdkResolutionId,sdkResolutionState,...ordinary}=rec;await f.kv.set(KV.captureInbox,key,ordinary);
 await f.kv.set(KV.captureReview,key,{...history,key:'cap_'+'f'.repeat(40)});
 expect((await f.control.status()).inbox?.sdkCompleted).toBe(0);
});
it('releases the status admission after the underlying read fails so a fresh retry can succeed',async()=>{
 const f=await fixture();await f.call();const list=f.kv.list.bind(f.kv);let fail=true;
 f.kv.list=async scope=>{if(scope===KV.captureInbox&&fail)throw Error('synthetic_read_failure');return list(scope)};
 expect((await f.control.status()).inbox).toBeNull();fail=false;expect((await f.control.status()).inbox?.sdkCompleted).toBe(1);
});

it('holds admission until every already-started history read settles after a sibling read fails',async()=>{
 const f=await fixture();await f.call();const rec=await f.kv.get<any>(KV.captureInbox,key),other='cap_'+'e'.repeat(40);
 await f.kv.set(KV.captureInbox,other,{...rec,key:other});
 const get=f.kv.get.bind(f.kv),list=f.kv.list.bind(f.kv);let release!:()=>void,entered!:()=>void,lists=0;
 const began=new Promise<void>(resolve=>entered=resolve),blocked=new Promise<void>(resolve=>release=resolve);
 f.kv.list=async scope=>{if(scope===KV.captureInbox)lists++;return list(scope)};
 f.kv.get=async(scope,k)=>{if(scope!==KV.captureReview)return get(scope,k);if(k===key)throw Error('synthetic_sibling_failure');entered();await blocked;return get(scope,k)};
 const first=f.control.status();await began;await new Promise(resolve=>setTimeout(resolve,0));
 const second=f.control.status();await new Promise(resolve=>setTimeout(resolve,0));
 try{expect(lists).toBe(1);}finally{release();await Promise.all([first,second]);}
});

it('bounds an explicit SDK proof page at 32 physical-key reads without presenting a partial count as total completion',async()=>{
 const f=await fixture();await f.call();const rec=await f.kv.get<any>(KV.captureInbox,key),{sdkResolutionId,sdkResolutionState,...ordinary}=rec;
 for(let i=1;i<96;i++){const k='cap_'+String(i).padStart(40,'0');await f.kv.set(KV.captureInbox,k,{...ordinary,key:k});}
 const get=f.kv.get.bind(f.kv);let reads=0;f.kv.get=async(s,k)=>{if(s===KV.captureReview)reads++;return get(s,k)};
 const result=await f.control.status({sdkProofPage:{offset:0,limit:32}} as never);
 expect(reads).toBe(32);expect(result.inbox?.sdkCompleted).toBeUndefined();expect(result.inbox).toMatchObject({sdkRetained:96,sdkProofPage:{offset:0,checked:32,total:96,completed:32,nextOffset:32}});
 expect(result.inbox?.sdkProofPage?.generation).toMatch(/^[0-9a-f]{64}$/);
 const page=await f.control.status({sdkProofPage:{offset:32,limit:32,generation:result.inbox!.sdkProofPage!.generation}} as never);
 expect(reads).toBe(64);expect(page.inbox?.sdkCompleted).toBeUndefined();expect(page.inbox?.sdkProofPage?.offset).toBe(32);
});
it('rejects proof page continuation after source generation changes and never counts old proof as current',async()=>{
 const f=await fixture();await f.call();const first=await f.control.status({sdkProofPage:{offset:0,limit:32}} as never);
 const rec=await f.kv.get<any>(KV.captureInbox,key);await f.kv.set(KV.captureInbox,key,{...rec,payload:{...rec.payload,data:{changed:'synthetic'}}});
 await expect(f.control.status({sdkProofPage:{offset:0,limit:32,generation:first.inbox!.sdkProofPage!.generation}} as never)).rejects.toMatchObject({code:'CAPTURE_PROOF_GENERATION_CHANGED'});
});
it.each([{offset:-1,limit:32},{offset:0,limit:33},{offset:32,limit:32},{offset:0,limit:0}])('rejects invalid proof page %j before reading',async page=>{
 const f=await fixture();const list=vi.spyOn(f.kv,'list');await expect(f.control.status({sdkProofPage:page} as never)).rejects.toMatchObject({code:'INVALID_CAPTURE_PROOF_PAGE'});expect(list).not.toHaveBeenCalled();
});

it('uses the bounded proof page in the authenticated capture HTTP path and rejects stale continuations',async()=>{
 const f=await fixture();await f.call();const rec=await f.kv.get<any>(KV.captureInbox,key),{sdkResolutionId,sdkResolutionState,...ordinary}=rec;
 for(let i=1;i<40;i++){const k='cap_'+String(i).padStart(40,'0');await f.kv.set(KV.captureInbox,k,{...ordinary,key:k});}
 const get=f.kv.get.bind(f.kv);let reads=0;f.kv.get=async(s,k)=>{if(s===KV.captureReview)reads++;return get(s,k)};
 const call=f.sdk.fns.get('api::capture')!;
 expect((await call({headers:{},query_params:{}}) as any).status_code).toBe(401);expect(reads).toBe(0);
 const first=await call({headers:f.headers,query_params:{}}) as any;
 expect(first.status_code).toBe(200);expect(first.body.capture.inbox.sdkProofPage.checked).toBe(32);expect(reads).toBe(32);
 expect((await call({headers:f.headers,query_params:{proofOffset:'-1'}}) as any).status_code).toBe(400);
 expect((await call({headers:f.headers,query_params:{proofOffset:'32',proofGeneration:'a'.repeat(64)}}) as any).status_code).toBe(409);
});

it('keeps next offsets usable after more than ten thousand retained SDK originals',async()=>{
 const f=await fixture();await f.call();const rec=await f.kv.get<any>(KV.captureInbox,key),{sdkResolutionId,sdkResolutionState,...ordinary}=rec;
 const records=Array.from({length:10033},(_,i)=>({...ordinary,key:'cap_'+i.toString(16).padStart(40,'0')})),list=f.kv.list.bind(f.kv);
 f.kv.list=async (scope,options)=>scope===KV.captureInbox?options?.project?records.map(row=>options.project!(row,row.key)):records:list(scope,options);
 const first=await f.control.status({sdkProofPage:{offset:0,limit:32}} as never),generation=first.inbox!.sdkProofPage!.generation;
 const near=await f.control.status({sdkProofPage:{offset:9984,limit:32,generation}} as never);expect(near.inbox?.sdkProofPage?.nextOffset).toBe(10016);
 const last=await f.control.status({sdkProofPage:{offset:10016,limit:32,generation}} as never);expect(last.inbox?.sdkProofPage).toMatchObject({checked:17,nextOffset:null});
 const response=await f.sdk.fns.get('api::capture')!({headers:f.headers,query_params:{proofOffset:'10016',proofGeneration:generation}}) as any;expect(response.status_code).toBe(200);expect(response.body.capture.inbox.sdkProofPage.checked).toBe(17);
});
