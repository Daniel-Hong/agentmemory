import {readSdkOriginal,parseSentMark,reconcileSent,retainSent,retainSdkOriginal,type SpoolRecord,type SendOutcome,type SpoolPolicy} from './spool.js';

type Response={status:number;body:unknown};
export async function sendCapture(record:Pick<SpoolRecord,'eventId'|'body'|'requireReceipt'>,post:(body:Record<string,unknown>)=>Promise<Response>,url:string,options:{dir?:string;policy?:SpoolPolicy;fresh?:boolean}={}):Promise<SendOutcome>{
 const sdk=!record.requireReceipt&&(options.fresh||record.body.captureCompletion==='sdk-v1');
 const body={...record.body,...(sdk?{captureCompletion:'sdk-v1'}:{})};
 if(!sdk)delete body.captureCompletion;
 if(sdk&&!retainSdkOriginal(url,record.eventId,body,options))return 'retry';
 const result=await post(body);
 const value=result.body&&typeof result.body==='object'?result.body as Record<string,unknown>:{};
 if(result.status===503&&value.reason==='SDK_COMPLETION_ONLY')return 'held';
 if(result.status>=200&&result.status<300){
  if(value.completion==='sdk'){
   if(!sdk||value.completed!==true||value.durable!==false||value.eventId!==record.eventId)return 'retry';
   return value.status==='duplicate'?'duplicate':'delivered';
  }
  const mark=parseSentMark(value);
  if(record.requireReceipt&&(!mark||typeof value.observationId!=='string'||!value.observationId||value.success===false||value.error))return 'retry';
  if(mark){reconcileSent(url,mark.bootId,options);if(!retainSent(url,record.eventId,record.body,mark,{...options,requireReceipt:record.requireReceipt,preserveImages:record.requireReceipt}))return 'retry';}
  return value.status==='duplicate'?'duplicate':'delivered';
 }
 return result.status===0||result.status===408||result.status===429||result.status>=500?'retry':'rejected';
}

export type SdkSourceRestoreResult={completed:boolean;status:'restored'|'duplicate'|'held';code?:string};
export async function restoreSdkSourcePayload(body:Record<string,unknown>,post:(body:Record<string,unknown>)=>Promise<Response>):Promise<SdkSourceRestoreResult>{
 try{
  const result=await post({...body,captureCompletion:'sdk-v1'}),value=result.body as Record<string,unknown>|null;
  if(result.status>=200&&result.status<300&&value?.completed===true&&value.completion==='sdk'&&value.durable===false&&value.sourceRestore==='sdk-v1'&&value.eventId===body.eventId&&(value.status==='restored'||value.status==='duplicate'))return {completed:true,status:value.status};
  return {completed:false,status:'held',code:typeof value?.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(value.code)?value.code:'SDK_SOURCE_RESTORE_UNSUPPORTED'};
 }catch{return {completed:false,status:'held',code:'SDK_SOURCE_RESTORE_UNCERTAIN'};}
}
export async function restoreSdkOriginal(url:string,eventId:string,post:(body:Record<string,unknown>)=>Promise<Response>,options:{dir?:string;policy?:SpoolPolicy}={}):Promise<SdkSourceRestoreResult>{
 try{return await restoreSdkSourcePayload(readSdkOriginal(url,eventId,options),post);}catch{return {completed:false,status:'held',code:'SDK_SOURCE_SELECTION_UNAVAILABLE'};}
}
