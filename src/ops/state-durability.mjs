import {open,stat} from 'node:fs/promises';
import {AsyncLocalStorage} from 'node:async_hooks';
import {isAbsolute,join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {createSharedNamespaceReader} from './shared-namespace-reader.mjs';
import {createReadCoordinator} from './read-coordinator.mjs';
import {createDurabilityMeasurements} from './durability-measurement.mjs';
const signature=value=>[value.dev,value.ino,value.size,value.mtimeNs,value.ctimeNs].join(':');
const MAX_SHARED_READ_MS=15_000;

export function namespaceJson(buffer){
  // iii file_based namespaces archive a JSON String followed by rkyv metadata.
  // Find the JSON object's boundary once, respecting quoted braces/escapes.
  let quoted=false,escaped=false,depth=0,start=-1;
  for(let i=0;i<buffer.length;i++){
    const byte=buffer[i];
    if(start<0){if([9,10,13,32].includes(byte))continue;if(byte!==123)throw Error('state_namespace_shape');start=i;depth=1;continue;}
    if(quoted){if(escaped)escaped=false;else if(byte===92)escaped=true;else if(byte===34)quoted=false;continue;}
    if(byte===34){quoted=true;continue;}
    if(byte===123||byte===91)depth++;
    else if(byte===125||byte===93){depth--;if(depth===0){const rows=JSON.parse(buffer.subarray(start,i+1).toString('utf8'));if(!rows||Array.isArray(rows)||typeof rows!=='object')throw Error('state_namespace_shape');return rows;}}
  }
  throw Error('state_namespace_incomplete');
}

export function createStateDurabilityFence({storePath,timeoutMs=15000,pollIntervalMs=100,clock=Date.now,completion='disk'}={}){
  if(typeof storePath!=='string'||!isAbsolute(storePath))throw Error('absolute_state_store_path_required');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||!Number.isSafeInteger(pollIntervalMs)||pollIntervalMs<1)throw Error('state_durability_interval_invalid');
  if(!['sdk','disk'].includes(completion))throw Error('state_completion_invalid');
  let sdkCompleted=0,sdkFailed=0;
  let frozen=false,mutationFailures=0,revision=0,pruning=false,lastVerification=null,pruneSequence=0;
  const active=new Set(),mutationKeys=new WeakMap(),touched=new Map(),pruneAttempts=new Map(),revisionObservers=new Map();
  const certificates=new Set(),certificateContext=new AsyncLocalStorage();
  const measurements=createDurabilityMeasurements();
  const readCoordinator=createReadCoordinator({clock});
  const readSharing=createSharedNamespaceReader({maxParallelReads:1,maxSmallParallelReads:1,maxJobMs:MAX_SHARED_READ_MS,trackRead:(work,options)=>readCoordinator.run('critical',work,options)});
  function remember(scope,key){if(!touched.has(scope))touched.set(scope,new Map());touched.get(scope).set(key,{revision:++revision,lastTouched:clock()});for(const item of revisionObservers.get(scope)?.get(key)??[])item.observedRevision=revision;}
  function observeRevisions(items){
    for(const item of items){
      if(!revisionObservers.has(item.scope))revisionObservers.set(item.scope,new Map());
      const scope=revisionObservers.get(item.scope);if(!scope.has(item.key))scope.set(item.key,new Set());
      item.observedRevision=touched.get(item.scope)?.get(item.key)?.revision;scope.get(item.key).add(item);
    }
    return()=>{for(const item of items){const scope=revisionObservers.get(item.scope),keys=scope?.get(item.key);keys?.delete(item);if(!keys?.size)scope?.delete(item.key);if(!scope?.size)revisionObservers.delete(item.scope);}};
  }
  function watchKeys(selected){
    if(!Array.isArray(selected)||!selected.length||selected.length>200||selected.some(item=>typeof item?.scope!=='string'||typeof item?.key!=='string'))throw Error('state_mutation_selection_invalid');
    const items=selected.map(({scope,key})=>({scope,key,revision:touched.get(scope)?.get(key)?.revision}));
    const release=observeRevisions(items);
    const pending=[...active].some(promise=>{const pair=mutationKeys.get(promise);return items.some(item=>pair?.scope===item.scope&&pair?.key===item.key);});
    let released=false;
    // Observers survive dirty-key pruning; no permanent per-record history is retained.
    return {unchanged:()=>!released&&!pending&&items.every(item=>item.observedRevision===item.revision),release(){if(!released){released=true;release();}}};
  }
  function keys(){return [...touched].flatMap(([scope,items])=>[...items].map(([key,stamp])=>({scope,key,...stamp})));}
  function keysFor(selected){return selected.map(({scope,key})=>({scope,key,...touched.get(scope)?.get(key)}));}
  function forgetKeys(selected){for(const {scope,key,revision} of selected){const map=touched.get(scope);if(revision===undefined||map?.get(key)?.revision!==revision)continue;map.delete(key);if(!map.size){touched.delete(scope);pruneAttempts.delete(scope);}}}
  function stableKeys({minAgeMs=15000,limit=200}={}){
    if(!Number.isSafeInteger(minAgeMs)||minAgeMs<0||!Number.isSafeInteger(limit)||limit<1||limit>200)throw Error('state_stable_selection_invalid');
    const now=clock();return keys().filter(item=>now-item.lastTouched>=minAgeMs).sort((a,b)=>(pruneAttempts.get(a.scope)??0)-(pruneAttempts.get(b.scope)??0)||a.lastTouched-b.lastTouched||a.scope.localeCompare(b.scope)||a.key.localeCompare(b.key)).slice(0,limit);
  }
  function mutate(scope,key,fn){
    if(frozen)return Promise.reject(Object.assign(Error('state_mutations_frozen'),{code:'STATE_FROZEN'}));
    remember(scope,key);const promise=Promise.resolve().then(fn);mutationKeys.set(promise,{scope,key});active.add(promise);
    promise.then(()=>{remember(scope,key);active.delete(promise);},()=>{remember(scope,key);active.delete(promise);mutationFailures++;});return promise;
  }
  async function drain(){
    if(certificateContext.getStore()?.active)throw Object.assign(Error('state_read_coordination_reentrant'),{code:'STATE_READ_COORDINATION_REENTRANT'});
    await readCoordinator.drain();
    do{
      while(active.size||certificates.size)await Promise.allSettled([...active,...certificates]);
      await readSharing.drain();await readCoordinator.drain();
    }while(active.size||certificates.size);
  }
  // Slots belong to this fence, so timed-out SDK calls still occupy capacity.
  let groupedGets=0;const groupedQueue=[];
  const captureTimeout=()=>Object.assign(Error('state_capture_timeout'),{code:'STATE_DURABILITY_TIMEOUT'});
  function pumpGets(){
    while(groupedGets<4&&groupedQueue.length){
      const request=groupedQueue.shift();
      if(request.batch.closed||clock()>=request.batch.deadline){request.reject(captureTimeout());continue;}
      groupedGets++;
      Promise.resolve().then(()=>{
        if(request.batch.closed||clock()>=request.batch.deadline)throw captureTimeout();
        return request.kv.get(request.scope,request.key);
      }).then(request.resolve,request.reject).finally(()=>{groupedGets--;pumpGets();});
    }
  }
  async function waitForKeyGroups(kv,groups,{deadline}={}){
    if(!Array.isArray(groups)||groups.length<1||groups.length>5||groups.some(group=>!Array.isArray(group)||!group.length||group.some(item=>typeof item.scope!=='string'||typeof item.key!=='string'))||groups.reduce((n,group)=>n+group.length,0)>200)throw Error('state_durability_groups_invalid');
    if(deadline!==undefined&&!Number.isSafeInteger(deadline))throw Error('state_durability_deadline_invalid');
    const selections=groups.map(group=>group.map(({scope,key})=>({scope,key})));
    const batch={deadline:Math.floor(Math.min(deadline??Infinity,clock()+timeoutMs)),closed:false};
    function close(){batch.closed=true;for(let i=groupedQueue.length-1;i>=0;i--)if(groupedQueue[i].batch===batch)groupedQueue.splice(i,1)[0].reject(captureTimeout());}
    const limited={get:(scope,key)=>new Promise((resolve,reject)=>{groupedQueue.push({kv,scope,key,resolve,reject,batch});pumpGets();})};
    const sharedSelection=new Map();
    for(const selection of selections)for(const {scope,key} of selection){if(!sharedSelection.has(scope))sharedSelection.set(scope,new Set());sharedSelection.get(scope).add(key);}
    const timer=setTimeout(close,Math.max(0,batch.deadline-clock()));
    try{return await Promise.allSettled(selections.map(selected=>waitForKeys(limited,selected,{deadline:batch.deadline},sharedSelection)));}
    finally{clearTimeout(timer);close();}
  }
  function waitForKeys(...args){
    if(certificateContext.getStore()?.active)return Promise.reject(Object.assign(Error('state_read_coordination_reentrant'),{code:'STATE_READ_COORDINATION_REENTRANT'}));
    const token={active:true},pending=certificateContext.run(token,()=>verifyKeys(...args));
    certificates.add(pending);
    const settled=()=>{token.active=false;certificates.delete(pending);};pending.then(settled,settled);
    return pending;
  }
  async function verifyKeys(kv,selected,{deadline,expectedValues}={},sharedSelection){
    if(completion==='sdk'&&mutationFailures)throw Object.assign(Error('sdk_mutation_uncertain'),{code:'SDK_MUTATION_UNCERTAIN'});
    if(deadline!==undefined&&!Number.isSafeInteger(deadline))throw Error('state_durability_deadline_invalid');
    if(expectedValues!==undefined&&(!Array.isArray(expectedValues)||expectedValues.length!==selected.length))throw Error('state_durability_expectations_invalid');
    const pinned=expectedValues===undefined?undefined:structuredClone(expectedValues);
    const began=clock();
    const budgetMs=deadline===undefined?timeoutMs:Math.min(timeoutMs,Math.max(0,deadline-began));
    const expected=new Map(),unchangedMismatches=new Map(),selectedRevisions=selected.map(item=>({...item,revision:item.revision??touched.get(item.scope)?.get(item.key)?.revision}));
    let stage='capture',capturedKeyCount=0,lastCode='STATE_NOT_COMMITTED',captureClosed=false;
    const details=()=>({category:'state_durability',errorCode:lastCode,stage,keyCount:selected.length,scopeCount:expected.size,capturedKeyCount,elapsedMs:Math.max(0,clock()-began),...(measurement?.certificateRef?{certificateRef:measurement.certificateRef}:{}),...(measurement?.readbackEvidence?.()?{reader:measurement.readbackEvidence()}:{})});
    const failed=()=>{const diagnostics=details();if(diagnostics.elapsedMs>=budgetMs)measurement?.event('deadline',undefined,{stage});lastVerification={status:'failed',at:clock(),...diagnostics,errorCode:'STATE_DURABILITY_TIMEOUT',causeCode:lastCode};return Object.assign(Error('state_durability_timeout'),{code:'STATE_DURABILITY_TIMEOUT',diagnostics});};
    async function capture(scope,key,index){
      const remaining=budgetMs-(clock()-began);if(remaining<=0)throw failed();
      let timer;
      try{const value=(await Promise.race([kv.get(scope,key),new Promise((_,reject)=>{timer=setTimeout(()=>reject(captureClosed?captureTimeout():failed()),remaining);})]))??null;if(pinned&&!isDeepStrictEqual(value,pinned[index]))throw Object.assign(Error('state_expectation_changed'),{code:'STATE_EXPECTATION_CHANGED'});return pinned?pinned[index]:value;}
      finally{clearTimeout(timer);}
    }
    for(const {scope} of selected)if(!expected.has(scope))expected.set(scope,new Map());
    const measurement=completion==='disk'?measurements.begin(expected.keys(),selected.length,{budgetMs,startedAt:began}):null;
    const stopObserving=completion==='disk'?observeRevisions(selectedRevisions):()=>{};
    let outcome='failed';
    try{
    stage='capture';measurement?.enter('capture');
    let captureFailed=false,captureError,nextCapture=0;
    async function captureNext(){
      while(!captureClosed&&nextCapture<selected.length){
        const index=nextCapture++,{scope,key}=selected[index];
        try{
          const value=(await capture(scope,key,index))??null;
          if(captureClosed)return;
          expected.get(scope).set(key,value);capturedKeyCount++;
        }catch(error){captureClosed=true;throw error;}
      }
    }
    try{
      if(completion==='sdk'&&!pinned){
        let timer;try{await Promise.race([Promise.allSettled([...active]),new Promise((_,reject)=>{timer=setTimeout(()=>reject(captureTimeout()),Math.max(0,budgetMs-(clock()-began)));})]);}finally{clearTimeout(timer);}
        if(mutationFailures)throw Object.assign(Error('sdk_mutation_uncertain'),{code:'SDK_MUTATION_UNCERTAIN'});
      }
      // Refill free SDK slots instead of waiting for the slowest lookup in each quartet.
      if(completion!=='sdk'||pinned)await Promise.all(Array.from({length:Math.min(4,selected.length)},()=>captureNext()));
    }catch(error){captureFailed=true;captureError=error;}
    finally{captureClosed=true;}
    if(captureFailed){lastCode=captureError?.code==='STATE_DURABILITY_TIMEOUT'?'STATE_CAPTURE_TIMEOUT':typeof captureError?.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(captureError.code)?captureError.code:'STATE_CAPTURE_FAILED';throw failed();}
    measurement?.event('capture_finished',undefined,{capturedKeyCount});
    if(completion==='sdk'){
      if(mutationFailures)throw Object.assign(Error('sdk_mutation_uncertain'),{code:'SDK_MUTATION_UNCERTAIN'});
      if(clock()-began>=budgetMs)throw failed();
      forgetKeys(selectedRevisions);outcome='sdk_completed';
      lastVerification={status:'sdk_completed',at:clock(),completion,synced:false,errorCode:null};
      return {keys:selected.length,scopes:expected.size,completion,completed:true,synced:false,waitMs:clock()-began,mutationFailures};
    }

    const files=[...expected.keys()].map(scope=>({scope,path:join(storePath,encodeURIComponent(scope)+'.bin')}));
    async function check(){
      const absent=[],signatures=new Map();
      for(const file of files){let rows;const mismatch=unchangedMismatches.get(file.scope);
        if(mismatch){
          let current;try{current=signature(await stat(file.path,{bigint:true}));}catch(error){if(error.code!=='ENOENT')throw error;}
          if(current===mismatch){measurement?.skipUnchangedMismatch();measurement?.event('unchanged_mismatch_skip',file.scope);throw Error('state_namespace_not_committed');}
          unchangedMismatches.delete(file.scope);
        }
        const controller=new AbortController(),remaining=budgetMs-(clock()-began);
        if(remaining<=0)throw Object.assign(Error('state_readback_timeout'),{code:'STATE_READBACK_TIMEOUT'});
        const timer=setTimeout(()=>controller.abort(),remaining);
        measurement?.event('read_requested',file.scope);
        try{const read=await readSharing.read(file.path,{keys:new Set(expected.get(file.scope).keys()),joinKeys:sharedSelection?.get(file.scope),checkIntervalBytes:1024*1024,signal:controller.signal,onDiagnostic:info=>measurement?.event('read_'+info.phase,file.scope,info),onShared:()=>measurement?.sharedRead(),onRead:info=>measurement?.read(file.scope,info)});rows=read.values;signatures.set(file.path,read.signature);}catch(error){if(error.code==='state_namespace_changed')measurement?.event('signature_changed',file.scope,{stage:'readback'});if(controller.signal.aborted)throw Object.assign(Error('state_readback_timeout'),{code:'STATE_READBACK_TIMEOUT'});if(error.code==='ENOENT'){rows=new Map();absent.push(file.path);}else throw error;}finally{clearTimeout(timer);}
        for(const [key,want] of expected.get(file.scope))if(!isDeepStrictEqual(rows.get(key)??null,want)){
          try{measurement?.event('mismatch',file.scope,{mismatch:!rows.has(key)&&want!==null?'missing':file.scope==='mem:embedding-retry:v1'&&want?.generation!==rows.get(key)?.generation?'retry_generation':'value'});}catch{}
          if(signatures.has(file.path))unchangedMismatches.set(file.scope,signatures.get(file.path));
          throw Error('state_namespace_not_committed');
        }
      }
      return {absent,signatures};
    }
    while(clock()-began<budgetMs){
      const handles=[];
      try{
        // Foreground capture may supersede a drained background value before disk publication.
        for(const [index,item] of selectedRevisions.entries()){
          const current=item.observedRevision;
          if(current!==undefined&&current!==item.revision){
            measurement?.enter('capture');
            item.revision=current;
            unchangedMismatches.delete(item.scope);
            const previous=expected.get(item.scope).get(item.key),next=(await capture(item.scope,item.key,index))??null;
            try{measurement?.event('revision_recapture',item.scope,{valueChanged:!isDeepStrictEqual(previous,next),...(item.scope==='mem:embedding-retry:v1'?{generationChanged:previous?.generation!==next?.generation}:{})});}catch{}
            expected.get(item.scope).set(item.key,next);
          }
        }
        stage='readback';
        measurement?.enter('readback');measurement?.check();
        const {absent,signatures}=await check();
        stage='fsync';
        measurement?.enter('fsync');
        for(const file of files){if(absent.includes(file.path))continue;const handle=await open(file.path,'r');handles.push(handle);if(signature(await handle.stat({bigint:true}))!==signatures.get(file.path)){measurement?.event('signature_changed',file.scope,{stage:'fsync'});throw Error('state_namespace_changed');}await handle.sync();if(signature(await handle.stat({bigint:true}))!==signatures.get(file.path)){measurement?.event('signature_changed',file.scope,{stage:'fsync'});throw Error('state_namespace_changed');}}
        const directory=await open(storePath,'r');handles.push(directory);await directory.sync();
        // The validated bytes remain current only if the synced file's full signature still matches.
        stage='verify';
        measurement?.enter('verify');
        for(const file of files){
          let current;try{current=signature(await stat(file.path,{bigint:true}));}catch(error){if(error.code!=='ENOENT')throw error;}
          if(current!==signatures.get(file.path)){measurement?.event('signature_changed',file.scope,{stage:'verify'});throw Error('state_namespace_changed');}
        }
        if(clock()-began>=budgetMs)throw Object.assign(Error('state_readback_timeout'),{code:'STATE_READBACK_TIMEOUT'});
        forgetKeys(selectedRevisions);
        lastVerification={status:'verified',at:clock(),...details(),errorCode:null};
        outcome='verified';
        return {keys:[...expected.values()].reduce((n,map)=>n+map.size,0),scopes:expected.size,synced:true,waitMs:clock()-began,mutationFailures};
      }catch(error){lastCode=typeof error.code==='string'?error.code:typeof error.message==='string'&&error.message.startsWith('state_')?error.message:'STATE_SYNC_FAILED';measurement?.retry(lastCode,stage);}
      finally{measurement?.enter('cleanup');await Promise.allSettled(handles.map(handle=>handle.close()));}
      measurement?.enter('retryWait');
      await new Promise(resolve=>setTimeout(resolve,Math.min(pollIntervalMs,Math.max(1,budgetMs-(clock()-began)))));
    }
    throw failed();
    }catch(error){
      if(typeof error?.code==='string'&&error.code.startsWith('STATE_READ_COORDINATION_')){outcome='failed';stage='admission';lastCode=error.code;measurement?.retry(lastCode,stage);throw failed();}
      throw error;
    }finally{stopObserving();if(completion==='sdk'){if(outcome==='sdk_completed')sdkCompleted=Math.min(Number.MAX_SAFE_INTEGER,sdkCompleted+1);else sdkFailed=Math.min(Number.MAX_SAFE_INTEGER,sdkFailed+1);}else{measurement?.finish(outcome,lastCode,stage);measurements.complete(outcome,stage,lastCode);}}
  }
  async function publishScopes(kv,selected){
    const began=clock(),groups=new Map();
    if(!selected.length)return waitForKeys(kv,selected);
    for(const item of selected){if(!groups.has(item.scope))groups.set(item.scope,[]);groups.get(item.scope).push(item);}
    let verifiedKeys=0,firstFailure,failedVerification;const scopes=new Set();
    // One busy namespace must not consume another namespace's publication budget.
    for(const [scope,items] of groups){
      for(let offset=0;offset<items.length;offset+=200){
        try{const result=await waitForKeys(kv,items.slice(offset,offset+200));verifiedKeys+=result.keys;scopes.add(scope);}
        catch(error){if(!firstFailure){firstFailure=error;failedVerification={status:'failed',at:clock(),...error.diagnostics,errorCode:error.code,causeCode:error.diagnostics?.errorCode};}break;}
      }
    }
    if(firstFailure){lastVerification=failedVerification;throw firstFailure;}
    return {keys:verifiedKeys,scopes:scopes.size,completion,completed:true,synced:completion==='disk',waitMs:clock()-began,mutationFailures};
  }
  async function wait(kv){await drain();return publishScopes(kv,keys());}
  async function flushStable(kv,options){
    if(frozen||pruning)return {success:true,skipped:true,reason:frozen?'frozen':'already_pruning'};
    const selected=stableKeys(options);if(!selected.length)return {success:true,skipped:true,reason:'no_stable_dirty_keys'};
    // Rotate attempted scopes behind untouched scopes even when a full batch fails.
    for(const scope of new Set(selected.map(item=>item.scope)))pruneAttempts.set(scope,++pruneSequence);
    pruning=true;
    try{return {success:true,...await publishScopes(kv,selected)};}
    catch(error){return {success:false,deferred:true,errorCode:typeof error.code==='string'?error.code:'STATE_DURABILITY_UNAVAILABLE',diagnostics:error.diagnostics??null,retained:true};}
    finally{pruning=false;}
  }
  return {completion,withBulkRead:(work,options)=>readCoordinator.run('bulk',work,options),mutate,keys,keysFor,watchKeys,forgetKeys,stableKeys,flushStable,freeze(){frozen=true;},drain,wait,waitForKeys,waitForKeyGroups,snapshot:()=>({completion,sdkCompletion:completion==='sdk'?{completed:sdkCompleted,failed:sdkFailed}:null,frozen,activeMutations:active.size,touchedScopes:touched.size,mutationFailures,pruning,lastVerification:structuredClone(lastVerification),measurements:completion==='disk'?measurements.snapshot():null,readSharing:readSharing.snapshot(),readCoordination:readCoordinator.snapshot()})};
}
