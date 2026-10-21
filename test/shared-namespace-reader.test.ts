import {expect,it,vi} from 'vitest';
import {createSharedNamespaceReader} from '../src/ops/shared-namespace-reader.mjs';
function harness(options:any={}){
 const calls:any[]=[];
 const read=vi.fn((path:string,opts:any)=>new Promise((resolve,reject)=>{
  const abort=()=>reject(opts.signal.reason);opts.signal?.addEventListener('abort',abort,{once:true});
  calls.push({path,opts,fail:reject,finish(){opts.signal?.removeEventListener('abort',abort);opts.onRead?.({bytesRead:100,complete:true});resolve({values:new Map([...opts.keys].map((key:string)=>[key,1])),signature:'synthetic'});}});
 }));
 const reader=createSharedNamespaceReader({read,...options});
 const request=(keys=['a'],controller=new AbortController())=>reader.read('/synthetic',{keys:new Set(keys),signal:controller.signal});
 return {reader,calls,request};
}
const turn=async()=>{await Promise.resolve();await Promise.resolve();};
it('unions pending keys, permits only subsets after start, and never caches a completed scan',async()=>{
 const {reader,calls,request}=harness();const a=request(['a']),b=request(['b']);await turn();
 expect(calls).toHaveLength(1);expect([...calls[0].opts.keys]).toEqual(['a','b']);
 const c=request(['b']),d=request(['c']);await turn();expect(calls).toHaveLength(2);
 calls[0].finish();calls[1].finish();expect(await Promise.all([a,b,c,d])).toHaveLength(4);
 const again=request();await turn();expect(calls).toHaveLength(3);calls[2].finish();await again;
 expect(reader.snapshot()).toMatchObject({sharedRequests:2,startedReads:3,scanBytes:300,activeReads:0,activeWaiters:0,sharedJobs:0});
});
it('isolates owner abort and counts the physical scan even after its owner has left',async()=>{
 const {reader,calls,request}=harness();const controller=new AbortController();
 const a=request(['a'],controller);const rejected=expect(a).rejects.toMatchObject({name:'AbortError'});const b=request(['a']);await turn();
 controller.abort();await rejected;expect(calls[0].opts.signal.aborted).toBe(false);
 calls[0].finish();expect((await b).values.get('a')).toBe(1);
 expect(reader.snapshot()).toMatchObject({startedReads:1,scanBytes:100,activeReads:0,activeWaiters:0});
});
it('isolates follower abort and aborts the actual scan only after all waiters leave',async()=>{
 const {reader,calls,request}=harness();const x=new AbortController(),y=new AbortController();
 const a=request(['a'],x),b=request(['a'],y);const ar=expect(a).rejects.toMatchObject({name:'AbortError'}),br=expect(b).rejects.toMatchObject({name:'AbortError'});await turn();
 y.abort();await br;expect(calls[0].opts.signal.aborted).toBe(false);x.abort();await ar;await turn();
 expect(calls[0].opts.signal.aborted).toBe(true);
 const next=request();await turn();expect(calls).toHaveLength(2);calls[1].finish();await next;
 expect(reader.snapshot()).toMatchObject({sharedJobs:0,activeReads:0,activeWaiters:0});
});
it('does not start a scan if every pending waiter aborts',async()=>{
 const {reader,calls,request}=harness(),c=new AbortController();const result=request(['a'],c);const reject=expect(result).rejects.toMatchObject({name:'AbortError'});c.abort();await reject;await turn();
 expect(calls).toHaveLength(0);expect(reader.snapshot().sharedJobs).toBe(0);
});
it.each([{maxKeys:1},{maxWaiters:1},{maxActiveReads:1}])('bounds sharing and falls back without denying valid requests: %j',async limits=>{
 const {reader,calls,request}=harness(limits);const a=request(['a']);if(limits.maxActiveReads)await turn();const b=request(['b']);await turn();
 expect(calls).toHaveLength(2);for(const call of calls)call.finish();await Promise.all([a,b]);
 expect(reader.snapshot().peakSharedJobs).toBeLessThanOrEqual(limits.maxActiveReads??8);
 expect(reader.snapshot()).toMatchObject({activeReads:0,activeWaiters:0,sharedJobs:0});
});
it('retries each consumer through the baseline on shared projection overflow',async()=>{
 const {reader,calls,request}=harness({maxSelectedBytes:4});const a=request(['a']),b=request(['b']);await turn();
 expect(calls[0].opts.maxSelectedBytes).toBe(4);calls[0].fail(Object.assign(Error('overflow'),{code:'state_namespace_projection_limit'}));await turn();await turn();
 expect(calls).toHaveLength(3);expect(calls[1].opts.maxSelectedBytes).toBeUndefined();expect(calls[2].opts.maxSelectedBytes).toBeUndefined();calls[1].finish();calls[2].finish();await Promise.all([a,b]);
 expect(reader.snapshot()).toMatchObject({projectionFallbacks:2,activeReads:0,activeWaiters:0,sharedJobs:0});
});
it('propagates actual read failures without retaining a reusable result',async()=>{
 const {calls,request,reader}=harness();const a=request(),b=request();const ar=expect(a).rejects.toMatchObject({code:'EIO'}),br=expect(b).rejects.toMatchObject({code:'EIO'});await turn();calls[0].fail(Object.assign(Error('io'),{code:'EIO'}));await Promise.all([ar,br]);
 const next=request();await turn();calls[1].finish();await next;expect(reader.snapshot().sharedJobs).toBe(0);
});
it('removes abort listeners on success, failure and cancellation',async()=>{
 for(const mode of ['success','error','abort']){
  const {request,calls}=harness(),c=new AbortController();const remove=vi.spyOn(c.signal,'removeEventListener');const result=request(['a'],c);const settled=result.catch(()=>null);await turn();
  if(mode==='success')calls[0].finish();else if(mode==='error')calls[0].fail(Error('test'));else c.abort();await settled;
  expect(remove).toHaveBeenCalledWith('abort',expect.any(Function));
 }
});
it('does not join incompatible scanner options or callers with entry callbacks',async()=>{
 const {reader,calls}=harness();
 const a=reader.read('/synthetic',{keys:new Set(['a']),checkIntervalBytes:1});
 const b=reader.read('/synthetic',{keys:new Set(['a']),checkIntervalBytes:2});
 const c=reader.read('/synthetic',{keys:new Set(['a']),onEntry:()=>{}});await turn();
 expect(calls).toHaveLength(3);for(const call of calls)call.finish();await Promise.all([a,b,c]);
});
it('stops admitting followers when physical read metadata reports completion',async()=>{
 const {calls,reader,request}=harness();const a=request();await turn();
 calls[0].opts.onRead({bytesRead:0,complete:true});
 const b=request();await turn();expect(calls).toHaveLength(2);calls[0].finish();calls[1].finish();await Promise.all([a,b]);
 expect(reader.snapshot().sharedRequests).toBe(0);
});
it('isolates synchronous and asynchronous measurement callback failures',async()=>{
 const {calls,reader}=harness();
 const a=reader.read('/synthetic',{keys:new Set(['a']),onRead:async()=>{throw Error('synthetic observer');}});
 const b=reader.read('/synthetic',{keys:new Set(['a']),onShared:()=>{throw Error('synthetic observer');}});
 await turn();calls[0].finish();await Promise.all([a,b]);await new Promise(r=>setImmediate(r));
 expect(reader.snapshot().activeReads).toBe(0);
});
it('drains physical readers after an aborted request, including delayed close',async()=>{
 let finish!:()=>void;
 const reader=createSharedNamespaceReader({read:()=>new Promise(resolve=>{finish=()=>resolve({values:new Map(),signature:'synthetic'});})});
 const c=new AbortController(),request=reader.read('/synthetic',{keys:new Set(['a']),signal:c.signal});
 const rejected=expect(request).rejects.toMatchObject({name:'AbortError'});await turn();c.abort();await rejected;
 let drained=false;const draining=reader.drain().then(()=>{drained=true;});await turn();expect(drained).toBe(false);
 finish();await draining;expect(reader.snapshot()).toMatchObject({activeReads:0,sharedJobs:0});
});
it('drains baseline fallback reads launched after a shared projection overflow',async()=>{
 const {reader,calls,request}=harness();const a=request(),b=request();await turn();
 let drained=false;const draining=reader.drain().then(()=>{drained=true;});
 calls[0].fail(Object.assign(Error('overflow'),{code:'state_namespace_projection_limit'}));
 for(let i=0;i<6;i++)await turn();
 expect(calls).toHaveLength(3);expect(drained).toBe(false);
 calls[1].finish();calls[2].finish();await Promise.all([a,b,draining]);
 expect(reader.snapshot()).toMatchObject({activeReads:0,activeWaiters:0,sharedJobs:0});
});

