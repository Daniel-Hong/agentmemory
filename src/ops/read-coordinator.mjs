import {AsyncLocalStorage} from 'node:async_hooks';
const fail=code=>Object.assign(Error(code),{code});
export function createReadCoordinator({clock=Date.now}={}){
 const context=new AsyncLocalStorage(),queue=[],idle=new Set(),signals=new Map();
 let activeCritical=0,activeBulk=false,criticalBurst=0,scheduled=false;
 const stats={cancelled:0,expired:0,rejected:0,peakQueued:0};
 const abortReason=signal=>signal.reason??new DOMException('Aborted','AbortError');
 function notifyIdle(){if(!activeCritical&&!activeBulk&&!queue.length){for(const resolve of idle)resolve();idle.clear();}}
 function schedule(){if(!scheduled){scheduled=true;queueMicrotask(()=>{scheduled=false;pump();});}}
 function unsubscribe(item){
  if(item.timer)clearTimeout(item.timer);
  const entry=signals.get(item.signal);if(!entry)return;
  entry.items.delete(item);if(!entry.items.size){item.signal.removeEventListener('abort',entry.abort);signals.delete(item.signal);}
 }
 function rejectQueued(item,error){
  const at=queue.indexOf(item);if(at<0)return;queue.splice(at,1);unsubscribe(item);item.reject(error);schedule();notifyIdle();
 }
 function subscribe(item){
  if(!item.signal)return;
  let entry=signals.get(item.signal);
  if(!entry){entry={items:new Set(),abort(){for(const value of [...entry.items]){stats.cancelled++;rejectQueued(value,abortReason(item.signal));}}};signals.set(item.signal,entry);item.signal.addEventListener('abort',entry.abort,{once:true});}
  entry.items.add(item);
 }
 function release(token){
  if(--token.references)return;
  if(token.mode==='critical')activeCritical--;else activeBulk=false;
  schedule();notifyIdle();
 }
 function grant(item){
  queue.splice(queue.indexOf(item),1);unsubscribe(item);
  if(item.signal?.aborted){stats.cancelled++;item.reject(abortReason(item.signal));return;}
  if(item.deadline!==undefined&&clock()>=item.deadline){stats.expired++;item.reject(fail('STATE_READ_COORDINATION_TIMEOUT'));return;}
  const token={mode:item.mode,active:true,references:1};
  if(item.mode==='critical'){activeCritical++;criticalBurst=Math.min(5,criticalBurst+1);}else{activeBulk=true;criticalBurst=0;}
  context.run(token,async()=>{
   try{
    if(item.signal?.aborted)throw abortReason(item.signal);
    if(item.deadline!==undefined&&clock()>=item.deadline)throw fail('STATE_READ_COORDINATION_TIMEOUT');
    const result=await item.work();if(item.signal?.aborted)throw abortReason(item.signal);item.resolve(result);
   }catch(error){item.reject(error);}finally{token.active=false;release(token);}
  });
 }
 function pump(){
  while(queue.length&&!activeBulk){
   const bulk=queue.findIndex(item=>item.mode==='bulk'),critical=queue.findIndex(item=>item.mode==='critical');
   if(activeCritical){if(critical<0||(bulk>=0&&criticalBurst>=5))break;grant(queue[critical]);continue;}
   const at=bulk>=0&&(critical<0||criticalBurst>=5)?bulk:critical>=0?critical:bulk;
   grant(queue[at]);
  }
  notifyIdle();
 }
 function run(mode,work,{signal,deadline}={}){
  if(!['critical','bulk'].includes(mode)||typeof work!=='function'||(deadline!==undefined&&!Number.isSafeInteger(deadline)))return Promise.reject(fail('STATE_READ_COORDINATION_INVALID'));
  if(context.getStore()?.active)return Promise.reject(fail('STATE_READ_COORDINATION_REENTRANT'));
  if(signal?.aborted)return Promise.reject(abortReason(signal));
  if(deadline!==undefined&&clock()>=deadline)return Promise.reject(fail('STATE_READ_COORDINATION_TIMEOUT'));
  if(queue.length>=64){stats.rejected++;return Promise.reject(fail('STATE_READ_COORDINATION_LIMIT'));}
  return new Promise((resolve,reject)=>{
   const item={mode,work,signal,deadline,resolve,reject};queue.push(item);stats.peakQueued=Math.max(stats.peakQueued,queue.length);subscribe(item);
   if(deadline!==undefined)item.timer=setTimeout(()=>{stats.expired++;rejectQueued(item,fail('STATE_READ_COORDINATION_TIMEOUT'));},Math.max(0,deadline-clock()));
   schedule();
  });
 }
 return {run,
  trackPhysical(work){
   const token=context.getStore();if(!token?.active||token.mode!=='critical')return Promise.reject(fail('STATE_READ_COORDINATION_REENTRANT'));
   token.references++;return Promise.resolve().then(work).finally(()=>release(token));
  },
  drain(){if(context.getStore()?.active)return Promise.reject(fail('STATE_READ_COORDINATION_REENTRANT'));if(!activeCritical&&!activeBulk&&!queue.length)return Promise.resolve();return new Promise(resolve=>idle.add(resolve));},
  snapshot:()=>({activeCritical,activeBulk,queued:queue.length,queuedCritical:queue.filter(v=>v.mode==='critical').length,queuedBulk:queue.filter(v=>v.mode==='bulk').length,criticalBurst,signalSubscriptions:signals.size,...stats,maxQueued:64,maxCriticalBurst:5}),
 };
}
