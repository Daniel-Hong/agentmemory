import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {SdkSpoolV2,type SdkSpoolV2Options} from './sdk-spool-v2.js';
export {SdkSpoolV2} from './sdk-spool-v2.js';
export const SDK_CAPTURE_V2_FLAG='--agentmemory-sdk-capture-v2';
export type V2PostResult={status:number;body:unknown;notSent?:boolean};
export type V2PostBudget={deadline:number;remainingMs:number};
export type V2Post=(body:Record<string,unknown>,budget?:V2PostBudget)=>Promise<V2PostResult>;
export type V2Options={dir?:string;storeOptions?:Omit<SdkSpoolV2Options,'dir'>};
export type V2DeliveryResult={outcome:'delivered'|'duplicate'|'spooled'|'held'|'dropped';code?:string;sourceAcknowledged:boolean;referenceAcknowledged:boolean;sdkReplyConfirmed?:boolean};
const STORE_CODES=new Set(['SOURCE_TOO_LARGE','ORIGINALS_FULL','QUEUE_FULL','SOURCE_CONFLICT','SOURCE_UNVERIFIED','SOURCE_HELD','SOURCE_BACKOFF','STORE_BUSY','STORE_IO','STORE_OPTIONS_INVALID','STORE_UNSAFE','STORE_LOCK_UNSUPPORTED']);
function safeCode(error:unknown){const code=(error as {code?:unknown})?.code;return typeof code==='string'&&STORE_CODES.has(code)?code:'STORE_OR_DELIVERY_UNCONFIRMED';}
function createStore(options:V2Options){return new SdkSpoolV2({...options.storeOptions,dir:options.dir});}
function held(code:string,sourceAcknowledged=true,referenceAcknowledged=true):V2DeliveryResult{return {outcome:'held',code,sourceAcknowledged,referenceAcknowledged};}
async function park(store:SdkSpoolV2,target:string,sourceId:string,code:string){try{await store.hold(target,sourceId,code);}catch{return held('QUEUE_STATE_UNCONFIRMED');}return held(code);}
async function sendReference(store:SdkSpoolV2,target:string,sourceId:string,post:V2Post,deadline?:number):Promise<V2DeliveryResult>{
 try{await store.markSending(target,sourceId);}catch(error){
  const code=(error as {code?:unknown})?.code;
  if(code==='SOURCE_BACKOFF')return {outcome:'spooled',sourceAcknowledged:true,referenceAcknowledged:true};
  return held(code==='SOURCE_SENDING'?'SDK_SEND_IN_PROGRESS_OR_UNCERTAIN':safeCode(error));
 }
 let body:Record<string,unknown>;
 try{body=await store.load(target,sourceId);}catch{return park(store,target,sourceId,'SOURCE_UNVERIFIED');}
 let response:V2PostResult;
 const budget=deadline===undefined?undefined:{deadline,remainingMs:Math.max(0,Math.floor(deadline-performance.now()))};
 try{response=budget&&budget.remainingMs<=0?{status:0,body:null,notSent:true}:await post(body,budget);}catch{return park(store,target,sourceId,'SDK_SEND_UNCERTAIN');}
 const value=response.body&&typeof response.body==='object'?response.body as Record<string,unknown>:{};
 if(response.status>=200&&response.status<300&&value.eventId===body.eventId&&value.completion==='sdk'&&value.completed===true&&value.durable===false){
  try{await store.acknowledge(target,sourceId);}catch{return {...held('SDK_ACK_STATE_UNCONFIRMED'),sdkReplyConfirmed:true};}
  return {outcome:value.status==='duplicate'?'duplicate':'delivered',sourceAcknowledged:true,referenceAcknowledged:true,sdkReplyConfirmed:true};
 }
 const knownNotSent=response.status===0&&response.notSent===true;
 const knownAdmissionRejection=response.status===503&&value.status==='rejected'&&value.retryable===true&&value.eventId===body.eventId;
 if(knownNotSent||knownAdmissionRejection){
  try{await store.retry(target,sourceId,'RETRY');}catch{return held('QUEUE_STATE_UNCONFIRMED');}
  return {outcome:'spooled',code:knownNotSent?'SDK_CONNECTION_NOT_ESTABLISHED':'SDK_ADMISSION_REJECTED',sourceAcknowledged:true,referenceAcknowledged:true};
 }
 return park(store,target,sourceId,response.status===503&&value.reason==='SDK_COMPLETION_ONLY'?'SDK_COMPLETION_ONLY':'SDK_ACK_UNVERIFIED');
}
export async function deliverSdkCaptureV2(target:string,body:Record<string,unknown>,post:V2Post,options:V2Options={}):Promise<V2DeliveryResult>{
 let store:SdkSpoolV2,sourceId:string,storedBody:Record<string,unknown>;
 try{
  store=createStore(options);
  if(typeof body.eventId!=='string'||!body.eventId) return {outcome:'dropped',code:'SOURCE_UNVERIFIED',sourceAcknowledged:false,referenceAcknowledged:false};
  const retained=await store.retain(target,body.eventId,body);sourceId=retained.sourceId;storedBody=retained.body;
  if(retained.conflict)return held('SOURCE_CONFLICT',true,false);
  if(retained.completed)return {outcome:'duplicate',sourceAcknowledged:true,referenceAcknowledged:true,sdkReplyConfirmed:true};
 }catch(error){return {outcome:'dropped',code:safeCode(error),sourceAcknowledged:false,referenceAcknowledged:false};}
 try{await store.enqueue(target,sourceId);}catch(error){return {outcome:'dropped',code:safeCode(error),sourceAcknowledged:true,referenceAcknowledged:false};}
 const sent=await sendReference(store,target,sourceId,post);
 if(sent.code==='SOURCE_HELD'){
  try{if((await store.retain(target,storedBody.eventId as string,storedBody)).completed)return {outcome:'duplicate',sourceAcknowledged:true,referenceAcknowledged:true,sdkReplyConfirmed:true};}catch{}
 }
 return sent;
}
export async function drainSdkCapturesV2(target:string,post:V2Post,options:V2Options&{limit?:number;budgetMs?:number;deadline?:number}={}){
 const result={attempted:0,delivered:0,duplicates:0,held:0,remaining:0,error:undefined as string|undefined};
 const limit=Math.min(8,Math.max(0,options.limit??8)),budget=Math.min(1500,Math.max(0,options.budgetMs??1500)),start=performance.now();
 const deadline=Math.min(options.deadline??Infinity,start+budget);
 try{
  const store=createStore(options),records=await store.pending(target);
  for(const ref of records){
   if(ref.state==='held'){result.held++;continue;}
   if(ref.state==='sending'||ref.nextAttemptAt>Date.now()||result.attempted>=limit||performance.now()>=deadline)continue;
   result.attempted++;
   const sent=await sendReference(store,target,ref.sourceId,post,deadline);
   if(sent.outcome==='delivered')result.delivered++;
   else if(sent.outcome==='duplicate')result.duplicates++;
   else if(sent.outcome==='held'||sent.outcome==='dropped')result.held++;
  }
  result.remaining=(await store.pending(target)).length;
 }catch(error){result.error=safeCode(error);result.remaining=Math.max(1,result.remaining);}
 return result;
}
function hasImage(value:unknown):boolean{
 if(typeof value==='string')return value.startsWith('data:image/')||value.startsWith('iVBORw0KGgo')||value.startsWith('/9j/');
 if(value&&typeof value==='object'){
  const data=value as Record<string,unknown>;
  if(['image_data','image_path','imageBase64','imagePath'].some(key=>typeof data[key]==='string'&&!!data[key]))return true;
  return Object.values(data).some(hasImage);
 }
 return false;
}
// Operator-only. Callers must durably record a one-shot intent before invoking this function.
// A lost response stays held and requires inspection, never automatic re-submission.
export async function restoreSelectedSdkCaptureV2(target:string,sourceId:string,post:V2Post,options:V2Options={}){
 const store=createStore(options);
 let body:Record<string,unknown>,observationId:string;
 try{body=await store.load(target,sourceId);}
 catch(error){return {sourceRetained:false,completion:'sdk' as const,durable:false,completed:false,status:'held' as const,code:safeCode(error)};}
 const retained={sourceRetained:true,completion:'sdk' as const,durable:false};
 try{
  if(body.captureCompletion!=='sdk-v1'||Object.keys(body).some(key=>!['eventId','captureCompletion','hookType','sessionId','project','cwd','timestamp','data'].includes(key))||
     Buffer.byteLength(JSON.stringify(body))>256*1024||hasImage(body.data))return {...retained,completed:false,status:'held' as const,code:'SDK_SOURCE_FORMAT_UNSUPPORTED'};
  if(!['eventId','hookType','sessionId','project','cwd','timestamp'].every(key=>typeof body[key]==='string'&&(body[key] as string).length>0)||
     !/^[A-Za-z0-9_.:-]{8,128}$/.test(body.eventId as string))return {...retained,completed:false,status:'held' as const,code:'SDK_SOURCE_IDENTITY_INVALID'};
  const timestamp=Date.parse(body.timestamp as string);
  if(!Number.isFinite(timestamp)||timestamp<Date.UTC(2020,0,1)||timestamp>=Date.UTC(2100,0,1))return {...retained,completed:false,status:'held' as const,code:'SDK_SOURCE_IDENTITY_INVALID'};
  const key=createHash('sha256').update(body.project+'\0'+body.sessionId+'\0'+body.eventId).digest('hex');
  observationId='obs_'+timestamp.toString(36)+'_'+key.slice(0,12);
  const existing=await store.retain(target,body.eventId as string,body);
  if(existing.sourceId!==sourceId||existing.conflict)return {...retained,completed:false,status:'held' as const,code:'SOURCE_CONFLICT'};
  if(existing.completed)return {...retained,completed:true,status:'duplicate' as const,sdkReplyConfirmed:true};
  await store.markSending(target,sourceId,body);
 }catch(error){return {...retained,completed:false,status:'held' as const,code:safeCode(error)};}
 let response:V2PostResult;
 try{response=await post(body);}
 catch{
  try{await store.hold(target,sourceId,'SDK_RESTORE_OUTCOME_UNCERTAIN');}catch{}
  return {...retained,completed:false,status:'held' as const,code:'SDK_RESTORE_OUTCOME_UNCERTAIN'};
 }
 const value=response.body&&typeof response.body==='object'?response.body as Record<string,unknown>:{};
 const confirmed=(response.status===200||response.status===201)&&value.eventId===body.eventId&&value.observationId===observationId&&
   value.sourceRestore==='sdk-v1'&&value.completion==='sdk'&&value.completed===true&&value.durable===false&&
   (value.status==='restored'||value.status==='duplicate');
 if(!confirmed){
  try{await store.hold(target,sourceId,'SDK_RESTORE_OUTCOME_UNCERTAIN');}catch{}
  return {...retained,completed:false,status:'held' as const,code:'SDK_RESTORE_REPLY_UNVERIFIED'};
 }
 try{await store.acknowledge(target,sourceId);}
 catch{return {...retained,completed:false,status:'held' as const,code:'SDK_ACK_STATE_UNCONFIRMED',sdkReplyConfirmed:true};}
 return {...retained,completed:true,status:value.status as 'restored'|'duplicate',sdkReplyConfirmed:true};
}

export async function restoreSdkCaptureV2(target:string,sourceId:string,_post:V2Post,options:V2Options={}){
 try{
  const body=await createStore(options).load(target,sourceId);
  if(Buffer.byteLength(JSON.stringify(body))>256*1024||hasImage(body.data))return {completed:false,status:'held' as const,code:'SDK_SOURCE_FORMAT_UNSUPPORTED'};
  return {completed:false,status:'held' as const,code:'SDK_SOURCE_RESTORE_REQUIRES_REVIEW'};
 }catch{return {completed:false,status:'held' as const,code:'SOURCE_UNVERIFIED'};}
}
