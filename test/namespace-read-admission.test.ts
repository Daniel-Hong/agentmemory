import {expect,it} from 'vitest';
import {createSharedNamespaceReader} from '../src/ops/shared-namespace-reader.mjs';
const turn=async()=>{for(let n=0;n<12;n++)await Promise.resolve();};
function fixture(options:any={}){
 const calls:any[]=[];const reader=createSharedNamespaceReader({maxParallelReads:1,maxQueuedReads:4,...options,read:(_path:string,opts:any)=>new Promise((resolve,reject)=>{
  const abort=()=>reject(opts.signal.reason);opts.signal?.addEventListener('abort',abort,{once:true});
  calls.push({opts,finish(){opts.signal?.removeEventListener('abort',abort);opts.onRead?.({bytesRead:10,complete:true});resolve({values:new Map([...opts.keys??[]].map(k=>[k,1])),signature:'fixture'});},fail(error:any){reject(error);}});
 })}as any);
 const request=(key:string,extra:any={})=>reader.read('/fixture',{keys:new Set([key]),...extra});return{reader,calls,request};
}
it('coalesces late disjoint keys in the next queued scan without delaying the first scan',async()=>{
 const h=fixture();const first=h.request('a');await turn();expect(h.calls).toHaveLength(1);
 const next=h.request('b');await turn();const third=h.request('c');await turn();expect(h.calls).toHaveLength(1);
 h.calls[0].finish();await first;await turn();expect(h.calls).toHaveLength(2);expect([...h.calls[1].opts.keys]).toEqual(['b','c']);h.calls[1].finish();await Promise.all([next,third]);await h.reader.drain();expect(h.reader.snapshot()).toMatchObject({startedReads:2,activeReads:0,sharedRequests:1});
});
it('puts direct callbacks and max-job fallbacks through the same physical limit',async()=>{
 const h=fixture({maxActiveReads:1});const first=h.request('a');await turn();const fallback=h.request('b');const callback=h.request('c',{onEntry:()=>{}});await turn();expect(h.calls).toHaveLength(1);
 h.calls[0].finish();await first;await turn();expect(h.calls).toHaveLength(2);h.calls[1].finish();await fallback;await turn();expect(h.calls).toHaveLength(3);h.calls[2].finish();await callback;await h.reader.drain();expect(h.reader.snapshot()).toMatchObject({directFallbacks:2,activeReads:0});
});
it('cancels a queued owner without cancelling its surviving follower or starting an obsolete scan',async()=>{
 const h=fixture(),c=new AbortController();const first=h.request('a');await turn();const owner=h.request('b',{signal:c.signal}),rejected=expect(owner).rejects.toMatchObject({name:'AbortError'});const survivor=h.request('b');await turn();c.abort();await rejected;h.calls[0].finish();await first;await turn();expect(h.calls).toHaveLength(2);h.calls[1].finish();await survivor;await h.reader.drain();
});
it('removes all cancelled queued work and preserves the next request',async()=>{
 const h=fixture(),c=new AbortController();const first=h.request('a');await turn();const queued=h.request('b',{signal:c.signal}),rejected=expect(queued).rejects.toMatchObject({name:'AbortError'});await turn();c.abort();await rejected;const next=h.request('c');h.calls[0].finish();await first;await turn();expect(h.calls).toHaveLength(2);expect([...h.calls[1].opts.keys]).toEqual(['c']);h.calls[1].finish();await next;await h.reader.drain();expect(h.reader.snapshot()).toMatchObject({sharedJobs:0,activeWaiters:0});
});
it('bounds queued admissions without starting excess reads or certifying rejected work',async()=>{
 const h=fixture({maxQueuedReads:1}),c=new AbortController();const first=h.request('a',{onEntry:()=>{}});await turn();const queued=h.request('b',{onEntry:()=>{},signal:c.signal});await turn();const excess=h.request('c',{onEntry:()=>{}});await expect(excess).rejects.toMatchObject({code:'state_namespace_admission_limit'});expect(h.calls).toHaveLength(1);const rejected=expect(queued).rejects.toMatchObject({name:'AbortError'});c.abort();await rejected;h.calls[0].finish();await first;await h.reader.drain();expect(h.reader.snapshot().admission).toMatchObject({active:0,queued:0,rejected:1});
});
it('does not let projection overflow fallback escape the admission limit or deadlock drain',async()=>{
 const h=fixture();const one=h.request('a'),two=h.request('b');await turn();h.calls[0].fail(Object.assign(Error('overflow'),{code:'state_namespace_projection_limit'}));await turn();expect(h.calls).toHaveLength(2);h.calls[1].finish();await turn();expect(h.calls).toHaveLength(3);h.calls[2].finish();await Promise.all([one,two]);await h.reader.drain();expect(h.reader.snapshot()).toMatchObject({projectionFallbacks:2,activeReads:0});
});
it('keeps a slot until the physical reader settles after all callers cancel',async()=>{
 let release!:()=>void;const calls:any[]=[];const reader=createSharedNamespaceReader({maxParallelReads:1,read:(_p:string,options:any)=>new Promise(resolve=>{calls.push(options);release=()=>resolve({values:new Map(),signature:'fixture'});})}as any);const c=new AbortController(),first=reader.read('/a',{keys:new Set(['a']),signal:c.signal}),rejected=expect(first).rejects.toMatchObject({name:'AbortError'});await turn();const next=reader.read('/b',{keys:new Set(['b'])});c.abort();await rejected;await turn();expect(calls).toHaveLength(1);release();await turn();expect(calls).toHaveLength(2);release();await next;await reader.drain();expect(reader.snapshot().admission).toMatchObject({active:0,queued:0});
});
it('rejects an admitted direct request cancelled before its physical work microtask',async()=>{
 const h=fixture(),c=new AbortController();const result=h.request('a',{onEntry:()=>{},signal:c.signal}).then(()=> 'resolved',e=>e.name);c.abort();await turn();for(const call of h.calls)call.finish();expect(await result).toBe('AbortError');expect(h.calls).toHaveLength(0);await h.reader.drain();
});
