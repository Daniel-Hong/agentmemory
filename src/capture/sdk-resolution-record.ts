import type{CaptureReviewHistory,CaptureSdkResolution}from'../types.js';
import{captureSourceDigest}from'./receipt-digest.js';
import{capturePayloadDigest}from'./receipt-digest.js';
const sha=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const sdkResolutionRequestId=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const date=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v));
export function captureFailureHistoryDigest(h:CaptureReviewHistory):string{
 return captureSourceDigest('sdk-resolution-history','v1',{failures:h.failures,requests:h.requests,totalAttempts:h.totalAttempts,cycleAttempts:h.cycleAttempts,manualRetries:h.manualRetries,acceptedAt:h.acceptedAt,automaticRecovery:h.automaticRecovery??null});
}
export function validSdkResolution(r:unknown):r is CaptureSdkResolution{
 const v=r as CaptureSdkResolution|undefined;
 return !!v&&v.version===1&&v.completion==='sdk'&&['pending','committed'].includes(v.phase)&&sdkResolutionRequestId(v.requestId)&&sha(v.sourceDigest)&&sha(v.initialProjection)&&sha(v.priorFailureDigest)&&v.priorInboxState==='dead'&&date(v.startedAt)&&
  (v.phase==='pending'||date(v.completedAt)&&sha(v.verifiedProjection));
}
export function committedSdkResolution(history:CaptureReviewHistory|null|undefined,rec:any):boolean{
 const r=history?.sdkResolution;
 if(!history||history.status!=='completed'||!validSdkResolution(r)||r.phase!=='committed'||!rec||rec.storageCompletion!=='sdk'||rec.status!=='pending'||rec.sdkResolutionId!==r.requestId||rec.sdkResolutionState!=='committed'||history.key!==rec.key||history.eventId!==rec.eventId||history.sessionId!==rec.sessionId||history.observationId!==rec.observationId||history.project!==rec.project||history.hookType!==rec.hookType||rec.payload?.sessionId!==rec.sessionId||rec.payload?.project!==rec.project||rec.payload?.hookType!==rec.hookType||r.priorFailureDigest!==captureFailureHistoryDigest(history)||!rec.payload)return false;
 try{return capturePayloadDigest(rec.payload)===r.sourceDigest;}catch{return false;}
}
