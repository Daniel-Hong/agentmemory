import type {StateKV} from '../state/kv.js';
import type {HookPayload,CompressedObservation} from '../types.js';
import {KV} from '../state/schema.js';
import {captureEventScope} from './event-record.js';
import {capturePayloadDigest,captureSourceDigest} from './receipt-digest.js';
import {backgroundPaused} from '../ops/background-control.mjs';
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
 return !!obs&&obs.id===id&&obs.sessionId===payload.sessionId&&obs.captureKey===key&&!!raw&&raw.captureKey===key&&raw.eventId===eventId&&raw.sessionId===payload.sessionId&&raw.hookType===payload.hookType&&raw.timestamp===payload.timestamp&&captureSourceDigest(raw.hookType,raw.timestamp,raw.raw)===capturePayloadDigest(payload);
}
export function sdkSourceKeys(payload:HookPayload,key:string,id:string){return [{scope:KV.captureInbox,key},{scope:KV.observations(payload.sessionId),key:id},{scope:KV.captureReview,key},{scope:captureEventScope(key),key}];}
export async function assertSdkSourceClaim(kv:StateKV,payload:HookPayload,claim:SdkSourceClaim):Promise<void>{
 requireSdkSourceWriter(kv);
 const rec=await kv.get<any>(KV.captureInbox,claim.key);
 if(!rec||rec.storageCompletion!=='sdk'||rec.status==='dead'||rec.key!==claim.key||rec.observationId!==payload.observationId||rec.eventId!==payload.eventId||payload.captureKey!==claim.key||rec.sdkRestoreRequestId!==claim.requestId||rec.sdkRestoreState!=='pending'||!sameSdkSource(rec.payload,payload))throw sdkSourceFailure('SDK_SOURCE_CHANGED');
 if(await kv.get(KV.captureReview,claim.key)||await kv.get(captureEventScope(claim.key),claim.key))throw sdkSourceFailure('SDK_SOURCE_LEGACY_PROTECTED');
}
