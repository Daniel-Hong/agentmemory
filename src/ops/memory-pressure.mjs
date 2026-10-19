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
 let state={level:'unknown',totalBytes:null,availableBytes:null,reserveBytes:null,criticalBytes:null,checkedAt:null,rejectedRequests:0},timer=null,active=null,stopped=false;
 async function sample(){
  try{
   const m=await readSample();
   if(!m||!Number.isFinite(m.total)||m.total<=0||!Number.isFinite(m.available)||m.available<0||m.available>m.total)throw Error('memory_sample_unavailable');
   const reserve=Math.max(2*GiB,m.total*.20),critical=Math.max(GiB/2,m.total*.05);
   state={...state,level:m.available<critical?'critical':m.available<reserve?'high':'normal',totalBytes:m.total,availableBytes:m.available,reserveBytes:reserve,criticalBytes:critical,sampleError:false,checkedAt:clock()};
   if(state.level!=='normal'&&!control.snapshot().pausedRequested){try{await control.change('pause');state.pauseError=null;}catch{state.pauseError='background_pause_failed';}}
  }catch{state={...state,level:['high','critical'].includes(state.level)?state.level:'unknown',sampleError:true,checkedAt:clock()};}
 }
 function refresh(){if(stopped)return Promise.resolve();if(active)return active;active=sample().finally(()=>{active=null;});return active;}
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
  async drain(){if(active)await active;},
  async stop(){stopped=true;clearInterval(timer);if(active)await active;}
 };
}
