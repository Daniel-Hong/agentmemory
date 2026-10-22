import {open,stat} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {createSharedNamespaceReader} from './shared-namespace-reader.mjs';
import {createDurabilityMeasurements} from './durability-measurement.mjs';
const signature=value=>[value.dev,value.ino,value.size,value.mtimeNs,value.ctimeNs].join(':');

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

export function createStateDurabilityFence({storePath,timeoutMs=15000,pollIntervalMs=100,clock=Date.now}={}){
  if(typeof storePath!=='string'||!isAbsolute(storePath))throw Error('absolute_state_store_path_required');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||!Number.isSafeInteger(pollIntervalMs)||pollIntervalMs<1)throw Error('state_durability_interval_invalid');
  let frozen=false,mutationFailures=0,revision=0,pruning=false,lastVerification=null,pruneSequence=0;
  const active=new Set(),touched=new Map(),pruneAttempts=new Map();
  const measurements=createDurabilityMeasurements();
  const readSharing=createSharedNamespaceReader();
  function remember(scope,key){if(!touched.has(scope))touched.set(scope,new Map());touched.get(scope).set(key,{revision:++revision,lastTouched:clock()});}
  function keys(){return [...touched].flatMap(([scope,items])=>[...items].map(([key,stamp])=>({scope,key,...stamp})));}
  function keysFor(selected){return selected.map(({scope,key})=>({scope,key,...touched.get(scope)?.get(key)}));}
  function forgetKeys(selected){for(const {scope,key,revision} of selected){const map=touched.get(scope);if(revision===undefined||map?.get(key)?.revision!==revision)continue;map.delete(key);if(!map.size){touched.delete(scope);pruneAttempts.delete(scope);}}}
  function stableKeys({minAgeMs=15000,limit=200}={}){
    if(!Number.isSafeInteger(minAgeMs)||minAgeMs<0||!Number.isSafeInteger(limit)||limit<1||limit>200)throw Error('state_stable_selection_invalid');
    const now=clock();return keys().filter(item=>now-item.lastTouched>=minAgeMs).sort((a,b)=>(pruneAttempts.get(a.scope)??0)-(pruneAttempts.get(b.scope)??0)||a.lastTouched-b.lastTouched||a.scope.localeCompare(b.scope)||a.key.localeCompare(b.key)).slice(0,limit);
  }
  function mutate(scope,key,fn){
    if(frozen)return Promise.reject(Object.assign(Error('state_mutations_frozen'),{code:'STATE_FROZEN'}));
    remember(scope,key);const promise=Promise.resolve().then(fn);active.add(promise);
    promise.then(()=>{remember(scope,key);active.delete(promise);},()=>{remember(scope,key);active.delete(promise);mutationFailures++;});return promise;
  }
  async function drain(){while(active.size)await Promise.allSettled([...active]);await readSharing.drain();}
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
    const batch={deadline:Math.min(deadline??Infinity,clock()+timeoutMs),closed:false};
    function close(){batch.closed=true;for(let i=groupedQueue.length-1;i>=0;i--)if(groupedQueue[i].batch===batch)groupedQueue.splice(i,1)[0].reject(captureTimeout());}
    const limited={get:(scope,key)=>new Promise((resolve,reject)=>{groupedQueue.push({kv,scope,key,resolve,reject,batch});pumpGets();})};
    const sharedSelection=new Map();
    for(const selection of selections)for(const {scope,key} of selection){if(!sharedSelection.has(scope))sharedSelection.set(scope,new Set());sharedSelection.get(scope).add(key);}
    const timer=setTimeout(close,Math.max(0,batch.deadline-clock()));
    try{return await Promise.allSettled(selections.map(selected=>waitForKeys(limited,selected,{deadline:batch.deadline},sharedSelection)));}
    finally{clearTimeout(timer);close();}
  }
  async function waitForKeys(kv,selected,{deadline,expectedValues}={},sharedSelection){
    if(deadline!==undefined&&!Number.isSafeInteger(deadline))throw Error('state_durability_deadline_invalid');
    if(expectedValues!==undefined&&(!Array.isArray(expectedValues)||expectedValues.length!==selected.length))throw Error('state_durability_expectations_invalid');
    const pinned=expectedValues===undefined?undefined:structuredClone(expectedValues);
    const budgetMs=deadline===undefined?timeoutMs:Math.min(timeoutMs,Math.max(0,deadline-clock()));
    const began=clock(),expected=new Map(),unchangedMismatches=new Map(),selectedRevisions=selected.map(item=>({...item,revision:item.revision??touched.get(item.scope)?.get(item.key)?.revision}));
    let stage='capture',capturedKeyCount=0,lastCode='STATE_NOT_COMMITTED';
    const details=()=>({category:'state_durability',errorCode:lastCode,stage,keyCount:selected.length,scopeCount:expected.size,capturedKeyCount,elapsedMs:Math.max(0,clock()-began)});
    const failed=()=>{const diagnostics=details();lastVerification={status:'failed',at:clock(),...diagnostics,errorCode:'STATE_DURABILITY_TIMEOUT',causeCode:lastCode};return Object.assign(Error('state_durability_timeout'),{code:'STATE_DURABILITY_TIMEOUT',diagnostics});};
    async function capture(scope,key,index){
      const remaining=budgetMs-(clock()-began);if(remaining<=0)throw failed();
      let timer;
      try{const value=(await Promise.race([kv.get(scope,key),new Promise((_,reject)=>{timer=setTimeout(()=>reject(failed()),remaining);})]))??null;if(pinned&&!isDeepStrictEqual(value,pinned[index]))throw Object.assign(Error('state_expectation_changed'),{code:'STATE_EXPECTATION_CHANGED'});return pinned?pinned[index]:value;}
      finally{clearTimeout(timer);}
    }
    for(const {scope} of selected)if(!expected.has(scope))expected.set(scope,new Map());
    const measurement=measurements.begin(expected.keys(),selected.length);
    let outcome='failed';
    try{
    let captureFailed=false,captureError;
    try{
      // Bound SDK concurrency; serial capture alone can exhaust the publication deadline.
      for(let offset=0;offset<selected.length;offset+=4)await Promise.all(selected.slice(offset,offset+4).map(async({scope,key},index)=>{expected.get(scope).set(key,(await capture(scope,key,offset+index))??null);capturedKeyCount++;}));
    }catch(error){captureFailed=true;captureError=error;}
    if(captureFailed){lastCode=captureError?.code==='STATE_DURABILITY_TIMEOUT'?'STATE_CAPTURE_TIMEOUT':typeof captureError?.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(captureError.code)?captureError.code:'STATE_CAPTURE_FAILED';throw failed();}
    const files=[...expected.keys()].map(scope=>({scope,path:join(storePath,encodeURIComponent(scope)+'.bin')}));
    async function check(){
      const absent=[],signatures=new Map();
      for(const file of files){let rows;const mismatch=unchangedMismatches.get(file.scope);
        if(mismatch){
          let current;try{current=signature(await stat(file.path,{bigint:true}));}catch(error){if(error.code!=='ENOENT')throw error;}
          if(current===mismatch){measurement?.skipUnchangedMismatch();throw Error('state_namespace_not_committed');}
          unchangedMismatches.delete(file.scope);
        }
        const controller=new AbortController(),remaining=budgetMs-(clock()-began);
        if(remaining<=0)throw Object.assign(Error('state_readback_timeout'),{code:'STATE_READBACK_TIMEOUT'});
        const timer=setTimeout(()=>controller.abort(),remaining);
        try{const read=await readSharing.read(file.path,{keys:new Set(expected.get(file.scope).keys()),joinKeys:sharedSelection?.get(file.scope),checkIntervalBytes:1024*1024,signal:controller.signal,onShared:()=>measurement?.sharedRead(),onRead:info=>measurement?.read(file.scope,info)});rows=read.values;signatures.set(file.path,read.signature);}catch(error){if(controller.signal.aborted)throw Object.assign(Error('state_readback_timeout'),{code:'STATE_READBACK_TIMEOUT'});if(error.code==='ENOENT'){rows=new Map();absent.push(file.path);}else throw error;}finally{clearTimeout(timer);}
        for(const [key,want] of expected.get(file.scope))if(!isDeepStrictEqual(rows.get(key)??null,want)){
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
          const current=touched.get(item.scope)?.get(item.key)?.revision;
          if(current!==undefined&&current!==item.revision){
            measurement?.enter('capture');
            item.revision=current;
            unchangedMismatches.delete(item.scope);
            expected.get(item.scope).set(item.key,(await capture(item.scope,item.key,index))??null);
          }
        }
        stage='readback';
        measurement?.enter('readback');measurement?.check();
        const {absent,signatures}=await check();
        stage='fsync';
        measurement?.enter('fsync');
        for(const file of files){if(absent.includes(file.path))continue;const handle=await open(file.path,'r');handles.push(handle);if(signature(await handle.stat({bigint:true}))!==signatures.get(file.path))throw Error('state_namespace_changed');await handle.sync();if(signature(await handle.stat({bigint:true}))!==signatures.get(file.path))throw Error('state_namespace_changed');}
        const directory=await open(storePath,'r');handles.push(directory);await directory.sync();
        // The validated bytes remain current only if the synced file's full signature still matches.
        stage='verify';
        measurement?.enter('verify');
        for(const file of files){
          let current;try{current=signature(await stat(file.path,{bigint:true}));}catch(error){if(error.code!=='ENOENT')throw error;}
          if(current!==signatures.get(file.path))throw Error('state_namespace_changed');
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
    }finally{measurement?.finish(outcome,lastCode,stage);}
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
    return {keys:verifiedKeys,scopes:scopes.size,synced:true,waitMs:clock()-began,mutationFailures};
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
  return {mutate,keys,keysFor,forgetKeys,stableKeys,flushStable,freeze(){frozen=true;},drain,wait,waitForKeys,waitForKeyGroups,snapshot:()=>({frozen,activeMutations:active.size,touchedScopes:touched.size,mutationFailures,pruning,lastVerification:structuredClone(lastVerification),measurements:measurements.snapshot(),readSharing:readSharing.snapshot()})};
}
