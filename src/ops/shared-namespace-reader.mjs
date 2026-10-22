import {readNamespaceEntries} from './namespace-reader.mjs';

export function createSharedNamespaceReader({read=readNamespaceEntries,maxActiveReads=8,maxWaiters=8,maxKeys=200,maxSelectedBytes=4*1024*1024}={}){
  const jobs=new Set(),reads=new Set(),pendingRequests=new Set();
  const counts={requests:0,sharedRequests:0,startedReads:0,completeReads:0,scanBytes:0,directFallbacks:0,projectionFallbacks:0,activeReads:0,activeWaiters:0,peakSharedJobs:0};
  const notify=fn=>{try{const result=fn?.();if(result&&typeof result.then==='function')Promise.resolve(result).catch(()=>{});}catch{}};
  async function actual(path,options){
    counts.startedReads++;counts.activeReads++;
    let promise;
    try{
      promise=Promise.resolve(read(path,{...options,onRead:info=>{
        counts.scanBytes+=info.bytesRead??0;if(info.complete)counts.completeReads++;
        notify(()=>options.onRead?.(info));
      }}));
      reads.add(promise);return await promise;
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
        onRead:info=>{job.joinable=false;notify(()=>job.options.onRead?.(info));}});
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
    if(options.onEntry||options.maxSelectedBytes!==undefined||options.allowProjectionOverflow!==undefined){counts.directFallbacks++;return actual(path,options);}
    let job=[...jobs].find(j=>j.joinable&&j.path===path&&j.waiters.size<maxWaiters&&
      (j.options.checkIntervalBytes??0)===(options.checkIntervalBytes??0)&&
      (j.options.chunkSize??64*1024)===(options.chunkSize??64*1024)&&
      (j.started?[...keys].every(key=>j.keys.has(key)):new Set([...j.keys,...requestedKeys]).size<=maxKeys));
    if(!job&&(jobs.size>=maxActiveReads||requestedKeys.size>maxKeys)){
      counts.directFallbacks++;return actual(path,options);
    }
    const joined=Boolean(job);
    if(!job){
      job={path,options,keys:new Set(requestedKeys),hinted,started:false,joinable:true,controller:new AbortController(),waiters:new Set()};
      jobs.add(job);counts.peakSharedJobs=Math.max(counts.peakSharedJobs,jobs.size);
      queueMicrotask(()=>void start(job));
    }else if(!job.started){for(const key of requestedKeys)job.keys.add(key);job.hinted||=hinted;}
    if(joined){counts.sharedRequests++;notify(options.onShared);}
    const result=await new Promise((resolve,reject)=>{
      const waiter={keys,finish(error,value){
        if(!job.waiters.delete(waiter))return;
        options.signal?.removeEventListener('abort',abort);
        if(!job.waiters.size){job.joinable=false;job.controller.abort();}
        if(error)reject(error);else resolve(value);
      }};
      const abort=()=>waiter.finish(options.signal.reason??new DOMException('Aborted','AbortError'));
      job.waiters.add(waiter);options.signal?.addEventListener('abort',abort,{once:true});
      if(options.signal?.aborted)abort();
    });
    if(result?.fallback){counts.projectionFallbacks++;return actual(path,options);}
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
      while(pendingRequests.size||reads.size||jobs.size)await Promise.allSettled([...pendingRequests,...reads]);
    },
    snapshot:()=>({...counts,sharedJobs:jobs.size,limits:{maxActiveReads,maxWaiters,maxKeys,maxSelectedBytes}}),
  };
}
