import {afterEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';
import {fork} from 'node:child_process';
import {SdkSpoolV2,deliverSdkCaptureV2,drainSdkCapturesV2} from '../src/capture/sdk-delivery-v2.js';
const target='http://127.0.0.1:43111',roots:string[]=[];
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const id=(event:string)=>hash(hash(target)+'\0'+event);
const ack=(body:Record<string,unknown>)=>({status:201,body:{eventId:body.eventId,completion:'sdk',completed:true,durable:false}});
const delay=(ms:number)=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
function root(){const value=mkdtempSync(join(tmpdir(),'sdk-deadline-'));roots.push(value);return value;}
function ref(dir:string,event:string){return JSON.parse(readFileSync(join(dir,'queue',id(event)+'.ref'),'utf8'));}
function manifest(dir:string,event:string){return JSON.parse(readFileSync(join(dir,'originals',id(event),'manifest.json'),'utf8'));}
afterEach(()=>{vi.restoreAllMocks();for(const value of roots.splice(0))rmSync(value,{recursive:true,force:true});});

it('publishes retained source and reference under one lease, without calling separate enqueue',async()=>{
 const dir=root();const enqueue=vi.spyOn(SdkSpoolV2.prototype,'enqueue').mockRejectedValue(Object.assign(Error('STORE_BUSY'),{code:'STORE_BUSY'}));
 const result=await deliverSdkCaptureV2(target,{eventId:'composite'},async body=>ack(body),{dir});
 expect(result.outcome).toBe('delivered');expect(enqueue).not.toHaveBeenCalled();expect(manifest(dir,'composite').completed).toBe(true);
});
it('retains original acknowledgment if reference quota rejects composite handoff',async()=>{
 const dir=root();let posts=0;
 const result=await deliverSdkCaptureV2(target,{eventId:'full'},async body=>{posts++;return ack(body);},{dir,storeOptions:{maxQueueBytes:3*4096}});
 expect(result).toMatchObject({outcome:'dropped',code:'QUEUE_FULL',sourceAcknowledged:true,referenceAcknowledged:false});expect(posts).toBe(0);
 expect(manifest(dir,'full').completed).toBe(false);expect(existsSync(join(dir,'queue',id('full')+'.ref'))).toBe(false);
});
it('preserves raw published before a simulated crash and does not pretend a reference exists',async()=>{
 const dir=root();let posts=0;
 const result=await deliverSdkCaptureV2(target,{eventId:'crash'},async body=>{posts++;return ack(body);},{dir,storeOptions:{onPhase:phase=>{if(phase==='source_published')throw Error('synthetic crash');}}});
 expect(result.outcome).toBe('dropped');expect(posts).toBe(0);expect(manifest(dir,'crash').completed).toBe(false);
 expect(existsSync(join(dir,'queue',id('crash')+'.ref'))).toBe(false);
});
it('reports retained source conservatively when reference publication reports an I/O fault',async()=>{
 const dir=root(),post=vi.fn(async(body:Record<string,unknown>)=>ack(body));
 const result=await deliverSdkCaptureV2(target,{eventId:'queue-fault'},post,{dir,storeOptions:{onPhase:phase=>{if(phase==='reference_published')throw Object.assign(Error('synthetic I/O'),{code:'STORE_IO'});}}});
 expect(result).toMatchObject({outcome:'dropped',code:'STORE_IO',sourceAcknowledged:true,referenceAcknowledged:false});expect(post).not.toHaveBeenCalled();expect(manifest(dir,'queue-fault').completed).toBe(false);
});
it('leaves pending without sending or attempts when local work consumes the transport budget',async()=>{
 const dir=root();let posts=0;
 const result=await deliverSdkCaptureV2(target,{eventId:'budget'},async body=>{posts++;return ack(body);},{dir,deadline:performance.now()+900,storeOptions:{onPhase:phase=>{if(phase==='source_published')delay(200);}}});
 expect(result.outcome).toBe('spooled');expect(posts).toBe(0);expect(ref(dir,'budget')).toMatchObject({state:'pending',attempts:0,nextAttemptAt:0});expect(manifest(dir,'budget').completed).toBe(false);
});
it('passes the same absolute transport deadline with finalization headroom to direct POST',async()=>{
 const dir=root(),deadline=performance.now()+2000;let budget:any;
 const result=await deliverSdkCaptureV2(target,{eventId:'deadline'},async(body,value)=>{budget=value;return ack(body);},{dir,deadline});
 expect(result.outcome).toBe('delivered');expect(budget.deadline).toBe(deadline-750);expect(budget.remainingMs).toBeGreaterThan(0);expect(budget.remainingMs).toBeLessThanOrEqual(1250);
});
it('never retries an uncertain POST but retains explicit not-sent retry semantics with a deadline',async()=>{
 const dir=root(),post=vi.fn(async()=>{throw Error('synthetic timeout after POST');});
 expect(await deliverSdkCaptureV2(target,{eventId:'unknown'},post,{dir,deadline:performance.now()+2000})).toMatchObject({outcome:'held',code:'SDK_SEND_UNCERTAIN'});
 expect(ref(dir,'unknown')).toMatchObject({state:'held',reason:'HELD',attempts:0});
 expect((await deliverSdkCaptureV2(target,{eventId:'unknown'},post,{dir,deadline:performance.now()+2000})).outcome).toBe('held');expect(post).toHaveBeenCalledTimes(1);
 expect((await deliverSdkCaptureV2(target,{eventId:'unknown'},post,{dir,deadline:performance.now()+500})).outcome).toBe('held');expect(post).toHaveBeenCalledTimes(1);
 expect((await deliverSdkCaptureV2(target,{eventId:'not-sent'},async()=>({status:0,body:null,notSent:true}),{dir,deadline:performance.now()+2000})).outcome).toBe('spooled');
 expect(ref(dir,'not-sent')).toMatchObject({state:'pending',reason:'RETRY',attempts:1});
});
it('does not call an existing sending reference pending when its transport budget has expired',async()=>{
 const dir=root();let entered!:()=>void,release!:()=>void,posts=0;
 const started=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r);
 const first=deliverSdkCaptureV2(target,{eventId:'in-flight'},async body=>{posts++;entered();await wait;return ack(body);},{dir,deadline:performance.now()+3000});await started;
 try{
  expect(await deliverSdkCaptureV2(target,{eventId:'in-flight'},async body=>{posts++;return ack(body);},{dir,deadline:performance.now()+500})).toMatchObject({outcome:'held',code:'SDK_SEND_IN_PROGRESS_OR_UNCERTAIN'});
  expect(ref(dir,'in-flight').state).toBe('sending');expect(posts).toBe(1);
 }finally{release();await first;}
});
it('does not convert a failed claim lock into evidence that a source is pending',async()=>{
 const dir=root();vi.spyOn(SdkSpoolV2.prototype,'claimForSend').mockRejectedValue(Object.assign(Error('STORE_BUSY'),{code:'STORE_BUSY'}));
 const post=vi.fn(async(body:Record<string,unknown>)=>ack(body));
 expect(await deliverSdkCaptureV2(target,{eventId:'claim-unknown'},post,{dir,deadline:performance.now()+500})).toMatchObject({outcome:'held',code:'STORE_BUSY'});expect(post).not.toHaveBeenCalled();
});
it('keeps SDK confirmation separate if local ACK publication fails',async()=>{
 const dir=root();const result=await deliverSdkCaptureV2(target,{eventId:'ack-fail'},async body=>ack(body),{dir,deadline:performance.now()+2000,storeOptions:{onPhase:(phase:string)=>{if(phase==='ack_before_publish')throw Error('synthetic failure');}}});
 expect(result).toMatchObject({outcome:'held',code:'SDK_ACK_STATE_UNCONFIRMED',sdkReplyConfirmed:true});expect(ref(dir,'ack-fail').state).toBe('sending');expect(manifest(dir,'ack-fail').completed).toBe(false);
});
it('rejects non-finite public claim deadlines without creating a sending intent',async()=>{
 const dir=root(),store=new SdkSpoolV2({dir}),source=await store.retain(target,'invalid-clock',{eventId:'invalid-clock'});await store.enqueue(target,source.sourceId);
 for(const deadline of [NaN,Infinity,-Infinity])await expect(store.claimForSend(target,source.sourceId,deadline)).rejects.toMatchObject({code:'STORE_OPTIONS_INVALID'});
 await expect(store.claimForSend(target,source.sourceId,-1)).rejects.toMatchObject({code:'SOURCE_SEND_BUDGET_EXHAUSTED'});
 expect(ref(dir,'invalid-clock')).toMatchObject({state:'pending',attempts:0});
});
it('bounded drain preserves a short shared deadline and the legacy unspecified deadline behavior',async()=>{
 const dir=root(),store=new SdkSpoolV2({dir}),source=await store.retain(target,'drain-budget',{eventId:'drain-budget'});await store.enqueue(target,source.sourceId);
 let posts=0;
 const short=await drainSdkCapturesV2(target,async body=>{posts++;return ack(body);},{dir,deadline:performance.now()+500,budgetMs:250});
 expect(short).toMatchObject({attempted:0,remaining:1});expect(posts).toBe(0);expect(ref(dir,'drain-budget').state).toBe('pending');
 const result=await drainSdkCapturesV2(target,async body=>{posts++;return ack(body);},{dir,budgetMs:250});
 expect(result).toMatchObject({attempted:1,delivered:1,remaining:0});expect(posts).toBe(1);
});

