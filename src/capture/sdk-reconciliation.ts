import{createHash}from'node:crypto';
import type{StateKV}from'../state/kv.js';
import type{CaptureReviewHistory,CompressedObservation,CaptureSdkResolution}from'../types.js';
import type{InboxRecord}from'../functions/capture.js';
import{KV}from'../state/schema.js';
import{withKeyedLock}from'../state/keyed-mutex.js';
import{captureEventScope,isCaptureKey}from'./event-record.js';
import{capturePayloadDigest}from'./receipt-digest.js';
import{requireSdkSourceWriter,sdkObservationMatches}from'./sdk-source-restore.js';
import{captureFailureHistoryDigest,committedSdkResolution,sdkResolutionRequestId,validSdkResolution}from'./sdk-resolution-record.js';

type Selection={key:string;requestId:string;sourceDigest:string};
const fail=(code:string)=>Object.assign(Error(code),{code});
const sha=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function validSdkReconciliationSelection(input:unknown):input is Selection{
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['key','requestId','sourceDigest'].includes(k)))return false;
 const v=input as Selection;return isCaptureKey(v.key)&&sdkResolutionRequestId(v.requestId)&&sha(v.sourceDigest);
}
export function sdkReconciliationInvocation(input:unknown):Selection{
 if(!input||typeof input!=='object'||Array.isArray(input))throw fail('INVALID_SDK_RECONCILIATION');
 const{_caller_worker_id,...body}=input as Record<string,unknown>;
 if(_caller_worker_id!==undefined&&typeof _caller_worker_id!=='string'||!validSdkReconciliationSelection(body))throw fail('INVALID_SDK_RECONCILIATION');
 return body;
}

