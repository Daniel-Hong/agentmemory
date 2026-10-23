import {engineFixture} from './helpers/engine-evidence.js';
import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {StateKV} from '../src/state/kv.js';import {KV} from '../src/state/schema.js';import {captureEventScope} from '../src/capture/event-record.js';import {acquireFileWriterLease,markFileWriterClean} from '../src/ops/file-writer-lease.mjs';
const clean:Array<()=>void>=[];afterEach(()=>{for(const fn of clean.splice(0))fn();vi.unstubAllEnvs();});
async function module(){return import('../src/capture/auto-recovery.js');}
async function setup(){
 const d=mkdtempSync(join(tmpdir(),'am-auto-capture-'));vi.stubEnv('AGENTMEMORY_STATE_STORE_PATH',d);const {evidence}=engineFixture(d);const lease=acquireFileWriterLease(d,{evidence});clean.push(()=>{lease.close();rmSync(d,{recursive:true,force:true});});
 const state=new Map<string,any>();const at=Date.parse('2026-10-23T00:00:00Z');let clock=at+120000;let failProof=false;let onProof:(()=>Promise<void>)|undefined;let calls=0;
 const sdk={trigger:async(x:any)=>{const {scope,key,value}=x.payload;const k=scope+'|'+key;if(x.function_id==='state::get')return structuredClone(state.get(k)??null);if(x.function_id==='state::set'){state.set(k,structuredClone(value));return value;}if(x.function_id==='state::delete'){state.delete(k);return null;}if(x.function_id==='state::list')return [...state].filter(([k])=>k.startsWith(scope+'|')).map(([,v])=>structuredClone(v));throw Error('Unexpected non-state invocation');}};
 const sessionId='fixture-session',observationId='obs_fixture',eventId='evh_fixture';const key='cap_'+createHash('sha256').update(`fixture\u0000${sessionId}\u0000${eventId}`).digest('hex').slice(0,40);
 const inbox={project:'fixture',key,sessionId,observationId,eventId,eventSource:'client',status:'dead',attempts:5,cycleAttempts:5,acceptedAt:new Date(at).toISOString(),updatedAt:new Date(at).toISOString(),payload:{sessionId,project:'fixture',hookType:'post_tool_use',timestamp:new Date(at).toISOString(),data:{tool_name:'fixture',tool_output:'synthetic'}}};
 const obs={id:observationId,sessionId,captureKey:key,title:'fixture',narrative:'synthetic projection',sourceRaw:{id:observationId,sessionId,captureKey:key,eventId,hookType:inbox.payload.hookType,timestamp:inbox.payload.timestamp,raw:inbox.payload.data}};
 const history={project:'fixture',key,sessionId,observationId,eventId,status:'dead',totalAttempts:5,manualRetries:0,cycleAttempts:5,acceptedAt:inbox.acceptedAt,updatedAt:inbox.updatedAt,failures:[{code:'CAPTURE_STORE_TIMEOUT'}],requests:{}};
 const fingerprint=createHash('sha256').update(obs.title+' '+obs.narrative).digest('hex');
 state.set(KV.captureInbox+'|'+key,inbox);state.set(KV.captureReview+'|'+key,history);state.set(KV.observations(sessionId)+'|'+observationId,obs);state.set('mem:embedding-committed:v1|'+observationId,{kind:'observation',id:observationId,sessionId,fingerprint});
 const durability={mutate:(_s:string,_k:string,fn:()=>unknown)=>fn(),waitForKeys:async(_kv:any,keys:any[],opts:any)=>{calls++;if(onProof&&keys.some(x=>x.scope===KV.observations(sessionId))){const fn=onProof;onProof=undefined;await fn();}if(failProof&&keys.some(x=>x.scope===captureEventScope(key))&&state.has(captureEventScope(key)+'|'+key))throw Error('state_durability_timeout');if(opts?.expectedValues)for(let i=0;i<keys.length;i++)expect(await sdk.trigger({function_id:'state::get',payload:keys[i]})).toEqual(opts.expectedValues[i]);return {synced:true,mutationFailures:0};}};
 const kv=new StateKV(sdk as never,{writerLease:lease,durability:durability as never});let admitted=true;
 const options={enabled:true,writerOwned:()=>true,admitted:()=>admitted,indexReady:()=>true,now:()=>clock};
 return {kv,state,key,lease,evidence,storePath:d,sdk,durability,sessionId,observationId,eventId,obs,history,options,advance:()=>clock+=3600000,failProof:(v:boolean)=>failProof=v,onProof:(fn:()=>Promise<void>)=>onProof=fn,admit:(v:boolean)=>admitted=v,calls:()=>calls};
}
it('automatically certifies an already stored original without inference or resetting retry history',async()=>{
 const x=await setup(),m=await module(),a=m.createCaptureAutoRecovery(x.kv,x.options);await a.tick();
 expect(await x.kv.get(KV.captureInbox,x.key)).toBeNull();expect(await x.kv.get(KV.observations(x.sessionId),x.observationId)).toEqual(x.obs);
 expect(await x.kv.get(KV.captureReview,x.key)).toMatchObject({status:'completed',totalAttempts:5,cycleAttempts:5,manualRetries:0});expect(await x.kv.get(captureEventScope(x.key),x.key)).toMatchObject({key:x.key,observationId:x.observationId});
 expect(a.snapshot()).toMatchObject({resolved:1,verifying:0});expect(JSON.stringify(a.snapshot())).not.toContain(x.key);
});
it('retains the original when a deletion lands after preflight and before finalization',async()=>{
 const x=await setup(),m=await module(),a=m.createCaptureAutoRecovery(x.kv,x.options);x.onProof(async()=>{await x.kv.set(captureEventScope(x.key),x.key,{key:x.key,state:'deleted'});await x.kv.delete(KV.observations(x.sessionId),x.observationId);});await a.tick();
 expect(await x.kv.get(KV.captureInbox,x.key)).not.toBeNull();expect(await x.kv.get(captureEventScope(x.key),x.key)).toMatchObject({state:'deleted'});expect(a.snapshot()).toMatchObject({blocked:1});
});
it('after a completion-proof timeout resumes only verification across restart',async()=>{
 const x=await setup(),m=await module(),a=m.createCaptureAutoRecovery(x.kv,x.options);x.failProof(true);await a.tick();
 expect(await x.kv.get(KV.captureInbox,x.key)).toBeNull();expect(a.snapshot()).toMatchObject({verifying:1,resolved:0});expect((await x.kv.get<any>(KV.captureRecovery,x.key)).lastVerificationFailure).toEqual({operation:'completion_certificate',stage:'unknown',code:'UNKNOWN'});const done=await x.kv.get(captureEventScope(x.key),x.key);x.failProof(false);x.advance();
 const restarted=m.createCaptureAutoRecovery(x.kv,x.options);await restarted.tick();expect(restarted.snapshot()).toMatchObject({resolved:1,verifying:0});expect(await x.kv.get(captureEventScope(x.key),x.key)).toEqual(done);expect(await x.kv.get(KV.observations(x.sessionId),x.observationId)).toEqual(x.obs);
});
it('does no recovery while disabled, unowned, or a manual/deployment/memory hold denies admission',async()=>{
 const x=await setup(),m=await module();for(const opts of [{...x.options,enabled:false},{...x.options,writerOwned:()=>false},{...x.options,admitted:()=>false}]){await m.createCaptureAutoRecovery(x.kv,opts).tick();expect(await x.kv.get(KV.captureInbox,x.key)).not.toBeNull();}expect(x.calls()).toBe(0);
});
it.each(['missing','mismatch','generation','intent','unclassified','index'])('blocks %s without deleting or acknowledging the inbox',async(kind)=>{
 const x=await setup(),m=await module();
 if(kind==='missing')await x.kv.delete(KV.observations(x.sessionId),x.observationId);
 if(kind==='mismatch')await x.kv.set(KV.observations(x.sessionId),x.observationId,{...x.obs,sourceRaw:{...x.obs.sourceRaw,raw:{different:true}}});
 if(kind==='generation')await x.kv.set('mem:embedding-committed:v1',x.observationId,{id:x.observationId,sessionId:x.sessionId,fingerprint:'0'.repeat(64)});
 if(kind==='intent')await x.kv.set('mem:embedding-retry:v1',x.observationId,{generation:'new-generation'});
 if(kind==='unclassified')await x.kv.set(KV.captureReview,x.key,{...x.history,failures:[{code:'UNRECOGNIZED'}]});
 const a=m.createCaptureAutoRecovery(x.kv,{...x.options,...(kind==='index'?{indexReady:()=>false}:{})});await a.tick();expect(a.snapshot()).toMatchObject({blocked:1,resolved:0});expect(await x.kv.get(KV.captureInbox,x.key)).not.toBeNull();expect(await x.kv.get(captureEventScope(x.key),x.key)).toBeNull();
});
it('does not duplicate work across concurrent coordinators or replay resolved state',async()=>{
 const x=await setup(),m=await module(),a=m.createCaptureAutoRecovery(x.kv,x.options),b=m.createCaptureAutoRecovery(x.kv,x.options);await Promise.all([a.tick(),b.tick()]);const receipt=await x.kv.get(captureEventScope(x.key),x.key);await b.tick();expect(await x.kv.get(captureEventScope(x.key),x.key)).toEqual(receipt);expect(await x.kv.get(KV.captureReview,x.key)).toMatchObject({totalAttempts:5,manualRetries:0});
});
it('respects a hold arriving during preflight without acknowledging the item',async()=>{
 const x=await setup(),m=await module(),a=m.createCaptureAutoRecovery(x.kv,x.options);x.onProof(async()=>x.admit(false));await a.tick();expect(await x.kv.get(KV.captureInbox,x.key)).not.toBeNull();expect(await x.kv.get(captureEventScope(x.key),x.key)).toBeNull();expect(a.snapshot()).toMatchObject({verifying:1,blocked:0});x.admit(true);x.advance();await a.tick();expect(a.snapshot()).toMatchObject({resolved:1});
});
it('limits verification failures and opens a circuit without resetting capture attempts',async()=>{
 const x=await setup(),m=await module(),a=m.createCaptureAutoRecovery(x.kv,x.options);x.failProof(true);await a.tick();const count=x.calls();await a.tick();expect(x.calls()).toBe(count);x.advance();await a.tick();x.advance();await a.tick();expect(a.snapshot()).toMatchObject({blocked:1,resolved:0});expect(a.snapshot().breakerUntil).toBeGreaterThan(0);const before=x.calls();x.advance();await a.tick();expect(x.calls()).toBe(before);expect(await x.kv.get(KV.captureReview,x.key)).toMatchObject({totalAttempts:5,manualRetries:0,cycleAttempts:5});
});

