import {readFile} from 'node:fs/promises';
export const MEMORY_RECOVERY_ENABLED = true;
const GiB=1024**3;
const SAFE_APIS=new Set(['api::liveness','api::health','api::config-flags','api::background-control-get','api::background-control-set']);

// Candidate operational stall budgets, not a guarantee against allocation bursts.
const PRESSURE_BUDGET=Object.freeze({some:1,full:0.1});
export function parseMemoryPressure(text){
 const result={};
 for(const name of ['some','full']){
  const lines=text.split('\n').filter(line=>line.startsWith(name+' '));
  if(lines.length!==1)return null;
  const fields={};
  for(const token of lines[0].trim().split(/\s+/).slice(1)){
   const match=/^(avg10|avg60|avg300|total)=([0-9]+(?:\.[0-9]+)?)$/.exec(token);
   if(!match||Object.hasOwn(fields,match[1])||(match[1]==='total'&&!/^[0-9]+$/.test(match[2])))return null;
   fields[match[1]]=Number(match[2]);
   if(match[1]!=='total'&&(!Number.isFinite(fields[match[1]])||fields[match[1]]>100))return null;
  }
  result[name]={avg10:fields.avg10,avg60:fields.avg60,total:fields.total};
 }
 return validPressure(result)?result:null;
}
function validPressure(p){
 return ['some','full'].every(name=>p?.[name]&&['avg10','avg60'].every(key=>Number.isFinite(p[name][key])&&p[name][key]>=0&&p[name][key]<=100)&&Number.isSafeInteger(p[name].total)&&p[name].total>=0);
}
function pressureWindow(){
 let points=[];
 return (p,now,available,floor)=>{
  const last=points.at(-1);
  if(!validPressure(p)||!Number.isFinite(now)||(last&&(now<last.now||now-last.now>10000||['some','full'].some(name=>p[name].total<last[name])))){
   points=[];return null;
  }
  const point={now,some:p.some.total,full:p.full.total};
  const current=available>floor&&['some','full'].every(name=>p[name].avg10<=PRESSURE_BUDGET[name]&&p[name].avg60<=PRESSURE_BUDGET[name]);
  if(!current){points=[];return {quiet:false,ready:false};}
  if(last?.now===now){
   if(point.some!==last.some||point.full!==last.full){points=[];return null;}
  }else points.push(point);
  while(points.length>1&&points[1].now<=now-120000)points.shift();
  const first=points[0],elapsed=now-first.now;
  const quiet=elapsed===0||['some','full'].every(name=>(point[name]-first[name])/(elapsed*1000)*100<=PRESSURE_BUDGET[name]);
  if(!quiet){points=[];return {quiet:false,ready:false};}
  return {quiet:true,ready:elapsed>=120000};
 };
}

export async function readHostMemory(){
 if(process.platform!=='linux')return null;
 const text=await readFile('/proc/meminfo','utf8');
 const bytes=name=>Number(text.match(new RegExp('^'+name+':\\s+(\\d+)\\s+kB','m'))?.[1])*1024;
 let pressure=null;try{pressure=parseMemoryPressure(await readFile('/proc/pressure/memory','utf8'));}catch{}
 return{total:bytes('MemTotal'),available:bytes('MemAvailable'),pressure};
}

