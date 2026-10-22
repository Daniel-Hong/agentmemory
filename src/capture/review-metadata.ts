import {randomUUID} from 'node:crypto';
import type { StateKV } from '../state/kv.js';
import type { CaptureReviewHistory } from '../types.js';
import {KV} from '../state/schema.js';
import {captureEventScope,isCaptureKey} from './event-record.js';

const statuses=new Set(['dead','retrying','pending','completed']);
const codes=new Set(['SESSION_OBSERVATION_LIMIT','OBSERVATION_NOT_STORED','CAPTURE_STORE_TIMEOUT','CAPTURE_STORE_FAILED','EMBEDDING_INTENT_CHANGED','EMBEDDING_SOURCE_CHANGED']);
const fail=(code:string)=>Object.assign(new Error(code),{code});
const count=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0?Number(value):null;
const timestamp=(value:unknown)=>typeof value==='string'&&value.length<=32&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
export interface CaptureMetadataQuery {status?:string;limit?:number;offset?:number;reviewRef?:string}
export function validCaptureMetadataQuery(input:CaptureMetadataQuery):boolean {
  return !!input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).every(k=>['status','limit','offset','reviewRef'].includes(k))&&
    (input.status===undefined||statuses.has(input.status))&&
    (input.limit===undefined||Number.isSafeInteger(input.limit)&&input.limit>=1&&input.limit<=50)&&
    (input.offset===undefined||Number.isSafeInteger(input.offset)&&input.offset>=0&&input.offset<=5000)&&
    (input.reviewRef===undefined||typeof input.reviewRef==='string'&&/^rmeta_[0-9a-f-]{36}$/.test(input.reviewRef));
}
export function createCaptureReviewMetadata(kv:StateKV,{budgetMs=2000}:{budgetMs?:number}={}) {
  if(!Number.isSafeInteger(budgetMs)||budgetMs<1||budgetMs>5000)throw fail('INVALID_CAPTURE_METADATA_BUDGET');
  const epoch=randomUUID(),references=new Map<string,string>();let active=false;
  return async(input:CaptureMetadataQuery={})=>{
    if(!validCaptureMetadataQuery(input))throw fail('INVALID_CAPTURE_METADATA_QUERY');
    if(active)throw fail('CAPTURE_METADATA_BUSY');
    active=true;const deadline=Date.now()+budgetMs,outstanding=new Set<Promise<unknown>>();let closed=false;
    async function bounded<T>(read:()=>Promise<T>):Promise<T>{
      const remaining=deadline-Date.now();if(closed||remaining<=0)throw fail('CAPTURE_METADATA_UNAVAILABLE');
      const work=Promise.resolve().then(read);outstanding.add(work);work.then(()=>outstanding.delete(work),()=>outstanding.delete(work));
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(fail('CAPTURE_METADATA_UNAVAILABLE')),remaining);})]);}
      finally{clearTimeout(timer);}
    }
    try{
      const histories=await bounded(()=>kv.list<CaptureReviewHistory>(KV.captureReview));
      if(!Array.isArray(histories)||histories.length>5000)throw fail('CAPTURE_METADATA_UNAVAILABLE');
      const valid=histories.filter(h=>h&&isCaptureKey(h.key)&&statuses.has(h.status));
      const keys=new Set(valid.map(h=>h.key));for(const key of references.keys())if(!keys.has(key))references.delete(key);
      const rows=valid.map(h=>{let ref=references.get(h.key);if(!ref){ref='rmeta_'+randomUUID();references.set(h.key,ref);}return{h,ref};});
      if(input.reviewRef&&!rows.some(r=>r.ref===input.reviewRef))throw fail('CAPTURE_METADATA_REFERENCE_UNKNOWN');
      const status=input.status??(input.reviewRef?undefined:'dead');
      const filtered=rows.filter(r=>(!status||r.h.status===status)&&(!input.reviewRef||r.ref===input.reviewRef))
        .sort((a,b)=>(timestamp(a.h.acceptedAt)??'').localeCompare(timestamp(b.h.acceptedAt)??'')||a.ref.localeCompare(b.ref));
      const limit=input.limit??25,offset=input.offset??0,items=[];
      for(const {h,ref} of filtered.slice(offset,offset+limit)){
        const last=Array.isArray(h.failures)?h.failures.at(-1)?.code:undefined;
        const item={reviewRef:ref,recordedStatus:h.status,attempts:count(h.totalAttempts),cycleAttempts:count(h.cycleAttempts),manualRetries:count(h.manualRetries),acceptedAt:timestamp(h.acceptedAt),updatedAt:timestamp(h.updatedAt),failureCode:codes.has(last??'')?last:'UNCLASSIFIED_RECORDED_FAILURE',inboxState:'not_checked',canonicalState:'not_checked',intentGenerationRelation:'not_recorded',completionReceipt:'unavailable',retryIntent:'unavailable',intentPhase:'unknown',publicationMarker:'unavailable',nextStep:'metadata_unavailable',retryAuthorized:false,diskVerified:false};
        try{
          const done=await bounded(()=>kv.get<Record<string,unknown>>(captureEventScope(h.key),h.key));
          if(!done)item.completionReceipt='absent';
          else if(done.key!==h.key)item.completionReceipt='identity_conflict';
          else if(done.state==='deleted')item.completionReceipt='deleted';
          else if(done.state!==undefined&&done.state!=='completed')item.completionReceipt='unavailable';
          else if(typeof h.observationId==='string'&&h.observationId.length>0&&typeof h.sessionId==='string'&&h.sessionId.length>0&&done.observationId===h.observationId&&done.sessionId===h.sessionId)item.completionReceipt='completed_metadata';
          else item.completionReceipt='identity_conflict';
          const id=h.observationId;
          if(typeof id!=='string'||!/^[A-Za-z0-9_.:-]{1,256}$/.test(id)||typeof h.sessionId!=='string'||h.sessionId.length===0)throw fail('CAPTURE_METADATA_UNAVAILABLE');
          const intent=await bounded(()=>kv.get<Record<string,unknown>>(KV.embeddingRetry,id));
          item.retryIntent=!intent?'absent':intent.id===id&&intent.sessionId===h.sessionId?'present':'identity_conflict';
          item.intentPhase=intent&&typeof intent.phase==='string'&&['queued','embedded'].includes(intent.phase)?intent.phase:'unknown';
          const marker=await bounded(()=>kv.get<Record<string,unknown>>(KV.embeddingCommitted,id));
          item.publicationMarker=!marker?'absent':marker.id===id&&marker.sessionId===h.sessionId?'present_unverified':'identity_conflict';
          item.nextStep=[item.completionReceipt,item.retryIntent,item.publicationMarker].includes('identity_conflict')?'investigate_identity':item.completionReceipt==='deleted'?'respect_deletion':item.completionReceipt==='unavailable'?'metadata_unavailable':item.completionReceipt==='completed_metadata'?'verify_existing_completion':'verify_source_and_inbox';
        }catch{item.nextStep=item.completionReceipt==='deleted'?'respect_deletion':item.completionReceipt==='identity_conflict'?'investigate_identity':'metadata_unavailable';}
        items.push(item);
      }
      return{version:1,evidence:'recorded_capture_review_metadata',consistency:'non_atomic_live_metadata',referenceEpoch:epoch,referenceScope:'process_epoch',observedAt:new Date().toISOString(),totalRecorded:filtered.length,invalidMetadataRows:histories.length-valid.length,items,nextOffset:offset+limit<filtered.length?offset+limit:null,sourceRead:false,inboxRead:false,readOnly:true};
    }catch(error){
      if(error instanceof Error&&'code'in error&&error.code==='CAPTURE_METADATA_REFERENCE_UNKNOWN')throw error;
      throw fail('CAPTURE_METADATA_UNAVAILABLE');
    }finally{closed=true;void Promise.allSettled([...outstanding]).then(()=>{active=false;});}
  };
}