it.each(['marker-kind','payload-session','payload-project'])('rejects cross-kind or cross-identity %s',async(kind)=>{
 const x=await setup(),m=await module();
 if(kind==='marker-kind'){const scope='mem:embedding-committed:v1';await x.kv.set(scope,x.observationId,{...await x.kv.get<any>(scope,x.observationId),kind:'memory'});}
 else{const inbox=await x.kv.get<any>(KV.captureInbox,x.key);inbox.payload[kind==='payload-session'?'sessionId':'project']='different';await x.kv.set(KV.captureInbox,x.key,inbox);}
 const a=m.createCaptureAutoRecovery(x.kv,x.options);await a.tick();expect(a.snapshot()).toMatchObject({blocked:1,resolved:0});expect(await x.kv.get(KV.captureInbox,x.key)).not.toBeNull();
});

it('accepts the actual initial-capture synthetic publication kind',async()=>{const x=await setup(),m=await module(),scope='mem:embedding-committed:v1';await x.kv.set(scope,x.observationId,{...await x.kv.get<any>(scope,x.observationId),kind:'synthetic'});const a=m.createCaptureAutoRecovery(x.kv,x.options);await a.tick();expect(a.snapshot()).toMatchObject({resolved:1});});

it('preserves uncertain completion across a new worker instead of laundering its epoch',async()=>{
 const x=await setup(),m=await module(),first=m.createCaptureAutoRecovery(x.kv,x.options);x.failProof(true);await first.tick();const original=await x.kv.get(KV.observations(x.sessionId),x.observationId);const receipt=await x.kv.get(captureEventScope(x.key),x.key);
 x.lease.close();const lease=acquireFileWriterLease(x.storePath,{evidence:{...x.evidence,gone:()=>false}});clean.push(()=>lease.close());const next=new StateKV(x.sdk as never,{writerLease:lease,durability:x.durability as never});x.advance();
 const restarted=m.createCaptureAutoRecovery(next,x.options);const before=x.calls();await restarted.tick();expect(restarted.snapshot()).toMatchObject({verifying:1,resolved:0,lastErrorCode:'WRITER_ENGINE_OVERLAP'});expect(x.calls()).toBe(before);expect(await next.get(captureEventScope(x.key),x.key)).toEqual(receipt);expect(await next.get(KV.observations(x.sessionId),x.observationId)).toEqual(original);
});
it('retries checkpoint proof without replaying the capture or permanently blocking it',async()=>{
 const x=await setup(),m=await module(),normal=x.durability.waitForKeys;let failOnce=true;
 x.durability.waitForKeys=async(...args:Parameters<typeof normal>)=>{const value=args[2]?.expectedValues?.[0];if(failOnce&&value?.phase==='verifying'){failOnce=false;return {synced:false,mutationFailures:0};}return normal(...args);};
 const a=m.createCaptureAutoRecovery(x.kv,x.options);await a.tick();expect(a.snapshot()).toMatchObject({verifying:1,blocked:0,resolved:0});expect(await x.kv.get(KV.captureInbox,x.key)).not.toBeNull();x.advance();await a.tick();expect(a.snapshot()).toMatchObject({resolved:1});
});