for(const processes of [2,6])it(`${processes} real processes wait beyond legacy 150ms and complete against 6000 retained originals`,async()=>{
 const home=root(),dir=join(home,'spool'),store=new SdkSpoolV2({dir});await store.usage();
 // Synthetic completed trees exercise the actual recursive quota scan. Nothing is read from the host spool.
 for(let index=0;index<6000;index++){
  const folder=join(dir,'originals',hash('seed-'+index));mkdirSync(folder,{mode:0o700});
  writeFileSync(join(folder,'manifest.json'),'synthetic quota-only fixture',{mode:0o600});writeFileSync(join(folder,'000000.chunk'),'synthetic',{mode:0o600});
 }
 const children:any[]=[];
 function child(mode:string,index=0){
  const worker=fork(resolve('test/helpers/sdk-deadline-worker.mjs'),[],{execArgv:['--import',resolve('node_modules/tsx/dist/loader.mjs')],env:{PATH:'/usr/bin:/bin',HOME:home,USERPROFILE:home,TMPDIR:home,MODE:mode,FIXTURE_DIR:dir,FIXTURE_TARGET:target,FIXTURE_INDEX:String(index),FIXTURE_MODULE:process.env.SDK_DEADLINE_FIXTURE_MODULE??resolve('src/capture/sdk-delivery-v2.ts')},stdio:['ignore','pipe','pipe','ipc']});
  children.push(worker);let result:any;
  const ready=new Promise<void>((done,reject)=>{worker.on('message',(m:any)=>{if(m.ready)done();if(m.result)result=m.result;});worker.once('error',reject);});
  const exited=new Promise<any>((done,reject)=>{worker.once('exit',code=>code===0?done(result):reject(Error('FIXTURE_CHILD_FAILED')));worker.once('error',reject);});
  return {worker,ready,exited};
 }
 try{
  const holder=child('holder');await holder.ready;
  const senders=Array.from({length:processes},(_,i)=>child('sender',i));await Promise.all(senders.map(x=>x.ready));
  for(const sender of senders)sender.worker.send('go');holder.worker.send('release-after-350ms');
  const results=await Promise.all(senders.map(x=>x.exited));await holder.exited;
  console.log(JSON.stringify({syntheticConcurrentCapture:true,processes,results}));
  for(const result of results)expect(result).toMatchObject({outcome:'delivered',sourceAcknowledged:true,referenceAcknowledged:true,sdkReplyConfirmed:true});
  expect(readdirSync(join(dir,'originals'))).toHaveLength(6000+processes);
  for(let i=0;i<processes;i++)expect(manifest(dir,'multiprocess-'+i).completed).toBe(true);
 }finally{for(const worker of children)if(worker.exitCode===null)worker.kill();}
},30000);
