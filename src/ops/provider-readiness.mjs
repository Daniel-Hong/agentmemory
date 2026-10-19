// Local 0.9.29 maintenance patch; no prompt/content is retained in diagnostics.
export function networkErrorCode(error) {
  const code = error?.cause?.code ?? error?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]{1,60}$/.test(code)) return code;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'OLLAMA_TIMEOUT';
  return 'PROVIDER_UNAVAILABLE';
}
export function safeFailureDetails(error) {
  const details = error?.diagnostics ?? {};
  const result = {};
  for (const key of ['category','errorCode','field','doneReason']) {
    if (typeof details[key] === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(details[key])) result[key] = details[key];
  }
  for (const key of ['httpStatus','evalCount','responseChars','itemCount','itemLength']) {
    if (Number.isFinite(details[key])) result[key] = details[key];
  }
  return result;
}
export function providerDeferredError(readiness, error) {
  const e = new Error('provider_unavailable');
  e.providerUnavailable = true;
  e.diagnostics = {category:'provider_unavailable',errorCode:readiness?.snapshot()?.errorCode ?? networkErrorCode(error)};
  return e;
}
export function readOllamaContent(data, readiness, requestKind='unknown') {
  const content = data?.message?.content;
  const diagnostics = {doneReason:data?.done_reason,evalCount:data?.eval_count,responseChars:typeof content==='string'?content.length:0};
  readiness?.noteResponse({requestKind,...diagnostics});
  if (data?.done_reason === 'length' || data?.done === false) {
    throw Object.assign(new Error('output_truncated'), {diagnostics:{category:'output_truncated',...diagnostics}});
  }
  if (typeof content !== 'string' || !content.trim()) {
    throw Object.assign(new Error('output_empty'), {diagnostics:{category:'output_invalid',...diagnostics}});
  }
  return content;
}
export function createOllamaReadiness({baseUrl,models=[],fetchFn=fetch,clock=Date.now,probeTimeoutMs=3000,readyTtlMs=15000,maxDelayMs=300000,onStateChange}={}) {
  const origin = new URL(baseUrl).origin;
  const required = [...new Set(models.filter(Boolean))];
  let inflight=null,timer=null,started=false,stopped=false;
  const state={status:'unknown',consecutiveFailures:0,lastCheckedAt:0,nextCheckAt:0,checks:0,errorCode:null};
  function markUnavailable(error, delay) {
    const previousStatus=state.status,previousCode=state.errorCode;
    state.status='waiting';state.consecutiveFailures++;
    state.errorCode=networkErrorCode(error);
    state.nextCheckAt=clock()+(delay??Math.min(maxDelayMs,30000*2**Math.min(state.consecutiveFailures-1,6)));
    if(previousStatus!==state.status||previousCode!==state.errorCode)onStateChange?.(structuredClone(state));
  }
  async function ensureReady() {
    if(stopped)return state.status==='ready';
    if (clock()<state.nextCheckAt) return state.status==='ready';
    if (inflight) return inflight;
    inflight=(async()=>{
      state.checks++;state.lastCheckedAt=clock();
      try {
        for (const route of ['version','tags']) {
          const response=await fetchFn(origin+'/api/'+route,{signal:AbortSignal.timeout(probeTimeoutMs)});
          if (!response.ok) throw Object.assign(new Error('ollama_probe_http'),{code:'OLLAMA_HTTP_'+response.status});
          const result=await response.json();
          if(route==='tags') {
            if(!Array.isArray(result.models))throw Object.assign(new Error('ollama_probe_shape'),{code:'OLLAMA_INVALID_METADATA'});
            const names=new Set(result.models.flatMap(m=>[m.name,m.model]).filter(Boolean));
            if(required.some(name=>!names.has(name)&&!names.has(name+':latest')))throw Object.assign(new Error('ollama_model_missing'),{code:'OLLAMA_MODEL_MISSING'});
          }
        }
        const previousStatus=state.status;
        state.status='ready';state.errorCode=null;state.consecutiveFailures=0;state.nextCheckAt=clock()+readyTtlMs;
        if(previousStatus!=='ready')onStateChange?.(structuredClone(state));
        return true;
      } catch(error) {markUnavailable(error);return false;}
    })();
    try{return await inflight;}finally{inflight=null;}
  }
  async function refresh(){
    try{await ensureReady();}
    finally{if(!stopped){timer=setTimeout(()=>void refresh(),Math.max(1,state.nextCheckAt-clock()));timer.unref();}}
  }
  return {ensureReady,markUnavailable,
    start(){if(started||stopped)return;started=true;void refresh();},
    async stop(){stopped=true;clearTimeout(timer);if(inflight)await inflight;},
    async drain(){if(inflight)await inflight;},
    snapshot:()=>structuredClone(state),noteResponse:metadata=>{state.lastResponse={requestKind:metadata.requestKind,...safeFailureDetails({diagnostics:metadata})}}};
}