it('waits within a bounded budget for an identified in-flight publication without replay',async()=>{
 const x=await setup(),m=await module(),scope='mem:embedding-retry:v1';await x.kv.set(scope,x.observationId,{id:x.observationId,sessionId:x.sessionId,kind:'synthetic',phase:'queued',generation:'fixture-generation',fingerprint:createHash('sha256').update(x.obs.title+' '+x.obs.narrative).digest('hex')});
 const a=m.createCaptureAutoRecovery(x.kv,x.options);await a.tick();expect(a.snapshot()).toMatchObject({verifying:1,blocked:0,resolved:0});expect(await x.kv.get(KV.captureInbox,x.key)).not.toBeNull();await x.kv.delete(scope,x.observationId);x.advance();await a.tick();expect(a.snapshot()).toMatchObject({resolved:1});
});
it('does not consume publication budget when a hold arrives during source lookup',async()=>{
 const x=await setup(),m=await module(),scope='mem:embedding-retry:v1';await x.kv.set(scope,x.observationId,{id:x.observationId,sessionId:x.sessionId,kind:'synthetic',phase:'queued',generation:'fixture-generation',fingerprint:createHash('sha256').update(x.obs.title+' '+x.obs.narrative).digest('hex')});
 const trigger=x.sdk.trigger;x.sdk.trigger=async input=>{if(input.function_id==='state::get'&&input.payload.scope===scope)x.admit(false);return trigger(input);};
 const a=m.createCaptureAutoRecovery(x.kv,x.options);await a.tick();const row=await x.kv.get<any>(KV.captureRecovery,x.key);expect(row).toMatchObject({verificationAttempts:0,reason:'ADMISSION_HELD'});expect(await x.kv.get(KV.captureInbox,x.key)).not.toBeNull();
});
it('persists authenticated control intent and restores it without resetting recovery budget',async()=>{
 const x=await setup(),m=await module(),a=m.createCaptureAutoRecovery(x.kv,{...x.options,enabled:false});expect((await a.setEnabled(true)).ok).toBe(true);expect(a.snapshot()).toMatchObject({enabled:true,configurationStatus:'verified'});const b=m.createCaptureAutoRecovery(x.kv,{...x.options,enabled:false});await b.initialize();expect(b.snapshot().enabled).toBe(true);expect((await b.setEnabled(false)).ok).toBe(true);expect(b.snapshot().enabled).toBe(false);
});
it('rejects enable under a hold without changing persisted configuration',async()=>{
 const x=await setup(),m=await module(),a=m.createCaptureAutoRecovery(x.kv,{...x.options,enabled:false});x.admit(false);expect(await a.setEnabled(true)).toMatchObject({ok:false,code:'BACKGROUND_HELD'});expect(await x.kv.get(KV.captureRecovery,'control')).toBeNull();
});
it('keeps disable immediate and prevents an older enable proof from turning it back on',async()=>{
 const x=await setup(),m=await module(),a=m.createCaptureAutoRecovery(x.kv,{...x.options,enabled:false}),normal=x.durability.waitForKeys;let release!:()=>void,entered!:()=>void;const start=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);let blocked=false;
 x.durability.waitForKeys=async(...args:Parameters<typeof normal>)=>{if(!blocked&&args[2]?.expectedValues?.[0]?.enabled===true){blocked=true;entered();await hold;}return normal(...args);};
 const enabling=a.setEnabled(true);await start;const disabling=a.setEnabled(false);expect(a.snapshot().enabled).toBe(false);release();expect((await enabling).ok).toBe(false);expect((await disabling).ok).toBe(true);expect(a.snapshot()).toMatchObject({enabled:false,durableEnabled:false});
});
it('rolls back enabling when a hold arrives during configuration certification',async()=>{
 const x=await setup(),m=await module(),a=m.createCaptureAutoRecovery(x.kv,{...x.options,enabled:false}),normal=x.durability.waitForKeys;let once=true;x.durability.waitForKeys=async(...args:Parameters<typeof normal>)=>{if(once&&args[2]?.expectedValues?.[0]?.enabled===true){once=false;x.admit(false);}return normal(...args);};
 expect(await a.setEnabled(true)).toMatchObject({ok:false,code:'BACKGROUND_HELD'});expect(a.snapshot()).toMatchObject({enabled:false,durableEnabled:false});
});

