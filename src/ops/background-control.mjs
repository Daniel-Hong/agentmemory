import {AsyncLocalStorage} from 'node:async_hooks';
import {timingSafeEqual} from 'node:crypto';

const NAMESPACE='mem:background-control:v1';
const HOLD_REASONS=new Set(['manual','deployment','memory','legacy_unknown','storage_error']);
export const MEMORY_RECOVERY_MAX_ATTEMPTS=3;
const deferred=()=>({success:false,deferred:true,retained:true,reason:'background_paused'});
export let backgroundControl=null;
export function installBackgroundControl(control){backgroundControl=control;}
export const backgroundPaused=()=>backgroundControl?.isPaused()??false;
export const backgroundTask=fn=>(...args)=>backgroundControl?backgroundControl.run(()=>fn(...args)):fn(...args);

export function createBackgroundControl({clock=Date.now}={}){
 const context=new AsyncLocalStorage(),active=new Set();
 let kv,drain=async()=>{},status='initializing',requested=true,error=null,diagnostics=null,completion=null,changes=Promise.resolve();
 let transition=null,holds=new Set(),revision=0,recovery={attempts:0,nextAttemptAt:0};
 const record=(paused,resumePending,remaining=holds)=>({version:2,paused,resumePending,holds:[...remaining].sort(),recovery:{...recovery}});
 const writeRecord=(paused,resumePending,remaining)=>kv.set(NAMESPACE,'manual-pause',record(paused,resumePending,remaining));
 const snapshot=()=>({holds:[...holds].sort(),recovery:{...recovery,maxAttempts:MEMORY_RECOVERY_MAX_ATTEMPTS},status,pausedRequested:requested,activeOperations:active.size,error,diagnostics,
   transition:transition?{...transition,elapsedMs:Math.max(0,(transition.completedAt??clock())-transition.startedAt),stageElapsedMs:Math.max(0,(transition.completedAt??clock())-transition.stageStartedAt)}:null});
 function begin(action){transition={action,stage:'request',startedAt:clock(),stageStartedAt:clock()};error=null;diagnostics=null;}
 function stage(value){transition.stage=value;transition.stageStartedAt=clock();if(value==='complete')transition.completedAt=clock();}
 const safeCode=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,80}$/.test(value)?value:null;
 function fail(e){
   holds.add('storage_error');requested=true;status='error';error='background_storage_unavailable';if(transition)transition.completedAt=clock();
   const details=e?.diagnostics??{};
   diagnostics={errorCode:safeCode(e?.code)??'BACKGROUND_STORAGE_UNAVAILABLE',causeCode:safeCode(details.errorCode),stage:safeCode(details.stage)??transition?.stage??'request'};
   for(const name of ['category','phase'])if(safeCode(details[name]))diagnostics[name]=details[name];
   for(const name of ['keyCount','scopeCount','capturedKeyCount','elapsedMs','waitMs','dirtyKeyCount','activeMutations','pendingPublications'])if(Number.isFinite(details[name])&&details[name]>=0)diagnostics[name]=details[name];
 }
 function track(fn){
  const token={active:true};const promise=context.run(token,()=>Promise.resolve().then(fn));active.add(promise);
  const done=()=>{token.active=false;active.delete(promise);};promise.then(done,done);return promise;
 }
 async function persist(){
  stage('storage');
  if(typeof kv.durability?.wait!=='function')throw Object.assign(Error('background_storage_unavailable'),{code:'BACKGROUND_PAUSE_FENCE_UNAVAILABLE'});
  const result=await kv.durability.wait(kv);
  if(result?.synced!==true||result?.mutationFailures!==0)throw Object.assign(Error('background_storage_unavailable'),{code:'BACKGROUND_STORAGE_UNVERIFIED'});
 }
 async function confirmPauseRecord(updateStage=true){
  if(updateStage&&transition)stage('storage');
  if(typeof kv.durability?.waitForKeys!=='function')throw Object.assign(Error('background_storage_unavailable'),{code:'BACKGROUND_PAUSE_FENCE_UNAVAILABLE'});
  await kv.durability.waitForKeys(kv,[{scope:NAMESPACE,key:'manual-pause'}]);
 }
 function finishPause(){
  if(completion)return;
  completion=(async()=>{
   stage('active_work');
   while(active.size)await Promise.allSettled([...active]);
   stage('worker_drain');
   await drain();
   await persist();
   await writeRecord(true,false);await confirmPauseRecord();
   status='paused';error=null;diagnostics=null;stage('complete');
  })().catch(async e=>{fail(e);try{await writeRecord(true,true);await confirmPauseRecord(false);}catch{}}).finally(()=>{completion=null;});
 }
 return {
  async init(store,finish=async()=>{}){
   kv=store;drain=finish;const saved=await kv.get(NAMESPACE,'manual-pause');
   if(saved!==null&&saved!==undefined&&(typeof saved!=='object'||typeof saved.paused!=='boolean'||saved.resumePending!==undefined&&typeof saved.resumePending!=='boolean'))throw Error('invalid_background_control');
   if(saved?.version!==undefined&&saved.version!==2)throw Error('invalid_background_control');
   if(saved?.version===2){
    if(!Array.isArray(saved.holds)||saved.holds.some(h=>!HOLD_REASONS.has(h))||new Set(saved.holds).size!==saved.holds.length||!saved.recovery||!Number.isInteger(saved.recovery.attempts)||saved.recovery.attempts<0||saved.recovery.attempts>MEMORY_RECOVERY_MAX_ATTEMPTS||!Number.isFinite(saved.recovery.nextAttemptAt)||saved.recovery.nextAttemptAt<0||saved.paused!==Boolean(saved.holds.length))throw Error('invalid_background_control');
    holds=new Set(saved.holds);recovery={attempts:saved.recovery.attempts,nextAttemptAt:saved.recovery.nextAttemptAt};
   }else if(saved?.paused===true)holds.add('legacy_unknown');
   if(saved?.resumePending===true){holds.add('storage_error');requested=true;status='error';error='background_storage_unavailable';diagnostics={errorCode:'BACKGROUND_RESUME_INCOMPLETE',phase:'resume_recovery'};return;}
   if(!holds.size){
     // A clean running boot must arm its crash guard before admitting work.
     await writeRecord(false,true);await confirmPauseRecord(false);
     requested=false;status='running';
   }else{requested=true;status='paused';}
  },snapshot,isPaused:()=>requested,
  run(fn){return requested?Promise.resolve(deferred()):track(fn);},
  infer(fn){
   // An admitted task finishes its current unit, including any subsequent writes.
   if(context.getStore()?.active)return Promise.resolve().then(fn);
   if(requested)return Promise.reject(Object.assign(Error('background_paused'),{providerUnavailable:true,code:'BACKGROUND_PAUSED'}));
   return track(fn);
  },
  change(action,{source='manual',canResume}={}){
   if(!['manual','deployment','memory'].includes(source)||!['pause','resume'].includes(action))return Promise.reject(Error('invalid_background_action'));
   // Close admission at request time, including while another transition awaits disk.
   const requestRevision=revision,added=action==='pause'&&!holds.has(source);
   if(action==='pause'){holds.add(source);requested=true;revision++;}
   const operation=changes.then(async()=>{
    if(action==='pause'){
     if((status==='paused'||status==='pausing')&&!added)return snapshot();
     const alreadyHeld=status==='paused'||status==='pausing';
     if(!alreadyHeld){status='pausing';begin('pause');}
     try{await writeRecord(true,true);if(alreadyHeld){await confirmPauseRecord(false);if(status==='paused'){await writeRecord(true,false);await confirmPauseRecord(false);}}else finishPause();}
     catch(e){fail(e);throw Error(error);}
    }else{
     if(revision!==requestRevision)return snapshot();
     if(status==='pausing'||completion)throw Error('background_draining');
     const automatic=source==='memory';
     if(automatic&&(status!=='paused'||holds.size!==1||!holds.has('memory')||recovery.attempts>=MEMORY_RECOVERY_MAX_ATTEMPTS||clock()<recovery.nextAttemptAt||typeof canResume!=='function'))return snapshot();
     if(status==='running')return snapshot();
     const startingRevisionForRelease=revision,remaining=new Set(holds);
     if(source==='manual'){for(const h of ['manual','legacy_unknown','storage_error'])remaining.delete(h);}
     else remaining.delete(source);
     if(remaining.size){
      if(source==='manual')recovery={attempts:0,nextAttemptAt:0};
      begin('resume');
      try{await writeRecord(true,true);await confirmPauseRecord();await persist();
       // Concurrent pause intent must survive even a partial hold release.
       if(revision===startingRevisionForRelease){holds=remaining;}
       await writeRecord(true,false);await confirmPauseRecord();status='paused';stage('complete');return snapshot();
      }catch(e){fail(e);try{await writeRecord(true,true);await confirmPauseRecord(false);}catch{}throw Error(error);}
     }
     const startingRevision=revision;
     if(automatic){
      if(!await canResume()||revision!==startingRevision)return snapshot();
      recovery={attempts:recovery.attempts+1,nextAttemptAt:clock()+60000*2**recovery.attempts};
     }else recovery={attempts:0,nextAttemptAt:0};
     requested=true;status='resuming';begin('resume');
     let resumePhase='resume_prepare',precedingWritesVerified=false;
     const allowed=async()=>revision===startingRevision&&(!automatic||await canResume())&&revision===startingRevision;
     try{
       await writeRecord(true,true);await confirmPauseRecord();
       resumePhase='resume_storage';await persist();precedingWritesVerified=true;
       if(!await allowed()||revision!==startingRevision){
        await writeRecord(true,false);await confirmPauseRecord();status='paused';stage('complete');return snapshot();
       }
       // Keep the crash guard armed; only a verified clean shutdown clears it.
       resumePhase='resume_activation';await writeRecord(false,true,remaining);await confirmPauseRecord();
       if(!await allowed()||revision!==startingRevision){
        await writeRecord(true,false);await confirmPauseRecord();status='paused';stage('complete');return snapshot();
       }
     }
     catch(e){
       fail(e);diagnostics.phase=resumePhase;diagnostics.precedingWritesVerified=precedingWritesVerified;diagnostics.rollbackVerified=false;
       try{await writeRecord(true,true);await confirmPauseRecord();diagnostics.rollbackVerified=true;}
       catch(rollbackError){diagnostics.rollbackErrorCode=safeCode(rollbackError?.code)??'BACKGROUND_STORAGE_UNAVAILABLE';}
       throw Error(error);
     }
     holds=remaining;requested=false;status='running';error=null;diagnostics=null;stage('complete');
    }
    return snapshot();
   });
   changes=operation.catch(()=>{});return operation;
  },commitCleanShutdown(){
   // The caller must first stop ingress/producers and verify the full disk fence.
   const operation=changes.then(async()=>{
     // A held error can recover only as paused, without admitting background work.
     const safeStatus=['running','paused'].includes(status)||(status==='error'&&requested);
     if(completion||active.size||!safeStatus)throw Object.assign(Error('background_clean_shutdown_unsafe'),{code:'BACKGROUND_CLEAN_SHUTDOWN_UNSAFE'});
     await writeRecord(requested,false);await confirmPauseRecord(false);
     return{success:true,paused:requested};
   });
   changes=operation.catch(()=>{});return operation;
  },async settled(){await changes;while(completion)await completion;}
 };
}

