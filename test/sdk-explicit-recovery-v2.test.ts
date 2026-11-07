import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import * as delivery from '../src/capture/sdk-delivery-v2.js';

const target='http://127.0.0.1:63000';
let dir:string;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'sdk-explicit-recovery-'));});
afterEach(()=>{vi.restoreAllMocks();rmSync(dir,{recursive:true,force:true});});
const payload=(eventId='selected-held-0001')=>({eventId,hookType:'post_tool_use',sessionId:'synthetic-session',project:'synthetic',cwd:'/synthetic',timestamp:'2026-11-02T00:00:00Z',captureCompletion:'sdk-v1',data:{text:'preserved fixture'}});
function restored(body:ReturnType<typeof payload>){
  const key=createHash('sha256').update(body.project+'\0'+body.sessionId+'\0'+body.eventId).digest('hex');
  return {status:201,body:{eventId:body.eventId,completion:'sdk',durable:false,sourceRestore:'sdk-v1',status:'restored',completed:true,
    observationId:'obs_'+Date.parse(body.timestamp).toString(36)+'_'+key.slice(0,12)}};
}
async function held(eventId='selected-held-0001'){
  const body=payload(eventId),store=new delivery.SdkSpoolV2({dir});
  await delivery.deliverSdkCaptureV2(target,body,async()=>({status:422,body:{}}),{dir});
  const sourceId=(await store.pending(target)).find(row=>row.sourceId===createHash('sha256').update(createHash('sha256').update(target).digest('hex')+'\0'+eventId).digest('hex'))!.sourceId;
  return {store,sourceId,body};
}
function reference(sourceId:string){return JSON.parse(readFileSync(join(dir,'queue',sourceId+'.ref'),'utf8'));}
function manifest(sourceId:string){return JSON.parse(readFileSync(join(dir,'originals',sourceId,'manifest.json'),'utf8'));}

it('explicit restore uses the exact retained source once, requires matched SDK identity, and preserves source bytes',async()=>{
  const {store,sourceId,body}=await held();const original=manifest(sourceId);
  const post=vi.fn(async(sent:any)=>{expect(sent).toEqual(body);expect(reference(sourceId)).toMatchObject({state:'sending',owner:{pid:process.pid}});return restored(body);});
  expect(await delivery.restoreSelectedSdkCaptureV2(target,sourceId,post,{dir})).toMatchObject({completed:true,status:'restored',sourceRetained:true,sdkReplyConfirmed:true,durable:false});
  expect(post).toHaveBeenCalledTimes(1);expect(manifest(sourceId)).toEqual({...original,completed:true});
  expect(await store.load(target,sourceId)).toEqual(body);expect(await store.pending(target)).toEqual([]);
  expect(await delivery.restoreSelectedSdkCaptureV2(target,sourceId,post,{dir})).toMatchObject({completed:true,status:'duplicate',sourceRetained:true});
  expect(post).toHaveBeenCalledTimes(1);
});

it('an uncertain response remains held and cannot be retried or acknowledged by an ordinary hook',async()=>{
  const {store,sourceId,body}=await held();const post=vi.fn(async()=>{throw Error('synthetic timeout');});
  expect(await delivery.restoreSelectedSdkCaptureV2(target,sourceId,post,{dir})).toMatchObject({completed:false,status:'held'});
  expect(reference(sourceId)).toMatchObject({state:'held'});
  expect(manifest(sourceId).completed).toBe(false);
  expect(post).toHaveBeenCalledTimes(1);
  await expect(store.acknowledge(target,sourceId)).rejects.toMatchObject({code:'SOURCE_HELD'});
  await expect(store.retry(target,sourceId,'retry')).rejects.toMatchObject({code:'SOURCE_HELD'});
  await expect(store.hold(target,sourceId,'hold')).rejects.toMatchObject({code:'SOURCE_HELD'});
  expect(await delivery.deliverSdkCaptureV2(target,body,post,{dir})).toMatchObject({outcome:'held'});
  expect(post).toHaveBeenCalledTimes(1);
});

