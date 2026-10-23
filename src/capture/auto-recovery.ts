import type {CaptureRecoveryCheckpoint} from "../types.js";
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {StateKV} from '../state/kv.js';
import {withKeyedLock} from '../state/keyed-mutex.js';
import {KV} from '../state/schema.js';
import {captureEventScope} from './event-record.js';
import {capturePayloadDigest,captureSourceDigest} from './receipt-digest.js';

const SCOPE=KV.captureRecovery;
const SAFE_REASONS=new Set(['PUBLICATION_PENDING', 'PUBLICATION_WAIT_EXHAUSTED', 'ADMISSION_HELD', 'CHECK_PENDING', 'COMPLETION_PROOF_PENDING', 'VERIFIED_DURABLE', 'VERIFICATION_BUDGET_EXHAUSTED', 'VERIFICATION_PENDING', 'DELETION_RECORDED', 'IDENTITY_CONFLICT', 'SOURCE_MISSING', 'SOURCE_UNSUPPORTED', 'SOURCE_MISMATCH', 'GENERATION_CHANGED', 'INTENT_ACTIVE_OR_UNSUPPORTED', 'PUBLICATION_UNVERIFIED', 'INDEX_RESTORATION_REQUIRED', 'MANUAL_OR_ACTIVE_RETRY', 'REQUEST_REQUIRES_MANUAL_RESTORE', 'RECEIPT_CONFLICT', 'MANUAL_OR_UNKNOWN_COMPLETION', 'STATE_CHANGED', 'COMPLETION_UNVERIFIED', 'ADMISSION_CHANGED', 'FAILURE_UNCLASSIFIED']);
const COOLDOWN=60_000,BREAKER_MS=30*60_000,MAX_PROOFS=3;
type Phase='checking'|'verifying'|'resolved'|'blocked';
type Row=CaptureRecoveryCheckpoint;
type Control={version:1;kind:'control';failures:number;openUntil:number};
export interface CaptureAutoRecoveryOptions {enabled:boolean;writerOwned:()=>boolean;admitted:()=>boolean;indexReady:(obs:any)=>boolean;now?:()=>number}
const fail=(reason:string)=>Object.assign(Error(reason),{recoveryReason:reason});
function validRow(v:any):v is Row{return v?.version===1&&v.kind==='item'&&/^cap_[a-f0-9]{40}$/.test(v.key)&&typeof v.id==='string'&&['sessionId','observationId','eventId'].every(k=>typeof v[k]==='string'&&v[k])&&/^[a-f0-9]{64}$/.test(v.sourceDigest)&&/^[a-f0-9]{64}$/.test(v.projection)&&['checking','verifying','resolved','blocked'].includes(v.phase)&&Number.isSafeInteger(v.verificationAttempts)&&v.verificationAttempts>=0&&v.verificationAttempts<=MAX_PROOFS&&Number.isFinite(v.nextAttemptAt)&&v.nextAttemptAt>=0;}
export function createCaptureAutoRecovery(kv:StateKV,options:CaptureAutoRecoveryOptions){
 const now=options.now??Date.now;let busy=false,halted=false;
 let view={enabled:options.enabled,supported:false,phase:'idle',resolved:0,verifying:0,blocked:0,reasonCounts:{}as Record<string,number>,breakerUntil:0,lastCheckedAt:null as string|null,lastErrorCode:null as string|null};
 const admitted=()=>options.enabled&&!halted&&kv.recoveryMutationSafe&&options.writerOwned()&&!!kv.recoveryWrite&&kv.backend==='file'&&!!kv.durability&&options.admitted();
 async function persist(row:Row|Control){const key=row.kind==='item'?row.key:'control';await kv.set(SCOPE,key,row);const result=await kv.durability!.waitForKeys(kv,[{scope:SCOPE,key}],{deadline:now()+15_000,expectedValues:[row]});if(!result.synced||result.mutationFailures!==0)throw fail('RECOVERY_CHECKPOINT_UNVERIFIED');}
 async function refresh(){
  const all=await kv.list<any>(SCOPE);if(all.length>5001||all.some(r=>r?.kind==='item'&&!validRow(r)))throw fail('RECOVERY_STATE_UNSUPPORTED');
  const rows=all.filter(validRow),control=all.find(r=>r?.kind==='control') as Control|undefined;
  if(control&&(control.version!==1||!Number.isSafeInteger(control.failures)||control.failures<0||!Number.isFinite(control.openUntil)||control.openUntil<0))throw fail('RECOVERY_STATE_UNSUPPORTED');
  const counts:Record<string,number>={};for(const r of rows)if(r.phase!=='resolved'){const reason=SAFE_REASONS.has(r.reason)?r.reason:'RECOVERY_STATE_UNSUPPORTED';counts[reason]=(counts[reason]??0)+1;}
  view={...view,supported:kv.recoveryMutationSafe&&!!kv.recoveryWrite&&kv.backend==='file'&&!!kv.durability&&options.writerOwned(),resolved:rows.filter(r=>r.phase==='resolved').length,verifying:rows.filter(r=>['checking','verifying'].includes(r.phase)).length,blocked:rows.filter(r=>r.phase==='blocked').length,reasonCounts:counts,breakerUntil:control?.openUntil??0,lastCheckedAt:new Date(now()).toISOString()};
  return {rows,control:control??{version:1,kind:'control',failures:0,openUntil:0}as Control};
 }
 function keys(row:Row){return [{scope:KV.captureReview,key:row.key},{scope:KV.captureInbox,key:row.key},{scope:KV.observations(row.sessionId),key:row.observationId},{scope:'mem:embedding-retry:v1',key:row.observationId},{scope:'mem:embedding-committed:v1',key:row.observationId},{scope:captureEventScope(row.key),key:row.key}];}
 async function read(row:Row){return Promise.all(keys(row).map(p=>kv.get<any>(p.scope,p.key)));}
 function check(row:Row,values:any[],allowCompleted:boolean){
  const [history,inbox,obs,intent,marker,receipt]=values;
  if(receipt?.state==='deleted')throw fail('DELETION_RECORDED');
  if(!history||history.key!==row.key||history.eventId!==row.eventId||history.sessionId!==row.sessionId||history.observationId!==row.observationId)throw fail('IDENTITY_CONFLICT');
  const raw=obs?.sourceRaw;
  if(!obs||!raw)throw fail('SOURCE_MISSING');
  if(obs.id!==row.observationId||obs.sessionId!==row.sessionId||obs.captureKey!==row.key||raw.id!==row.observationId||raw.sessionId!==row.sessionId||raw.captureKey!==row.key||raw.eventId!==row.eventId)throw fail('IDENTITY_CONFLICT');
  if(typeof raw.hookType!=='string'||typeof raw.timestamp!=='string'||!Object.hasOwn(raw,'raw')||typeof obs.title!=='string'||typeof obs.narrative!=='string')throw fail('SOURCE_UNSUPPORTED');
  if(captureSourceDigest(raw.hookType,raw.timestamp,raw.raw)!==row.sourceDigest)throw fail('SOURCE_MISMATCH');
  if(createHash('sha256').update((obs.title+' '+obs.narrative).slice(0,16000)).digest('hex')!==row.projection)throw fail('GENERATION_CHANGED');
  if(intent!==null&&intent!==undefined){if(intent.id===row.observationId&&intent.sessionId===row.sessionId&&['synthetic','observation'].includes(intent.kind)&&['queued','embedded'].includes(intent.phase)&&typeof intent.generation==='string'&&intent.fingerprint===row.projection)throw fail('PUBLICATION_PENDING');throw fail('INTENT_ACTIVE_OR_UNSUPPORTED');}
  if(!marker||!['observation','synthetic'].includes(marker.kind)||marker.id!==row.observationId||marker.sessionId!==row.sessionId||marker.fingerprint!==row.projection)throw fail('PUBLICATION_UNVERIFIED');
  if(!options.indexReady(obs))throw fail('INDEX_RESTORATION_REQUIRED');
  if(inbox){
   if(inbox.key!==row.key||inbox.eventId!==row.eventId||inbox.sessionId!==row.sessionId||inbox.observationId!==row.observationId||inbox.eventSource!=='client')throw fail('IDENTITY_CONFLICT');
   if(inbox.status!=='dead'||inbox.manualRequestId)throw fail('MANUAL_OR_ACTIVE_RETRY');
   if(!inbox.payload||inbox.payload.hookType==='prompt_submit')throw fail('REQUEST_REQUIRES_MANUAL_RESTORE');
   if(inbox.payload.sessionId!==row.sessionId||inbox.payload.project!==history.project||inbox.project!==history.project||row.key!=='cap_'+createHash('sha256').update(`${history.project}\u0000${row.sessionId}\u0000${row.eventId}`).digest('hex').slice(0,40))throw fail('IDENTITY_CONFLICT');
   if(capturePayloadDigest(inbox.payload)!==row.sourceDigest)throw fail('SOURCE_MISMATCH');
  }
  if(receipt&&(receipt.key!==row.key||receipt.eventId!==row.eventId||receipt.sessionId!==row.sessionId||receipt.observationId!==row.observationId||receipt.state!==undefined))throw fail('RECEIPT_CONFLICT');
  if(history.status==='completed'){
   if(history.automaticRecovery?.id!==row.id)throw fail('MANUAL_OR_UNKNOWN_COMPLETION');
   if(!allowCompleted)throw fail('STATE_CHANGED');
  }else if(history.status!=='dead')throw fail('MANUAL_OR_ACTIVE_RETRY');
  if(!inbox&&(!receipt||history.status!=='completed'))throw fail('COMPLETION_UNVERIFIED');
 }
 async function certify(row:Row,values:any[]){const r=await kv.durability!.waitForKeys(kv,keys(row),{deadline:now()+15_000,expectedValues:values});if(!r.synced||r.mutationFailures!==0)throw Error('certificate_unavailable');if(!isDeepStrictEqual(values,await read(row)))throw Error('certificate_changed');}
 async function drive(row:Row,control:Control){
  await withKeyedLock('capture:'+row.key,async()=>{
   if(!admitted())return;
   try{
    let before=await read(row);check(row,before,true);
    if(before[1]){
     view.phase='verifying_source';await certify(row,before);
     row={...row,phase:'verifying',reason:'COMPLETION_PROOF_PENDING',updatedAt:new Date(now()).toISOString()};await persist(row);
     await kv.recoveryWrite!.exclusive(keys(row),async()=>{
      if(!admitted())throw fail('ADMISSION_CHANGED');
      const current=await read(row);check(row,current,true);if(!isDeepStrictEqual(before,current))throw fail('STATE_CHANGED');
      const [history,inbox,,,,receipt]=current;const completedAt=history.recoveredAt??row.createdAt;
      await kv.set(KV.captureReview,row.key,{...history,status:'completed',updatedAt:completedAt,recoveredAt:completedAt,automaticRecovery:{id:row.id,completedAt}});
      if(!receipt)await kv.set(captureEventScope(row.key),row.key,{key:row.key,eventId:row.eventId,sessionId:row.sessionId,project:inbox.project??inbox.payload.project,observationId:row.observationId,acceptedAt:inbox.acceptedAt,completedAt,attempts:inbox.attempts});
      await kv.delete(KV.captureInbox,row.key);
     });
    }
    view.phase='verifying_completion';before=await read(row);check(row,before,true);if(before[1]||before[0]?.status!=='completed'||!before[5])throw fail('COMPLETION_UNVERIFIED');await certify(row,before);
    await kv.recoveryWrite!.exclusive(keys(row),async()=>{if(!admitted())throw fail('ADMISSION_CHANGED');const after=await read(row);check(row,after,true);if(!isDeepStrictEqual(before,after))throw Error('certificate_changed');});
    row={...row,phase:'resolved',reason:'VERIFIED_DURABLE',updatedAt:new Date(now()).toISOString()};await persist(row);await persist({...control,failures:0,openUntil:0});
   }catch(error:any){
    if(!admitted()){if(!kv.recoveryMutationSafe||!options.writerOwned())throw error;await persist({...row,reason:'ADMISSION_HELD',nextAttemptAt:now()+COOLDOWN});return;}
    if(error?.recoveryReason==='PUBLICATION_PENDING'){const attempts=row.verificationAttempts+1;await persist({...row,verificationAttempts:attempts,phase:attempts>=MAX_PROOFS?'blocked':'checking',reason:attempts>=MAX_PROOFS?'PUBLICATION_WAIT_EXHAUSTED':'PUBLICATION_PENDING',nextAttemptAt:now()+COOLDOWN*2**(attempts-1)});return;}
    if(error?.recoveryReason==='ADMISSION_CHANGED'){await persist({...row,reason:'ADMISSION_HELD',nextAttemptAt:now()+COOLDOWN});return;}
    let reason=error?.recoveryReason==='RECOVERY_CHECKPOINT_UNVERIFIED'?undefined:error?.recoveryReason;
    if(!reason){try{check(row,await read(row),true);}catch(current:any){reason=current?.recoveryReason;}}
    if(reason){row={...row,phase:'blocked',reason,updatedAt:new Date(now()).toISOString()};}
    else {const attempts=row.verificationAttempts+1;row={...row,verificationAttempts:attempts,phase:attempts>=MAX_PROOFS?'blocked':row.phase==='checking'?'checking':'verifying',reason:attempts>=MAX_PROOFS?'VERIFICATION_BUDGET_EXHAUSTED':'VERIFICATION_PENDING',nextAttemptAt:now()+COOLDOWN*2**(attempts-1),updatedAt:new Date(now()).toISOString()};const failures=control.failures+1;await persist({...control,failures,openUntil:failures>=3?now()+BREAKER_MS:control.openUntil});}
    await persist(row);
   }
  });
 }
 return {
  snapshot:()=>structuredClone(view),
  async tick(){
   if(busy||!options.enabled)return;busy=true;
   try{await withKeyedLock('capture-auto-recovery',async()=>{
    const {rows,control}=await refresh();if(!admitted()||control.openUntil>now()){view.lastErrorCode=kv.recoveryMutationSafe?null:'WRITER_EPOCH_UNVERIFIED';return;}
    let row=rows.find(r=>['checking','verifying'].includes(r.phase)&&r.nextAttemptAt<=now());
    if(!row){
     const histories=await kv.list<any>(KV.captureReview);if(histories.length>5000)throw fail('RECOVERY_HISTORY_LIMIT');
     const h=histories.filter(h=>h?.status==='dead'&&typeof h.updatedAt==='string'&&Number.isFinite(Date.parse(h.updatedAt))&&Date.parse(h.updatedAt)+COOLDOWN<=now()&&!rows.some(r=>r.key===h.key)).sort((a,b)=>a.acceptedAt.localeCompare(b.acceptedAt))[0];
     if(!h)return;
     const inbox=await kv.get<any>(KV.captureInbox,h.key);const obs=await kv.get<any>(KV.observations(h.sessionId),h.observationId);
     let digest='0'.repeat(64),projection='0'.repeat(64);try{if(inbox?.payload)digest=capturePayloadDigest(inbox.payload);if(typeof obs?.title==='string'&&typeof obs?.narrative==='string')projection=createHash('sha256').update((obs.title+' '+obs.narrative).slice(0,16000)).digest('hex');}catch{}
     row={version:1,kind:'item',key:h.key,id:randomUUID(),sessionId:h.sessionId,observationId:h.observationId,eventId:h.eventId,sourceDigest:digest,projection,phase:'checking',reason:'CHECK_PENDING',createdAt:new Date(now()).toISOString(),updatedAt:new Date(now()).toISOString(),verificationAttempts:0,nextAttemptAt:now()};
     if(!validRow(row))throw fail('RECOVERY_STATE_UNSUPPORTED');
     const known=h.failures?.at(-1)?.code==='CAPTURE_STORE_TIMEOUT'||typeof inbox?.lastError==='string'&&/^invocation_failed:\s*embedding_intent_changed$/.test(inbox.lastError);
     if(!known)row={...row,phase:'blocked',reason:'FAILURE_UNCLASSIFIED'};
     await persist(row);if(row.phase==='blocked')return;
    }
    await drive(row,control);
   });await refresh();}
   catch{halted=true;view={...view,lastErrorCode:'RECOVERY_STORAGE_OR_STATE_UNAVAILABLE',phase:'halted'};}
   finally{busy=false;if(!halted)view.phase='idle';}
  },
 };
}
