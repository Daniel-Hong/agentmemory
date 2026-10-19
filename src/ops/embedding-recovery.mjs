import {backgroundControl,backgroundPaused,backgroundTask} from './background-control.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {networkErrorCode} from './provider-readiness.mjs';
export const EMBEDDING_RETRY_NAMESPACE='mem:embedding-retry:v1';
export const EMBEDDING_COMMITTED_NAMESPACE='mem:embedding-committed:v1';
const digest=text=>createHash('sha256').update(text).digest('hex');
export function registerEmbeddingRecovery({kv,KV,index,provider,readiness,withKeyedLock=async(k,fn)=>fn(),logger,clock=Date.now,schedule=true,onIndexChanged,persistIndex}) {
  const state={pendingCount:0,initialized:false,lastError:null,lastSuccessAt:null};
  let pumping=false,reconciled=false,stopped=false,interval=null,initialization=null,committedRows=null,committedOffset=0;
  const active=new Set(),publications=new Map(),accepted=new Map(),pendingIds=new Set();
  const key=id=>'agentmemory:vector:'+id;
  const intentKey=id=>'agentmemory:vector-intent:'+id;
  function track(promise){active.add(promise);promise.then(()=>active.delete(promise),()=>active.delete(promise));return promise;}
  function initialize(){
    if(!initialization)initialization=(async()=>{
      for(const item of await kv.list(EMBEDDING_RETRY_NAMESPACE))pendingIds.add(item.id);
      state.pendingCount=pendingIds.size;state.initialized=true;
    })().catch(error=>{initialization=null;throw error;});
    return initialization;
  }
  function pending(item){pendingIds.add(item.id);state.pendingCount=pendingIds.size;}
  function completed(item){pendingIds.delete(item.id);state.pendingCount=pendingIds.size;}
  async function retainUnlocked(item,error,attempted) {
    await initialize();
    const old=await kv.get(EMBEDDING_RETRY_NAMESPACE,item.id);
    const attempts=(old?.attempts??0)+(attempted?1:0);
    await kv.set(EMBEDDING_RETRY_NAMESPACE,item.id,{...old,id:item.id,sessionId:item.sessionId,kind:item.kind,attempts,
      retryAt:attempted?clock()+Math.min(1800000,30000*2**Math.min(attempts-1,6)):(old?.retryAt??0),errorCode:networkErrorCode(error)});
    state.lastError=networkErrorCode(error);
    pending(item);
  }
  function retain(item,error,attempted){return withKeyedLock(intentKey(item.id),()=>retainUnlocked(item,error,attempted));}
  async function fence(keys){
    if(kv.backend!=='file')return;
    if(typeof kv.durability?.waitForKeys!=='function')throw Object.assign(Error('embedding_fence_unavailable'),{code:'EMBEDDING_FENCE_UNAVAILABLE'});
    await kv.durability.waitForKeys(kv,keys);
  }
  function certifyIntent(item){return fence([
    {scope:item.kind==='memory'?KV.memories:KV.observations(item.sessionId),key:item.id},
    {scope:EMBEDDING_RETRY_NAMESPACE,key:item.id},
  ]);}
  function enqueue(item){
    if(stopped)return Promise.reject(Object.assign(Error('embedding_recovery_stopped'),{code:'EMBEDDING_RECOVERY_STOPPED'}));
    return track(withKeyedLock(intentKey(item.id),async()=>{
      await initialize();
      const old=await kv.get(EMBEDDING_RETRY_NAMESPACE,item.id);
      if(!old)await retainUnlocked(item,{code:'CAPTURE_PENDING_EMBEDDING'},false);
      await certifyIntent(item);return !old;
    }));
  }
  async function current(item){
    const row=await kv.get(item.kind==='memory'?KV.memories:KV.observations(item.sessionId),item.id);
    if(!row||item.kind==='memory'&&row.isLatest===false)return null;
    return (String(row.title??'')+' '+String(item.kind==='memory'?(row.content??''):(row.narrative??''))).slice(0,16000);
  }
  async function discardUnlocked(item){
    try{
      if(await current(item)!==null)return false;
      index.remove(item.id);accepted.delete(item.id);
      if(typeof persistIndex!=='function')throw Object.assign(Error('embedding_durable_flush_unavailable'),{code:'EMBEDDING_FLUSH_UNAVAILABLE'});
      await persistIndex({id:item.id,entry:null});
      if(await current(item)!==null){await retainUnlocked(item,{code:'EMBEDDING_CANONICAL_RESTORED'},false);await certifyIntent(item);return false;}
      await kv.delete(EMBEDDING_COMMITTED_NAMESPACE,item.id);
      await kv.delete(EMBEDDING_RETRY_NAMESPACE,item.id);
      if(await current(item)!==null){await retainUnlocked(item,{code:'EMBEDDING_CANONICAL_RESTORED'},false);await certifyIntent(item);return false;}
      completed(item);return true;
    }catch(error){await retainUnlocked(item,error,true);throw error;}
  }
  function publish(item,version,fingerprint){
    const entry=index.get(item.id)??null;
    const promise=(async()=>{
      try {
        if(!entry)throw Object.assign(Error('embedding_vector_missing'),{code:'VECTOR_PUBLICATION_UNVERIFIED'});
        if(typeof persistIndex!=='function')throw Object.assign(Error('embedding_durable_flush_unavailable'),{code:'EMBEDDING_FLUSH_UNAVAILABLE'});
        await persistIndex({id:item.id,entry});
        await withKeyedLock(intentKey(item.id),async()=>{
          const queued=await kv.get(EMBEDDING_RETRY_NAMESPACE,item.id);
          if(queued?.generation!==version)return;
          const canonical=await current(item);
          if(canonical!==null&&digest(canonical)!==fingerprint){await retainUnlocked(item,{code:'EMBEDDING_PROJECTION_CHANGED'},false);return;}
          if(canonical===null){await discardUnlocked(item);return;}
          await kv.set(EMBEDDING_COMMITTED_NAMESPACE,item.id,{id:item.id,sessionId:item.sessionId,kind:item.kind,fingerprint,committedAt:new Date(clock()).toISOString()});
          await fence([{scope:EMBEDDING_COMMITTED_NAMESPACE,key:item.id}]);
          await kv.delete(EMBEDDING_RETRY_NAMESPACE,item.id);
          const latest=await current(item);
          if(latest===null){await discardUnlocked(item);return;}
          if(digest(latest)!==fingerprint){await retainUnlocked(item,{code:'EMBEDDING_PROJECTION_CHANGED'},false);await certifyIntent(item);return;}
          state.lastSuccessAt=new Date(clock()).toISOString();state.lastError=null;
          completed(item);
        });
      }catch(error){
        await withKeyedLock(intentKey(item.id),async()=>{
          const queued=await kv.get(EMBEDDING_RETRY_NAMESPACE,item.id);
          if(!queued||queued.generation===version)await retainUnlocked(item,error,true);
        });
        logger?.warn('Embedding index publication retained for recovery',{id:item.id,errorCode:networkErrorCode(error)});
      }
    })();
    publications.set(item.id,promise);track(promise);
    promise.then(()=>{if(publications.get(item.id)===promise)publications.delete(item.id)},()=>{if(publications.get(item.id)===promise)publications.delete(item.id)});
  }
  async function perform(item,text) {
    await initialize();
    if(text===null){await withKeyedLock(intentKey(item.id),()=>discardUnlocked(item));return false;}
    const fingerprint=digest(text);
    const inMemory=accepted.get(item.id)===fingerprint&&index.vectors?.has(item.id);
    if(!inMemory&&backgroundPaused()){await retain(item,{code:'BACKGROUND_PAUSED'},false);return false;}
    if(!inMemory&&readiness&&!await readiness.ensureReady()){await retain(item,{code:'PROVIDER_UNAVAILABLE'},false);return false;}
    const generation=randomUUID();
    // Durable intent precedes inference and mutation; restart always reads canonical text.
    await withKeyedLock(intentKey(item.id),async()=>{
      const queued=await kv.get(EMBEDDING_RETRY_NAMESPACE,item.id);
      await kv.set(EMBEDDING_RETRY_NAMESPACE,item.id,{...queued,id:item.id,sessionId:item.sessionId,kind:item.kind,attempts:queued?.attempts??0,retryAt:queued?.retryAt??0,generation,fingerprint,phase:inMemory?'embedded':'queued'});
      pending(item);
      await certifyIntent(item);
    });
    try {
      if(!inMemory){
        const vector=await provider.embed(text);
        if(vector.length!==provider.dimensions)throw Object.assign(Error('embedding_dimension_mismatch'),{code:'EMBEDDING_DIMENSION_MISMATCH'});
        const canonical=await current(item);
        if(canonical===null){await withKeyedLock(intentKey(item.id),()=>discardUnlocked(item));return false;}
        if(digest(canonical)!==fingerprint){await retain(item,{code:'EMBEDDING_PROJECTION_CHANGED'},false);return false;}
        index.add(item.id,item.sessionId,vector);accepted.set(item.id,fingerprint);onIndexChanged?.();
      }
      await kv.set(EMBEDDING_RETRY_NAMESPACE,item.id,{...await kv.get(EMBEDDING_RETRY_NAMESPACE,item.id),phase:'embedded'});
      publish(item,generation,fingerprint);
      return true;
    }catch(error){
      const code=networkErrorCode(error);
      if(!error?.providerUnavailable&&code!=='EMBEDDING_DIMENSION_MISMATCH'&&(error?.message==='fetch failed'||code==='OLLAMA_TIMEOUT'||/^(ECONN|ENET|EHOST|UND_ERR)/.test(code)))readiness?.markUnavailable(error);
      await retain(item,error,!error?.providerUnavailable);logger?.warn('Embedding retained for recovery',{id:item.id,errorCode:code});return false;
    }
  }
  function add(item){if(stopped)return Promise.resolve(false);return track(withKeyedLock(key(item.id),async()=>{if(stopped)return false;if(backgroundPaused()){await retain(item,{code:'BACKGROUND_PAUSED'},false);return false;}return backgroundTask(async()=>perform(item,await current(item)))();}));}
  async function reconcile(limit=Infinity){
    await initialize();
    if(stopped||!index.vectors?.has)return;
    if(!committedRows)committedRows=await kv.list(EMBEDDING_COMMITTED_NAMESPACE);
    const end=Math.min(committedRows.length,committedOffset+limit);
    while(committedOffset<end){
      const item=committedRows[committedOffset];
      if(stopped)return;
      await withKeyedLock(key(item.id),async()=>{
        if(await kv.get(EMBEDDING_RETRY_NAMESPACE,item.id))return;
        const text=await current(item);
        if(text!==null&&index.vectors.has(item.id)&&item.fingerprint===digest(text))return;
        await retain(item,{code:text===null?'EMBEDDING_CANONICAL_DELETED':'EMBEDDING_INDEX_GAP'},false);
      });
      committedOffset++;
    }
    reconciled=committedOffset===committedRows.length;
    if(reconciled){committedRows=null;committedOffset=0;}
  }
  async function runPump(){
    if(stopped||backgroundPaused()||pumping)return;pumping=true;
    try{
      if(!reconciled)await reconcile(50);
      const rows=await kv.list(EMBEDDING_RETRY_NAMESPACE);
      let attempted=0;
      for(const item of rows){
        if(stopped||backgroundPaused())break;
        if(item.retryAt>clock()||publications.has(item.id))continue;
        if(attempted++>=5)break;
        await withKeyedLock(key(item.id),async()=>{
          if(stopped||publications.has(item.id))return;
          const queued=await kv.get(EMBEDDING_RETRY_NAMESPACE,item.id);if(!queued)return;
          await perform(queued,await current(queued));
        });
        if(readiness?.snapshot?.().status==='waiting')break;
      }
    }catch(error){state.lastError=networkErrorCode(error);logger?.warn('Embedding recovery scan deferred',{errorCode:state.lastError});}
    finally{pumping=false;}
  }
  function pump(){if(stopped)return Promise.resolve();return track(initialize().then(()=>backgroundTask(runPump)()));}
  function stop(){stopped=true;if(interval){clearInterval(interval);interval=null;}}
  async function drain(){while(active.size)await Promise.allSettled([...active]);}
  function start(){if(stopped||interval)return;void track(initialize()).catch(error=>{state.lastError=networkErrorCode(error);});interval=setInterval(()=>void pump().catch(error=>{state.lastError=networkErrorCode(error);logger?.warn('Embedding recovery initialization deferred',{errorCode:state.lastError});}),15000);interval.unref();}
  if(schedule)start();
  return {add,enqueue,pump,start,initialize:()=>track(initialize()),reconcile:()=>track(reconcile()),stop,drain,defer:(item,error,attempted=true)=>stopped?Promise.resolve(false):track(withKeyedLock(key(item.id),()=>retain(item,error,attempted))),snapshot:()=>structuredClone(state)};
}