it('rejects a mismatching restoration response and leaves the original unacknowledged',async()=>{
  const {sourceId,body}=await held();
  const response=restored(body);response.body.observationId='obs_wrong_000000000000';
  expect(await delivery.restoreSelectedSdkCaptureV2(target,sourceId,async()=>response,{dir})).toMatchObject({completed:false,status:'held'});
  expect(manifest(sourceId).completed).toBe(false);
});

it('excludes a concurrent manual restore and hook for the same original',async()=>{
  const {sourceId,body}=await held();let release!:(reply:any)=>void;let entered!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const post=vi.fn(()=>new Promise<any>(resolve=>{release=resolve;entered();}));
  const first=delivery.restoreSelectedSdkCaptureV2(target,sourceId,post,{dir});await started;
  expect(await delivery.restoreSelectedSdkCaptureV2(target,sourceId,post,{dir})).toMatchObject({completed:false,status:'held'});
  expect(await delivery.deliverSdkCaptureV2(target,body,post,{dir})).toMatchObject({outcome:'held'});
  release(restored(body));expect(await first).toMatchObject({completed:true});expect(post).toHaveBeenCalledTimes(1);
});

it('a crash after a durable source ACK allows local duplicate recognition without another POST',async()=>{
  const {sourceId,body,store}=await held();const post=vi.fn(async()=>restored(body));
  const first=await delivery.restoreSelectedSdkCaptureV2(target,sourceId,post,{dir,storeOptions:{onPhase(name){if(name==='ack_fsynced')throw Error('crash');}}});
  expect(first).toMatchObject({completed:false,sdkReplyConfirmed:true});expect(manifest(sourceId).completed).toBe(true);
  expect(await delivery.restoreSelectedSdkCaptureV2(target,sourceId,post,{dir})).toMatchObject({completed:true,status:'duplicate'});
  expect(post).toHaveBeenCalledTimes(1);expect(await store.load(target,sourceId)).toEqual(body);
});

it('selected normal retry sends only the designated pending original and never drains a held neighbour',async()=>{
  const neighbour=await held('other-held-0002');const body=payload('selected-pending-0003');
  await delivery.deliverSdkCaptureV2(target,body,async()=>({status:0,body:null,notSent:true}),{dir});
  const pending=(await neighbour.store.pending(target)).find(row=>row.state==='pending')!;
  vi.spyOn(Date,'now').mockReturnValue(pending.nextAttemptAt+1);
  const post=vi.fn(async(sent:any)=>{expect(sent).toEqual(body);return {status:200,body:{eventId:body.eventId,completed:true,completion:'sdk',durable:false,status:'accepted'}};});
  expect(await delivery.deliverSdkCaptureV2(target,await neighbour.store.load(target,pending.sourceId),post,{dir})).toMatchObject({outcome:'delivered'});
  expect(post).toHaveBeenCalledTimes(1);expect(manifest(neighbour.sourceId).completed).toBe(false);
  expect(await neighbour.store.pending(target)).toMatchObject([{sourceId:neighbour.sourceId,state:'held'}]);
});

it('the old restore stub never transmits, and a changed held payload cannot be claimed',async()=>{
 const {store,sourceId,body}=await held();const post=vi.fn(async()=>restored(body));
 expect(await delivery.restoreSdkCaptureV2(target,sourceId,post,{dir})).toMatchObject({code:'SDK_SOURCE_RESTORE_REQUIRES_REVIEW'});
 expect(post).not.toHaveBeenCalled();
 await expect(store.markSending(target,sourceId,{...body,data:{text:'changed'}})).rejects.toMatchObject({code:'SOURCE_HELD'});
 expect(reference(sourceId).state).toBe('held');
});
it('a stale owner cannot acknowledge, retry or hold the current sender reference',async()=>{
 const {store,sourceId,body}=await held();await store.markSending(target,sourceId,body);
 const ref=reference(sourceId);ref.owner.start='mismatched-generation';
 writeFileSync(join(dir,'queue',sourceId+'.ref'),JSON.stringify(ref));
 for(const operation of [()=>store.acknowledge(target,sourceId),()=>store.retry(target,sourceId,'retry'),()=>store.hold(target,sourceId,'hold')]){
  await expect(operation()).rejects.toMatchObject({code:'SOURCE_HELD'});
  expect(reference(sourceId)).toEqual(ref);expect(manifest(sourceId).completed).toBe(false);
 }
});