it('keeps a started singleton private so a late subset cannot bypass the shared budget',async()=>{
 const {reader,calls,request}=harness();const a=request();await turn();
 const b=request();await turn();expect(calls).toHaveLength(2);
 expect(calls.every(call=>call.opts.maxSelectedBytes===undefined)).toBe(true);
 for(const call of calls)call.finish();await Promise.all([a,b]);
 expect(reader.snapshot()).toMatchObject({sharedRequests:0,projectionFallbacks:0,activeReads:0,activeWaiters:0});
});
it('selects only the remaining pending waiter keys when another waiter cancels before start',async()=>{
 const {reader,calls,request}=harness(),controller=new AbortController();
 const cancelled=request(['cancelled-large'],controller),rejected=expect(cancelled).rejects.toMatchObject({name:'AbortError'});
 const surviving=request(['small']);controller.abort();await rejected;await turn();
 expect([...calls[0].opts.keys]).toEqual(['small']);
 expect(calls[0].opts.maxSelectedBytes).toBeUndefined();calls[0].finish();
 expect([...(await surviving).values.keys()]).toEqual(['small']);
 expect(reader.snapshot()).toMatchObject({activeReads:0,activeWaiters:0,sharedJobs:0});
});
it('drops a cancelled follower key from a surviving pending owner projection',async()=>{
 const {calls,request}=harness(),controller=new AbortController();
 const surviving=request(['small']),cancelled=request(['cancelled-large'],controller);
 const rejected=expect(cancelled).rejects.toMatchObject({name:'AbortError'});controller.abort();await rejected;await turn();
 expect([...calls[0].opts.keys]).toEqual(['small']);calls[0].finish();
 expect([...(await surviving).values.keys()]).toEqual(['small']);
});