export function createMemoryPressureGuard({control,readSample=readHostMemory,schedule=true,clock=Date.now,monotonicClock=()=>performance.now()}={}){
 let state={automaticMemoryRecovery:MEMORY_RECOVERY_ENABLED,level:'unknown',totalBytes:null,availableBytes:null,reserveBytes:null,criticalBytes:null,checkedAt:null,rejectedRequests:0,recoveryStatus:'observing',stableSince:null},timer=null,active=null,pendingRecovery=null,pendingPause=null,stopped=false;
 let lastSampleAt=null,stableSince=null,sampleSequence=0;
 const observePressure=pressureWindow();
 async function readFresh(){
  const sequence=++sampleSequence,before=clock(),m=await readSample(),now=clock();
  if(sequence!==sampleSequence||!m||!Number.isFinite(m.total)||m.total<=0||!Number.isFinite(m.available)||m.available<0||m.available>m.total||!Number.isFinite(now)||now<before||now-before>10000)throw Error('memory_sample_unavailable');
  const reserve=Math.max(2*GiB,m.total*.18),critical=Math.max(GiB/2,m.total*.05),recoveryBytes=Math.max(3*GiB,m.total*.22);
  const pressureFloor=Math.max(3*GiB,critical+2*GiB),pressure=observePressure(m.pressure,monotonicClock(),m.available,pressureFloor);
  const oldRecovered=m.available>recoveryBytes;
  if(!oldRecovered)stableSince=null;
  const level=m.available<critical?'critical':m.available>=reserve||(pressure?.quiet===true&&pressure.ready)?'normal':'high';
  state={...state,level,stableSince,pressureFloorBytes:pressureFloor,pressureBudget:PRESSURE_BUDGET,pressureWindowReady:pressure?.ready??false,pressureFallback:pressure===null,totalBytes:m.total,availableBytes:m.available,reserveBytes:reserve,criticalBytes:critical,recoveryBytes,sampleError:false,checkedAt:now};
  return{now,recovered:oldRecovered,pressureRecovered:pressure?.quiet===true&&pressure.ready};
 }
 async function sample(){
  try{
   const {now,recovered,pressureRecovered}=await readFresh();
   if(lastSampleAt===null||now<lastSampleAt||now-lastSampleAt>10000||!recovered)stableSince=null;
   lastSampleAt=now;
   if(!recovered)stableSince=null;else if(stableSince===null)stableSince=now;
   state.stableSince=stableSince;
   if(state.level!=='normal'){
    state.recoveryStatus='pressure';
    if(!pendingPause)pendingPause=control.change('pause',{source:'memory'}).then(()=>{state.pauseError=null;},()=>{state.pauseError='background_pause_failed';}).finally(()=>{pendingPause=null;});
    return;
   }
   if(!MEMORY_RECOVERY_ENABLED){state.recoveryStatus='disabled';return;}
   if(pendingRecovery){state.recoveryStatus='recovering';return;}
   const c=control.snapshot();
   if(!c.holds?.includes('memory')){state.recoveryStatus='observing';return;}
   const memoryWithStorage=c.holds.length===2&&c.holds.includes('storage_error');
   const protectedMemoryRelease=c.holds.includes('storage_error')&&(c.holds.includes('manual')||c.holds.includes('deployment'));
   if(!memoryWithStorage&&!protectedMemoryRelease&&(c.holds.length!==1||c.status==='error')){state.recoveryStatus='held';return;}
   if(c.recovery.attempts>=c.recovery.maxAttempts){state.recoveryStatus='attempt_limit';return;}
   if(now<c.recovery.nextAttemptAt){state.recoveryStatus='backoff';return;}
   state.recoveryStatus='stabilizing';
   if(!pressureRecovered&&(stableSince===null||now-stableSince<120000))return;
   state.recoveryStatus='recovering';
   pendingRecovery=control.change('resume',{source:'memory',canResume:async()=>{
    let checked;
    try{checked=await readFresh();}catch{observePressure(null,0,0,0);stableSince=null;lastSampleAt=null;state={...state,level:['high','critical'].includes(state.level)?state.level:'unknown',sampleError:true,stableSince:null};return false;}
    if(!(checked.pressureRecovered||(stableSince!==null&&checked.now-stableSince>=120000&&checked.recovered))||checked.now<lastSampleAt||checked.now-lastSampleAt>10000||stopped){stableSince=null;state.stableSince=null;return false;}
    lastSampleAt=checked.now;return true;
   }}).then(()=>{
    state.recoveryStatus=['high','critical'].includes(state.level)?'pressure':control.snapshot().pausedRequested?'held':'recovered';
   },()=>{state.recoveryStatus='held';}).finally(()=>{pendingRecovery=null;stableSince=null;state.stableSince=null;});
  }catch{observePressure(null,0,0,0);stableSince=null;lastSampleAt=null;state={...state,level:['high','critical'].includes(state.level)?state.level:'unknown',sampleError:true,recoveryStatus:'sample_error',stableSince:null,checkedAt:clock()};}
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
