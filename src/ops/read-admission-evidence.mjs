const stages=new Set(['classification_failed','classifying','classified','queued','admitted','reading','complete']);
const phases=new Set(['open','stat','stream','processing','close','complete']);
const numeric=['classificationMs','admissionWaitMs','requestCpuMs','requestEventLoopActiveMs','requestEventLoopIdleMs','loopDelayMaxMs','loopDelayMeanMs','loopDelaySamples','loopWindowMs','loopResolutionMs','outstandingPhysicalReads','queueDepth','activeHolderCount','omittedActiveHolders','omittedQueuedHolders'];
const holderNumeric=['readId','ageMs','endedAgoMs','bytesRead','fileBytes','processCpuMs','eventLoopActiveMs','eventLoopIdleMs','openMs','statMs','streamMs','processingMs','closeMs'];
const nonnegative=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
export function readAdmissionEvidence(info){
 try{
  if(!stages.has(info?.phase))return undefined;
  const out={phase:info.phase};if(['regular','small'].includes(info.lane))out.lane=info.lane;
  for(const key of numeric)if(nonnegative(info[key]))out[key]=Math.min(info[key],Number.MAX_SAFE_INTEGER);
  if(typeof info.classificationPerformed==='boolean')out.classificationPerformed=info.classificationPerformed;
  for(const key of ['queuedHolders','activeHolders','lastHolders'])if(Array.isArray(info[key]))out[key]=info[key].slice(0,2).flatMap(holder=>{
   if(!['regular','small'].includes(holder?.lane))return[];
   const value={lane:holder.lane};if(phases.has(holder.phase))value.phase=holder.phase;
   for(const name of holderNumeric)if(nonnegative(holder[name]))value[name]=Math.min(holder[name],Number.MAX_SAFE_INTEGER);
   return[value];
  });
  return out;
 }catch{return undefined;}
}
