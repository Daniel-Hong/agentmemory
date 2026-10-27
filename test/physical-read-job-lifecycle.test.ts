import {afterEach,expect,it,vi} from 'vitest';
import {createSharedNamespaceReader} from '../src/ops/shared-namespace-reader.mjs';
import {createReadCoordinator} from '../src/ops/read-coordinator.mjs';
const turn=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const deferred=()=>{let resolve!:(value?:any)=>void;const promise=new Promise<any>(r=>resolve=r);return{promise,resolve};};
afterEach(()=>vi.useRealTimers());
it('removes a physical job from coordinator admission when its last queued waiter cancels',async()=>{
 const coordinator=createReadCoordinator(),held=deferred(),read=vi.fn();
 const bulk=coordinator.run('bulk',()=>held.promise);await turn();
 const reader=createSharedNamespaceReader({read,trackRead:(work:any,options:any)=>coordinator.run('critical',work,options)});
 const controller=new AbortController(),request=reader.read('/synthetic',{keys:new Set(['a']),signal:controller.signal});const rejected=expect(request).rejects.toMatchObject({name:'AbortError'});await turn();
 try{expect(coordinator.snapshot().queuedCritical).toBe(1);controller.abort();await rejected;await turn();expect(coordinator.snapshot().queuedCritical).toBe(0);expect(read).not.toHaveBeenCalled();}
 finally{controller.abort();held.resolve();await bulk;await reader.drain();await coordinator.drain();}
});
it('keeps a fixed shared job lifetime across joins and retains its lease through physical cleanup',async()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});const coordinator=createReadCoordinator(),closed=deferred();let aborted=false,bulkRan=false;
 const read=vi.fn((_path:any,{signal}:any)=>new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>{aborted=true;void closed.promise.then(()=>reject(signal.reason));},{once:true});}));
 const reader=createSharedNamespaceReader({read,maxJobMs:50,trackRead:(work:any,options:any)=>coordinator.run('critical',work,options)});
 const first=new AbortController(),second=new AbortController();const a=reader.read('/synthetic',{keys:new Set(['a']),signal:first.signal});const ar=expect(a).rejects.toMatchObject({name:'AbortError'});await turn();
 await vi.advanceTimersByTimeAsync(10);const b=reader.read('/synthetic',{keys:new Set(['a']),signal:second.signal});const br=b.then(()=>null,(e:any)=>e);await turn();first.abort();await ar;expect(aborted).toBe(false);
 const bulk=coordinator.run('bulk',async()=>{bulkRan=true;});
 try{await vi.advanceTimersByTimeAsync(40);expect(aborted).toBe(true);expect(bulkRan).toBe(false);expect(coordinator.snapshot().activeCritical).toBe(1);closed.resolve();expect(await br).toMatchObject({code:'state_namespace_job_timeout'});await bulk;await reader.drain();await coordinator.drain();expect(bulkRan).toBe(true);expect(vi.getTimerCount()).toBe(0);}
 finally{second.abort();closed.resolve();await Promise.allSettled([a,b,bulk]);await reader.drain();await coordinator.drain();}
});
it('allows a surviving waiter to complete after another caller expires and clears the job timer',async()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});const held=deferred();let signal:any;
 const reader=createSharedNamespaceReader({maxJobMs:100,read:async(_path:any,options:any)=>{signal=options.signal;await held.promise;return{values:new Map([['a',1]]),signature:'synthetic'};}});
 const controller=new AbortController();const first=reader.read('/synthetic',{keys:new Set(['a']),signal:controller.signal});const rejected=expect(first).rejects.toMatchObject({name:'AbortError'});await turn();await vi.advanceTimersByTimeAsync(10);
 const second=reader.read('/synthetic',{keys:new Set(['a'])});controller.abort();await rejected;expect(signal.aborted).toBe(false);held.resolve();expect((await second).values.get('a')).toBe(1);await reader.drain();expect(vi.getTimerCount()).toBe(0);
});
it('rejects invalid finite job lifetime limits instead of making an immortal or immediate job',()=>{
 for(const maxJobMs of [0,-1,NaN,1.5])expect(()=>createSharedNamespaceReader({maxJobMs})).toThrow('state_namespace_admission_options');
});
it('counts new jobs for bulk fairness without charging a compatible join another admission',async()=>{
 const coordinator=createReadCoordinator(),calls:any[]=[],events:string[]=[];
 const reader=createSharedNamespaceReader({maxParallelReads:1,trackRead:(work:any,options:any)=>coordinator.run('critical',work,options),read:(path:string)=>new Promise(resolve=>{events.push(path);calls.push({path,finish:()=>resolve({values:new Map([['a',1]]),signature:'synthetic'})});})});
 const first=Array.from({length:5},(_,i)=>reader.read('/file'+i,{keys:new Set(['a'])}));await turn();
 const bulk=coordinator.run('bulk',async()=>{events.push('bulk');}),extra=reader.read('/file5',{keys:new Set(['a'])}),joined=reader.read('/file0',{keys:new Set(['a'])});
 try{
  await turn();expect(coordinator.snapshot()).toMatchObject({activeCritical:5,queuedCritical:1,queuedBulk:1});expect(reader.snapshot().sharedRequests).toBe(1);
  for(let i=0;i<5;i++){await vi.waitFor(()=>expect(calls.length).toBeGreaterThan(i));calls[i].finish();await turn();}
  await Promise.all([...first,joined,bulk]);await vi.waitFor(()=>expect(calls).toHaveLength(6));expect(events.indexOf('bulk')).toBeLessThan(events.indexOf('/file5'));calls[5].finish();await extra;
 }finally{for(let i=0;i<20;i++){for(const call of calls)call.finish();await turn();}await Promise.allSettled([...first,bulk,extra,joined]);await reader.drain();await coordinator.drain();}
 expect(coordinator.snapshot()).toMatchObject({queued:0,activeCritical:0,activeBulk:false});expect(reader.snapshot()).toMatchObject({activeReads:0,activeWaiters:0,sharedJobs:0});
});
