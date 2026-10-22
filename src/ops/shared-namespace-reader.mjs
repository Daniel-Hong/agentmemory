import {readNamespaceEntries} from './namespace-reader.mjs';
import {performance} from 'node:perf_hooks';

export function createSharedNamespaceReader({read=readNamespaceEntries,maxActiveReads=8,maxWaiters=8,maxKeys=200,maxSelectedBytes=4*1024*1024,maxParallelReads=8,maxQueuedReads=64}={}){
  if(!Number.isSafeInteger(maxParallelReads)||maxParallelReads<1||!Number.isSafeInteger(maxQueuedReads)||maxQueuedReads<1)throw Error('state_namespace_admission_options');
  const jobs=new Set(),reads=new Set(),pendingRequests=new Set(),admissions=new Set(),waiting=[];
  let admitted=0,peakQueued=0,admissionRejected=0;
  function pump(){
    while(admitted<maxParallelReads&&waiting.length){
      const item=waiting.shift();item.signal?.removeEventListener('abort',item.abort);admitted++;
      Promise.resolve().then(()=>{item.signal?.throwIfAborted();return item.work();}).then(item.resolve,item.reject).finally(()=>{admitted--;pump();});
    }
  }
  function schedule(work,signal){
    const pending=new Promise((resolve,reject)=>{
      if(signal?.aborted){reject(signal.reason??new DOMException('Aborted','AbortError'));return;}
      if(waiting.length>=maxQueuedReads){admissionRejected++;reject(Object.assign(Error('state_namespace_admission_limit'),{code:'state_namespace_admission_limit'}));return;}
      const item={work,signal,resolve,reject,abort(){const index=waiting.indexOf(item);if(index>=0){waiting.splice(index,1);reject(signal.reason??new DOMException('Aborted','AbortError'));}}};
      signal?.addEventListener('abort',item.abort,{once:true});waiting.push(item);peakQueued=Math.max(peakQueued,waiting.length);pump();
    });
    admissions.add(pending);return pending.finally(()=>admissions.delete(pending));
  }
  const baseline=(path,options)=>schedule(()=>actual(path,options),options.signal);
  let readSequence=0;
  const counts={requests:0,sharedRequests:0,startedReads:0,completeReads:0,scanBytes:0,directFallbacks:0,projectionFallbacks:0,activeReads:0,activeWaiters:0,peakSharedJobs:0};
  const notify=fn=>{try{const result=fn?.();if(result&&typeof result.then==='function')Promise.resolve(result).catch(()=>{});}catch{}};
  const now=()=>{try{const value=performance.now();return Number.isFinite(value)?value:null;}catch{return null;}};
  const nextId=()=>readSequence<Number.MAX_SAFE_INTEGER?++readSequence:null;
  const metadata=info=>{const result={};try{for(const key of ['fileBytes','bytesRead'])if(Number.isSafeInteger(info?.[key])&&info[key]>=0)result[key]=info[key];if(typeof info?.complete==='boolean')result.complete=info.complete;}catch{}return result;};
  const diagnose=(options,event)=>notify(()=>options.onDiagnostic?.({...event}));
  function status(job){const value={started:job.started===true,...job.openedInfo};const current=now();if(current!==null&&job.startedAt!==null&&job.startedAt!==undefined)value.ageMs=Math.max(0,current-job.startedAt);return value;}
  async function actual(path,options,job={readId:nextId()}){
    counts.startedReads++;counts.activeReads++;
    let promise;
    let lastInfo;
    job.started=true;job.startedAt=now();
    const emit=(phase,info)=>diagnose(options,{phase,readId:job.readId,...metadata(info)});
    emit('started');
    try{
      promise=Promise.resolve(read(path,{...options,onOpen:info=>{
        job.openedInfo=metadata(info);notify(()=>options.onOpen?.({...info}));emit('opened',info);
      },onRead:info=>{
        lastInfo={...info};
        counts.scanBytes+=info.bytesRead??0;if(info.complete)counts.completeReads++;
        notify(()=>options.onRead?.({...info}));
      }}));
      reads.add(promise);const result=await promise;emit('completed',lastInfo);return result;
    }catch(error){emit(options.signal?.aborted?'aborted':'failed',lastInfo);throw error;
    }finally{reads.delete(promise);counts.activeReads--;}
  }
  async function start(job){
    job.started=true;
    try{
      if(!job.waiters.size)return;
      const singleton=job.waiters.size===1;
      if(singleton&&!job.hinted)job.keys=[...job.waiters][0].keys;
      const result=await actual(job.path,{...job.options,keys:job.keys,signal:job.controller.signal,maxSelectedBytes,
        allowProjectionOverflow:()=>{
          if(job.waiters.size!==1)return false;
          const waiter=[...job.waiters][0];
          if([...job.keys].some(key=>!waiter.keys.has(key)))return false;
          job.joinable=false;return true;
        },
        onOpen:info=>{for(const waiter of job.waiters)notify(()=>waiter.options.onOpen?.({...info}));},
        onDiagnostic:event=>{for(const waiter of job.waiters)diagnose(waiter.options,event);},
        onRead:info=>{job.joinable=false;for(const waiter of job.waiters)notify(()=>waiter.options.onRead?.({...info}));}},job);
      job.joinable=false;
      for(const waiter of [...job.waiters])waiter.finish(null,result);
    }catch(error){
      job.joinable=false;
      for(const waiter of [...job.waiters])waiter.finish(error?.code==='state_namespace_projection_limit'?null:error,
        error?.code==='state_namespace_projection_limit'?{fallback:true}:undefined);
    }finally{job.joinable=false;jobs.delete(job);}
  }
  async function shared(path,options){
    const {joinKeys,...readOptions}=options;options=readOptions;
    const keys=new Set(options.keys??[]),requestedKeys=new Set([...keys,...(joinKeys??[])]);
    const hinted=requestedKeys.size>keys.size;
    if(options.onEntry||options.maxSelectedBytes!==undefined||options.allowProjectionOverflow!==undefined){counts.directFallbacks++;return baseline(path,options);}
    let job=[...jobs].find(j=>j.joinable&&j.path===path&&j.waiters.size<maxWaiters&&
      (j.options.checkIntervalBytes??0)===(options.checkIntervalBytes??0)&&
      (j.options.chunkSize??64*1024)===(options.chunkSize??64*1024)&&
      (j.started?[...keys].every(key=>j.keys.has(key)):new Set([...j.keys,...requestedKeys]).size<=maxKeys));
    if(!job&&(jobs.size>=maxActiveReads||requestedKeys.size>maxKeys)){
      counts.directFallbacks++;return baseline(path,options);
    }
    const joined=Boolean(job);
    if(!job){
      job={path,options,keys:new Set(requestedKeys),hinted,started:false,startedAt:null,openedInfo:null,readId:nextId(),joinable:true,controller:new AbortController(),waiters:new Set()};
      jobs.add(job);counts.peakSharedJobs=Math.max(counts.peakSharedJobs,jobs.size);
      queueMicrotask(()=>{void schedule(()=>start(job),job.controller.signal).catch(error=>{job.joinable=false;jobs.delete(job);for(const waiter of [...job.waiters])waiter.finish(error);});});
    }else if(!job.started){for(const key of requestedKeys)job.keys.add(key);job.hinted||=hinted;}
    if(joined){counts.sharedRequests++;notify(options.onShared);}
    const result=await new Promise((resolve,reject)=>{
      const waiter={keys,options,finish(error,value){
        if(!job.waiters.delete(waiter))return;
        options.signal?.removeEventListener('abort',abort);
        if(!job.waiters.size){job.joinable=false;job.controller.abort();}
        if(error)reject(error);else resolve(value);
      }};
      const abort=()=>{diagnose(options,{phase:'aborted',readId:job.readId,...status(job)});waiter.finish(options.signal.reason??new DOMException('Aborted','AbortError'));};
      job.waiters.add(waiter);options.signal?.addEventListener('abort',abort,{once:true});
      diagnose(options,{phase:joined?'joined':'queued',readId:job.readId,shared:joined,...status(job)});
      if(options.signal?.aborted)abort();
    });
    if(result?.fallback){counts.projectionFallbacks++;return baseline(path,options);}
    return result;
  }
  return {
    async read(path,options){
      options.signal?.throwIfAborted();counts.requests++;counts.activeWaiters++;
      const pending=shared(path,options);pendingRequests.add(pending);
      try{return await pending;}finally{pendingRequests.delete(pending);counts.activeWaiters--;}
    },
    async drain(){
      await Promise.resolve();
      while(pendingRequests.size||reads.size||jobs.size||admissions.size)await Promise.allSettled([...pendingRequests,...reads,...admissions]);
    },
    snapshot:()=>({...counts,sharedJobs:jobs.size,admission:{active:admitted,queued:waiting.length,peakQueued,rejected:admissionRejected,maxParallelReads,maxQueuedReads},limits:{maxActiveReads,maxWaiters,maxKeys,maxSelectedBytes}}),
  };
}
