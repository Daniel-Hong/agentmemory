import {readFile} from 'node:fs/promises';
const GiB=1024**3;
const SAFE_APIS=new Set(['api::liveness','api::health','api::config-flags','api::background-control-get','api::background-control-set']);

export async function readHostMemory(){
 if(process.platform!=='linux')return null;
 const text=await readFile('/proc/meminfo','utf8');
 const bytes=name=>Number(text.match(new RegExp('^'+name+':\\s+(\\d+)\\s+kB','m'))?.[1])*1024;
 return{total:bytes('MemTotal'),available:bytes('MemAvailable')};
}

export function createMemoryPressureGuard({control,readSample=readHostMemory,schedule=true,clock=Date.now}={}){
 let state={level:'unknown',totalBytes:null,availableBytes:null,reserveBytes:null,criticalBytes:null,checkedAt:null,rejectedRequests:0,recoveryStatus:'observing',stableSince:null},timer=null,active=null,pendingRecovery=null,pendingPause=null,stopped=false;
 let lastSampleAt=null,stableSince=null,sampleSequence=0;
 async function readFresh(){
  const sequence=++sampleSequence,before=clock(),m=await readSample(),now=clock();
  if(sequence!==sampleSequence||!m||!Number.isFinite(m.total)||m.total<=0||!Number.isFinite(m.available)||m.available<0||m.available>m.total||!Number.isFinite(now)||now<before||now-before>10000)throw Error('memory_sample_unavailable');
  const reserve=Math.max(2*GiB,m.total*.20),critical=Math.max(GiB/2,m.total*.05),recoveryBytes=Math.max(3*GiB,m.total*.25);
  state={...state,level:m.available<critical?'critical':m.available<reserve?'high':'normal',totalBytes:m.total,availableBytes:m.available,reserveBytes:reserve,criticalBytes:critical,recoveryBytes,sampleError:false,checkedAt:now};
  return{now,recovered:m.available>recoveryBytes};
 }
 async function sample(){
  try{
   const {now,recovered}=await readFresh();
   if(lastSampleAt===null||now<lastSampleAt||now-lastSampleAt>10000||!recovered)stableSince=null;
   lastSampleAt=now;
   if(!recovered)stableSince=null;else if(stableSince===null)stableSince=now;
   state.stableSince=stableSince;
   if(state.level!=='normal'){
    state.recoveryStatus='pressure';
    if(!pendingPause)pendingPause=control.change('pause',{source:'memory'}).then(()=>{state.pauseError=null;},()=>{state.pauseError='background_pause_failed';}).finally(()=>{pendingPause=null;});
    return;
   }
   if(pendingRecovery){state.recoveryStatus='recovering';return;}
   const c=control.snapshot();
   if(!c.holds?.includes('memory')){state.recoveryStatus='observing';return;}
   if(c.holds.length!==1||c.status==='error'){state.recoveryStatus='held';return;}
   if(c.recovery.attempts>=c.recovery.maxAttempts){state.recoveryStatus='attempt_limit';return;}
   if(now<c.recovery.nextAttemptAt){state.recoveryStatus='backoff';return;}
   state.recoveryStatus='stabilizing';
   if(stableSince===null||now-stableSince<120000)return;
   state.recoveryStatus='recovering';
   pendingRecovery=control.change('resume',{source:'memory',canResume:async()=>{
    let checked;
    try{checked=await readFresh();}catch{stableSince=null;lastSampleAt=null;state={...state,level:['high','critical'].includes(state.level)?state.level:'unknown',sampleError:true,stableSince:null};return false;}
    if(stableSince===null||checked.now-stableSince<120000||!checked.recovered||checked.now<lastSampleAt||checked.now-lastSampleAt>10000||stopped){stableSince=null;state.stableSince=null;return false;}
    lastSampleAt=checked.now;return true;
   }}).then(()=>{
    state.recoveryStatus=['high','critical'].includes(state.level)?'pressure':control.snapshot().pausedRequested?'held':'recovered';
   },()=>{state.recoveryStatus='held';}).finally(()=>{pendingRecovery=null;stableSince=null;state.stableSince=null;});
  }catch{stableSince=null;lastSampleAt=null;state={...state,level:['high','critical'].includes(state.level)?state.level:'unknown',sampleError:true,recoveryStatus:'sample_error',stableSince:null,checkedAt:clock()};}
 }
 function refresh(){if(stopped)return Promise.resolve();if(active)return active;active=sample().finally(()=>{active=null;});return active;}
 async function drain(){while(active||pendingRecovery||pendingPause)await Promise.all([active,pendingRecovery,pendingPause]);}
 return{
  refresh,snapshot:()=>({...state}),
  install(sdk,auth){
   const register=sdk.registerFunction.bind(sdk);
   sdk.registerFunction=(id,handler,...rest)=>register(id,(id.startsWith('api::')||id==='mcp::tools::call')?async req=>{
    const refusal=state.level==='critical'&&!SAFE_APIS.has(id)||(state.level==='high'||state.level==='critical')&&id==='api::background-control-set'&&req.body?.action==='resume';
    if(refusal){const denied=auth(req);if(denied)return denied;state.rejectedRequests++;return{status_code:503,headers:{'Retry-After':'30'},body:{error:'memory_pressure',retryable:true}};}
    return handler(req);
   }:handler,...rest);
  },
  start(){if(schedule&&!stopped){void refresh();timer=setInterval(()=>void refresh(),5000);timer.unref();}},
  drain,
  async stop(){stopped=true;clearInterval(timer);await drain();}
 };
}
