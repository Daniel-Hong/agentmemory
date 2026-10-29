import type {StateKV} from '../state/kv.js';
import type {HookPayload,CompressedObservation,CaptureReviewHistory} from '../types.js';
import {KV} from '../state/schema.js';
import {captureEventScope} from './event-record.js';
import {capturePayloadDigest,captureSourceDigest} from './receipt-digest.js';
import {backgroundPaused} from '../ops/background-control.mjs';
import{committedSdkResolution}from'./sdk-resolution-record.js';
export type SdkSourceClaim={key:string;requestId:string};
export const sdkSourceFailure=(code:string)=>Object.assign(Error(code),{code});
export function requireSdkSourceWriter(kv:StateKV):void{
 if(kv.backend!=='file'||kv.durability?.completion!=='sdk')throw sdkSourceFailure('SDK_SOURCE_UNSUPPORTED');
 if(!kv.recoveryWrite||!kv.recoveryMutationSafe||kv.mutationOutcomeUncertain)throw sdkSourceFailure('SDK_SOURCE_WRITER_UNVERIFIED');
 if(backgroundPaused())throw sdkSourceFailure('SDK_SOURCE_PAUSED');
}
export function sameSdkSource(a:HookPayload,b:HookPayload):boolean{
 return ['sessionId','project','cwd','hookType','timestamp'].every(k=>(a as any)[k]===(b as any)[k])&&capturePayloadDigest(a)===capturePayloadDigest(b);
}
export function sdkObservationMatches(obs:CompressedObservation|null,payload:HookPayload,key:string,id:string,eventId:string):boolean{
 const raw=obs?.sourceRaw;
 return !!obs&&obs.id===id&&obs.sessionId===payload.sessionId&&obs.captureKey===key&&!!raw&&raw.id===id&&raw.captureKey===key&&raw.eventId===eventId&&raw.sessionId===payload.sessionId&&raw.hookType===payload.hookType&&raw.timestamp===payload.timestamp&&captureSourceDigest(raw.hookType,raw.timestamp,raw.raw)===capturePayloadDigest(payload);
}
export function sdkSourceKeys(payload:HookPayload,key:string,id:string){return [{scope:KV.captureInbox,key},{scope:KV.observations(payload.sessionId),key:id},{scope:KV.captureReview,key},{scope:captureEventScope(key),key}];}
export async function assertSdkSourceLegacyProtection(kv:StateKV,payload:HookPayload,key:string,id:string,eventId:string):Promise<void>{
 const[history,receipt,rec]=await Promise.all([kv.get<CaptureReviewHistory>(KV.captureReview,key),kv.get<any>(captureEventScope(key),key),kv.get<any>(KV.captureInbox,key)]);
 if(!history&&!receipt)return;
 if(!committedSdkResolution(history,rec)||rec.key!==key||rec.observationId!==id||rec.eventId!==eventId||rec.sessionId!==payload.sessionId||!sameSdkSource(rec.payload,payload))throw sdkSourceFailure('SDK_SOURCE_LEGACY_PROTECTED');
 if(receipt&&(receipt.state==='deleted'||receipt.key!==key||receipt.eventId!==eventId||receipt.sessionId!==payload.sessionId||receipt.observationId!==id||receipt.state!==undefined&&receipt.state!=='completed'))throw sdkSourceFailure('SDK_SOURCE_LEGACY_PROTECTED');
}
export async function assertSdkSourceClaim(kv:StateKV,payload:HookPayload,claim:SdkSourceClaim):Promise<void>{
 requireSdkSourceWriter(kv);
 const rec=await kv.get<any>(KV.captureInbox,claim.key);
 if(!rec||rec.storageCompletion!=='sdk'||rec.status==='dead'||rec.key!==claim.key||rec.observationId!==payload.observationId||rec.eventId!==payload.eventId||payload.captureKey!==claim.key||rec.sdkRestoreRequestId!==claim.requestId||rec.sdkRestoreState!=='pending'||!sameSdkSource(rec.payload,payload))throw sdkSourceFailure('SDK_SOURCE_CHANGED');
 await assertSdkSourceLegacyProtection(kv,payload,claim.key,rec.observationId,rec.eventId);
}