it('allows disabling while storage protection remains held',async()=>{const x=await setup(),m=await module(),a=m.createCaptureAutoRecovery(x.kv,{...x.options,admissionReason:()=> 'HOLD_STORAGE_ERROR'});x.admit(false);expect((await a.setEnabled(false)).ok).toBe(true);expect(a.snapshot()).toMatchObject({enabled:false,blockedReason:'HOLD_STORAGE_ERROR'});});

it('retains bounded failure evidence after global traces are gone and coordinator restarts',async()=>{
 const x=await setup(),m=await module();
 x.durability.waitForKeys=async(_kv:any,keys:any[])=>{
  if(keys.some((k:any)=>k.scope===KV.observations(x.sessionId)))throw Object.assign(Error('private raw message must not escape'),{code:'STATE_DURABILITY_TIMEOUT',diagnostics:{stage:'readback',errorCode:'STATE_READBACK_TIMEOUT',elapsedMs:15001,reader:{readerPhase:'stream',readerTimings:{streamMs:14000,processingMs:35,PRIVATE:8},bytesRead:64,PRIVATE:'private'},certificateRef:'private-ref',sessionId:'private-session'}});
  return {synced:true,mutationFailures:0};
 };
 const a=m.createCaptureAutoRecovery(x.kv,x.options);await a.tick();
 const row=await x.kv.get<any>(KV.captureRecovery,x.key);
 expect(row).toMatchObject({verificationAttempts:1,phase:'checking',lastVerificationFailure:{operation:'source_certificate',stage:'readback',code:'STATE_READBACK_TIMEOUT',elapsedMs:15001,reader:{readerPhase:'stream',readerTimings:{streamMs:14000,processingMs:35},bytesRead:64}}});
 expect(await x.kv.get(KV.captureInbox,x.key)).not.toBeNull();expect(await x.kv.get(captureEventScope(x.key),x.key)).toBeNull();
 const restarted=m.createCaptureAutoRecovery(x.kv,x.options);await restarted.initialize();
 expect(restarted.snapshot()).toMatchObject({verificationFailureCounts:{'source_certificate:readback:STATE_READBACK_TIMEOUT':1}});
 expect(JSON.stringify(row.lastVerificationFailure)).not.toMatch(/private|PRIVATE|session|certificateRef/);
});

it('redacts unsupported failure fields without changing failed verification or receipt semantics',async()=>{
 const x=await setup(),m=await module();let calls=0;
 x.durability.waitForKeys=async(_kv:any,keys:any[])=>{calls++;if(keys.some((k:any)=>k.scope===KV.observations(x.sessionId)))throw Object.assign(Error('raw sensitive message'),{code:'private-id',diagnostics:{stage:'private-session',errorCode:'private-token',elapsedMs:Infinity,raw:'private-content'}});return {synced:true,mutationFailures:0};};
 const a=m.createCaptureAutoRecovery(x.kv,x.options);await a.tick();const row=await x.kv.get<any>(KV.captureRecovery,x.key);
 expect(row.lastVerificationFailure).toEqual({operation:'source_certificate',stage:'unknown',code:'UNKNOWN'});expect(calls).toBe(4);expect(row.verificationAttempts).toBe(1);expect(await x.kv.get(KV.captureInbox,x.key)).not.toBeNull();expect(await x.kv.get(captureEventScope(x.key),x.key)).toBeNull();
 expect(JSON.stringify(a.snapshot())).not.toMatch(/private|sensitive|certificateRef/);
});
