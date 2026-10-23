import {performance} from 'node:perf_hooks';
export const READER_PHASES=['queued','open','stat','stream','processing','close','complete'];
const TIMINGS=['openMs','statMs','streamMs','processingMs','closeMs'];
const safe=work=>{try{return work();}catch{return undefined;}};
const nonnegative=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
export function createReadProgress(observer){
 if(typeof observer!=='function')return()=>{};
 let failurePhase;let phase='open',since=safe(()=>performance.now()),bytesRead=0;
 const timings=Object.fromEntries(TIMINGS.map(k=>[k,0]));
 return(next,info={})=>safe(()=>{
  const now=performance.now();if(!nonnegative(now)||!nonnegative(since))return;
  if(phase!=='complete')timings[phase+'Ms']+=Math.max(0,now-since);
  if(info.failed===true)failurePhase=phase;
  phase=next;since=now;if(nonnegative(info.bytesRead))bytesRead=info.bytesRead;
  const result=observer({readerPhase:phase,readerPhaseSince:since,readerTimings:{...timings},bytesRead,...(failurePhase?{readerFailurePhase:failurePhase}:{}),...(typeof info.complete==='boolean'?{complete:info.complete}:{})});
  if(result&&typeof result.then==='function')Promise.resolve(result).catch(()=>{});
 });
}
export function readerEvidence(info,now){
 return safe(()=>{
  if(now===undefined)now=performance.now();
  if(!READER_PHASES.includes(info?.readerPhase))return undefined;
  const result={readerPhase:info.readerPhase,readerTimings:{}};
  if(READER_PHASES.includes(info.readerFailurePhase))result.readerFailurePhase=info.readerFailurePhase;
  for(const k of TIMINGS)if(nonnegative(info.readerTimings?.[k]))result.readerTimings[k]=Math.min(info.readerTimings[k],Number.MAX_SAFE_INTEGER);
  if(nonnegative(info.readerPhaseSince)&&nonnegative(now)&&info.readerPhase!=='complete'&&info.readerPhase!=='queued'){
   const k=info.readerPhase+'Ms';result.readerTimings[k]=(result.readerTimings[k]??0)+Math.max(0,now-info.readerPhaseSince);
  }
  for(const k of ['bytesRead','processCpuMs','eventLoopActiveMs','eventLoopIdleMs'])if(nonnegative(info[k]))result[k]=Math.min(info[k],Number.MAX_SAFE_INTEGER);
  if(typeof info.complete==='boolean')result.complete=info.complete;
  return result;
 });
}
export function validReaderEvidence(value){
 return safe(()=>Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&READER_PHASES.includes(value.readerPhase)&&
  Object.keys(value).every(k=>['readerPhase','readerFailurePhase','readerTimings','bytesRead','processCpuMs','eventLoopActiveMs','eventLoopIdleMs','complete'].includes(k))&&
  (value.readerFailurePhase===undefined||READER_PHASES.includes(value.readerFailurePhase))&&value.readerTimings&&typeof value.readerTimings==='object'&&!Array.isArray(value.readerTimings)&&Object.entries(value.readerTimings).every(([k,v])=>TIMINGS.includes(k)&&nonnegative(v))&&
  ['bytesRead','processCpuMs','eventLoopActiveMs','eventLoopIdleMs'].every(k=>value[k]===undefined||nonnegative(value[k]))&&(value.complete===undefined||typeof value.complete==='boolean')))||false;
}