const INFERENCE_FUNCTIONS=new Set(['mem::summarize','mem::compress','mem::graph-extract','mem::consolidate','mem::consolidate-pipeline','mem::reflect','mem::slot-reflect','mem::flow-compress','mem::crystallize','mem::skill-extract','mem::enrich-window','mem::temporal-graph-extract','mem::compress-file','mem::expand-query','mem::snapshot-create']);
export function controlBackgroundFunctions(sdk){
 const register=sdk.registerFunction.bind(sdk);
 sdk.registerFunction=(id,handler,...rest)=>register(id,INFERENCE_FUNCTIONS.has(id)?backgroundTask(handler):handler,...rest);
}

export function backgroundViewerRequestAllowed(req){
 return req.headers?.['x-agentmemory-background']==='1'&&/^application\/json(?:;|$)/i.test(req.headers?.['content-type']||'')&&!['cross-site','same-site'].includes(req.headers?.['sec-fetch-site']);
}
export function registerBackgroundControlApi(sdk,secret,control){
 function auth(req){
  if(!secret)return{status_code:503,body:{error:'background_control_requires_authentication'}};
  const a=Buffer.from(req.headers?.authorization||req.headers?.Authorization||''),b=Buffer.from('Bearer '+secret);
  return a.length===b.length&&timingSafeEqual(a,b)?null:{status_code:401,body:{error:'unauthorized'}};
 }
 for(const method of ['GET','POST']){
  const id='api::background-control-'+(method==='GET'?'get':'set');
  sdk.registerFunction(id,async req=>{
   const denied=auth(req);if(denied)return denied;
   if(method==='GET')return{status_code:200,body:{success:true,control:control.snapshot()}};
   if(!backgroundViewerRequestAllowed(req))return{status_code:403,body:{error:'background_control_marker_required'}};
   const body=req.body;
   if(!body||Array.isArray(body)||Object.keys(body).some(k=>!['action','reason'].includes(k))||body.reason!==undefined&&body.reason!=='deployment'||!['pause','resume'].includes(body.action))return{status_code:400,body:{error:'invalid_background_action'}};
   try{return{status_code:202,body:{success:true,control:await control.change(body.action,{source:body.reason??'manual'})}};}
   catch(e){return{status_code:e.message==='background_draining'?409:503,body:{success:false,error:e.message==='background_draining'?'background_draining':'background_storage_unavailable',control:control.snapshot()}};}
  });
  sdk.registerTrigger({type:'http',function_id:id,config:{api_path:'/agentmemory/background/control',http_method:method,middleware_function_ids:['middleware::api-auth']}});
 }
}