export function createSdkCaptureReconciliation(kv:StateKV,options:{admitted:()=>boolean;indexReady:(observation:CompressedObservation)=>boolean;audit:(selection:{key:string;requestId:string})=>Promise<unknown>;now?:()=>number}){
 const now=()=>new Date((options.now??Date.now)()).toISOString();
 function admitted(){
  if(kv.durability?.completion!=='sdk')throw fail('SDK_RECONCILIATION_UNSUPPORTED');
  if(!options.admitted())throw fail('SDK_RECONCILIATION_PAUSED');
  try{requireSdkSourceWriter(kv);}catch{throw fail('SDK_RECONCILIATION_WRITER_UNVERIFIED');}
 }
 function identity(rec:InboxRecord|null,input:Selection):InboxRecord{
  if(!rec||rec.key!==input.key||rec.eventSource!=='client'||typeof rec.project!=='string'||!rec.project||typeof rec.eventId!=='string'||!rec.eventId||typeof rec.sessionId!=='string'||!rec.sessionId||rec.sessionId.length>256||typeof rec.observationId!=='string'||!rec.observationId||rec.observationId.length>256||!rec.payload||rec.payload.sessionId!==rec.sessionId||rec.payload.project!==rec.project||typeof rec.payload.hookType!=='string'||rec.payload.hookType!==rec.hookType||typeof rec.payload.timestamp!=='string'||!Number.isFinite(Date.parse(rec.payload.timestamp)))throw fail('SDK_RECONCILIATION_SOURCE_CONFLICT');
  const derived='cap_'+createHash('sha256').update(`${rec.project}\0${rec.sessionId}\0${rec.eventId}`).digest('hex').slice(0,40);
  if(derived!==input.key||capturePayloadDigest(rec.payload)!==input.sourceDigest)throw fail('SDK_RECONCILIATION_SOURCE_CONFLICT');
  return rec;
 }
 function keys(rec:InboxRecord){return[{scope:KV.captureInbox,key:rec.key},{scope:KV.captureReview,key:rec.key},{scope:KV.observations(rec.sessionId),key:rec.observationId},{scope:KV.embeddingRetry,key:rec.observationId},{scope:KV.embeddingCommitted,key:rec.observationId},{scope:KV.vectorPendingLog,key:rec.observationId},{scope:KV.vectorPendingLog,key:'~clear'},{scope:captureEventScope(rec.key),key:rec.key}];}
 async function proof(seed:InboxRecord,input:Selection){
  admitted();
  const pairs=keys(seed),values:unknown[]=[];
  for(let at=0;at<pairs.length;at+=4)values.push(...await Promise.all(pairs.slice(at,at+4).map(p=>kv.get(p.scope,p.key))));
  admitted();
  const[stored,record,observed,retry,committed,pending,clear,receipt]=values;
  const rec=identity(stored as InboxRecord|null,input),history=record as CaptureReviewHistory|null,obs=observed as CompressedObservation|null,marker=committed as any,done=receipt as any;
  if(rec.sessionId!==seed.sessionId||rec.observationId!==seed.observationId||!history||history.key!==rec.key||history.eventId!==rec.eventId||history.sessionId!==rec.sessionId||history.project!==rec.project||history.hookType!==rec.hookType||history.observationId!==rec.observationId)throw fail('SDK_RECONCILIATION_IDENTITY_CONFLICT');
  if(done?.state==='deleted')throw fail('SDK_RECONCILIATION_DELETED');
  if(done&&(done.key!==rec.key||done.eventId!==rec.eventId||done.sessionId!==rec.sessionId||done.observationId!==rec.observationId||done.state!==undefined&&done.state!=='completed'))throw fail('SDK_RECONCILIATION_RECEIPT_CONFLICT');
  if(!sdkObservationMatches(obs,rec.payload,rec.key,rec.observationId,rec.eventId))throw fail('SDK_RECONCILIATION_SOURCE_CONFLICT');
  if(retry!=null||pending!=null||clear!=null)throw fail('SDK_RECONCILIATION_INDEX_PENDING');
  const projection=createHash('sha256').update((String(obs!.title??'')+' '+String(obs!.narrative??'')).slice(0,16000)).digest('hex');
  if(!marker||marker.id!==rec.observationId||marker.sessionId!==rec.sessionId||!['synthetic','observation'].includes(marker.kind)||marker.fingerprint!==projection||!options.indexReady(obs!))throw fail('SDK_RECONCILIATION_INDEX_UNVERIFIED');
  if(!Array.isArray(history.failures)||!history.requests||typeof history.requests!=='object'||Array.isArray(history.requests)||!Number.isSafeInteger(history.totalAttempts)||history.totalAttempts<0||!Number.isSafeInteger(history.manualRetries)||history.manualRetries<0)throw fail('SDK_RECONCILIATION_HISTORY_CONFLICT');
  if(rec.manualRequestId&&!['dead','gone','stopped','recovered'].includes(history.requests[rec.manualRequestId]?.outcome??''))throw fail('SDK_RECONCILIATION_MANUAL_PENDING');
  const resolution=history.sdkResolution;
  if(resolution!==undefined){
   if(!validSdkResolution(resolution)||resolution.sourceDigest!==input.sourceDigest||resolution.priorFailureDigest!==captureFailureHistoryDigest(history))throw fail('SDK_RECONCILIATION_HISTORY_CONFLICT');
   if((resolution.phase==='pending'||rec.sdkResolutionState!=='committed')&&resolution.requestId!==input.requestId)throw fail('SDK_RECONCILIATION_IN_PROGRESS');
   if(resolution.phase==='pending'&&history.status!=='dead'||resolution.phase==='committed'&&history.status!=='completed')throw fail('SDK_RECONCILIATION_HISTORY_CONFLICT');
   if((rec.sdkResolutionId!==undefined||rec.sdkResolutionState!==undefined)&&(rec.sdkResolutionId!==resolution.requestId||rec.storageCompletion!=='sdk'||!['pending','committed'].includes(rec.sdkResolutionState??'')))throw fail('SDK_RECONCILIATION_HISTORY_CONFLICT');
   if(resolution.phase==='committed'&&rec.sdkResolutionId!==resolution.requestId)throw fail('SDK_RECONCILIATION_HISTORY_CONFLICT');
   if(resolution.phase==='pending'&&rec.sdkResolutionState==='committed'||rec.sdkResolutionState==='committed'&&rec.status!=='pending'||rec.sdkResolutionState==='pending'&&rec.status!=='dead')throw fail('SDK_RECONCILIATION_HISTORY_CONFLICT');
  }else if(history.status!=='dead'||rec.status!=='dead'||rec.storageCompletion!==undefined||rec.sdkResolutionId!==undefined||rec.sdkResolutionState!==undefined)throw fail('SDK_RECONCILIATION_NOT_LEGACY');
  return{rec,history,projection,resolution};
 }
 const result=(resolution:CaptureSdkResolution,status:'reconciled'|'already_reconciled')=>({status,requestId:resolution.requestId,completion:'sdk' as const,completed:true,verified:false,synced:false,durable:false,sourceRetained:true,historyRetained:true,originalReplay:false});
 return{
  async reconcile(input:Selection){
   if(!validSdkReconciliationSelection(input))throw fail('INVALID_SDK_RECONCILIATION');
   admitted();
   return withKeyedLock('capture:'+input.key,async()=>{
    const seed=identity(await kv.get<InboxRecord>(KV.captureInbox,input.key),input);admitted();
    const initial=await proof(seed,input);
    if(initial.resolution?.phase!=='committed'||initial.rec.sdkResolutionState!=='committed'){
     if(typeof options.audit!=='function')throw fail('SDK_RECONCILIATION_AUDIT_UNAVAILABLE');
     await options.audit({key:input.key,requestId:input.requestId});admitted();
    }
    return kv.recoveryWrite!.exclusive(keys(seed),async()=>{
     let current=await proof(seed,input);
     if(current.resolution?.phase==='committed'&&current.rec.sdkResolutionState==='committed')return result(current.resolution,'already_reconciled');
     if(!current.resolution){
      const resolution:CaptureSdkResolution={version:1,phase:'pending',completion:'sdk',requestId:input.requestId,sourceDigest:input.sourceDigest,initialProjection:current.projection,priorFailureDigest:captureFailureHistoryDigest(current.history),priorInboxState:'dead',startedAt:now()};
      admitted();await kv.set(KV.captureReview,input.key,{...current.history,sdkResolution:resolution});current=await proof(seed,input);
     }
     if(current.rec.sdkResolutionId===undefined){
      admitted();await kv.set(KV.captureInbox,input.key,{...current.rec,storageCompletion:'sdk',sdkResolutionId:current.resolution!.requestId,sdkResolutionState:'pending'});current=await proof(seed,input);
     }
     if(current.resolution!.phase==='pending'){
      const at=now(),resolution={...current.resolution!,phase:'committed' as const,verifiedProjection:current.projection,completedAt:at};
      admitted();await kv.set(KV.captureReview,input.key,{...current.history,status:'completed',updatedAt:at,recoveredAt:at,sdkResolution:resolution});current=await proof(seed,input);
     }
     if(current.rec.sdkResolutionState!=='committed'){
      admitted();await kv.set(KV.captureInbox,input.key,{...current.rec,status:'pending',sdkResolutionState:'committed',updatedAt:current.resolution!.completedAt});current=await proof(seed,input);
     }
     if(current.resolution?.phase!=='committed'||current.rec.sdkResolutionState!=='committed')throw fail('SDK_RECONCILIATION_INCOMPLETE');
     return result(current.resolution,'reconciled');
    });
   });
  },
  async status(input:{key:string;requestId:string}){
   if(!input||!isCaptureKey(input.key)||!sdkResolutionRequestId(input.requestId)||Object.keys(input).some(k=>!['key','requestId'].includes(k)))throw fail('INVALID_SDK_RECONCILIATION');
   const[history,rec]=await Promise.all([kv.get<CaptureReviewHistory>(KV.captureReview,input.key),kv.get<InboxRecord>(KV.captureInbox,input.key)]);
   const resolution=history?.sdkResolution,valid=validSdkResolution(resolution)&&resolution.requestId===input.requestId;
   return{phase:valid?resolution.phase:'not_recorded',recordedCompleted:valid&&committedSdkResolution(history,rec),completion:'sdk',verified:false,synced:false,evidence:'recorded_resolution_metadata',readOnly:true};
  },
 };
}
