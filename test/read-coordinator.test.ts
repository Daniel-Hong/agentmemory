import{expect,it}from'vitest';
const turn=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
async function fixture(options:any={}){const m=await import('../src/ops/read-coordinator.mjs').catch(()=>({createReadCoordinator:undefined}));expect(m.createReadCoordinator).toBeTypeOf('function');return m.createReadCoordinator(options);}
const deferred=()=>{let resolve:any;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
it('atomically prioritizes simultaneous critical work without overlapping bulk and allows critical siblings',async()=>{
 const g=await fixture(),hold=deferred(),order:string[]=[];const bulk=g.run('bulk',async()=>{order.push('bulk');});const a=g.run('critical',async()=>{order.push('a');await hold.promise;});const b=g.run('critical',async()=>{order.push('b');await hold.promise;});await turn();expect(order).toEqual(['a','b']);hold.resolve();await Promise.all([a,b,bulk]);expect(order).toEqual(['a','b','bulk']);await g.drain();
});
it('removes cancelled queued work atomically and never invokes it',async()=>{
 const g=await fixture(),hold=deferred();const bulk=g.run('bulk',()=>hold.promise);await turn();let called=false;const c=new AbortController(),queued=g.run('critical',async()=>{called=true;},{signal:c.signal});const rejected=expect(queued).rejects.toMatchObject({name:'AbortError'});c.abort();await rejected;hold.resolve();await bulk;await g.drain();expect(called).toBe(false);expect(g.snapshot()).toMatchObject({queued:0,activeCritical:0,activeBulk:false});
});
it('checks expiry again at grant and before invocation instead of starting a fresh budget',async()=>{
 let clock=0;const g=await fixture({clock:()=>clock}),hold=deferred();const bulk=g.run('bulk',()=>hold.promise);await turn();let called=false;const request=g.run('critical',async()=>{called=true;},{deadline:10});const rejected=expect(request).rejects.toMatchObject({code:'STATE_READ_COORDINATION_TIMEOUT'});clock=10;hold.resolve();await bulk;await rejected;await g.drain();expect(called).toBe(false);
});
it('closes new critical admission after five grants while bulk waits and then gives both classes progress',async()=>{
 const g=await fixture(),hold=deferred(),order:string[]=[];const initial=Array.from({length:5},(_,i)=>g.run('critical',async()=>{order.push('c'+i);await hold.promise;}));await turn();const bulk=g.run('bulk',async()=>{order.push('bulk');});const extra=g.run('critical',async()=>{order.push('extra');});await turn();expect(order).not.toContain('extra');hold.resolve();await Promise.all([...initial,bulk,extra]);expect(order.indexOf('bulk')).toBeLessThan(order.indexOf('extra'));await g.drain();
});
it('keeps exclusion for only the originating physical tail after the caller fails',async()=>{
 const g=await fixture(),hold=deferred();let tail:any,bulkRan=false;
 await expect(g.run('critical',async()=>{tail=g.trackPhysical(()=>hold.promise);throw Error('synthetic');})).rejects.toThrow('synthetic');const bulk=g.run('bulk',async()=>{bulkRan=true;});await turn();expect(bulkRan).toBe(false);expect(g.snapshot().activeCritical).toBe(1);hold.resolve();await tail;await bulk;await g.drain();expect(bulkRan).toBe(true);
});
it('rejects true nested acquisitions rather than deadlocking and releases throws exactly once',async()=>{
 const g=await fixture();await g.run('critical',async()=>{await expect(g.run('bulk',async()=>{})).rejects.toMatchObject({code:'STATE_READ_COORDINATION_REENTRANT'});});
 await expect(g.run('bulk',()=>{throw Error('sync');})).rejects.toThrow('sync');await expect(g.run('critical',async()=>{throw Error('async');})).rejects.toThrow('async');expect(await g.run('bulk',()=>42)).toBe(42);await g.drain();expect(g.snapshot()).toMatchObject({activeCritical:0,activeBulk:false,queued:0});
});
it('does not release running work when its signal aborts before its callback settles',async()=>{
 const g=await fixture(),hold=deferred(),c=new AbortController();let bulkRan=false;const active=g.run('critical',()=>hold.promise,{signal:c.signal});const rejected=expect(active).rejects.toMatchObject({name:'AbortError'});await turn();const bulk=g.run('bulk',async()=>{bulkRan=true;});c.abort();await turn();expect(bulkRan).toBe(false);hold.resolve();await rejected;await bulk;await g.drain();
});
it('bounds pending admissions at64 and clears timers and listeners after cancellation',async()=>{
 const g=await fixture(),hold=deferred();const bulk=g.run('bulk',()=>hold.promise);await turn();const c=new AbortController(),outcomes=Array.from({length:65},()=>g.run('critical',async()=>{}, {signal:c.signal}).then(()=>null,(e:any)=>e.code??e.name));await turn();expect(g.snapshot().queued).toBe(64);c.abort();const result=await Promise.all(outcomes);expect(result.filter(v=>v==='STATE_READ_COORDINATION_LIMIT')).toHaveLength(1);hold.resolve();await bulk;await g.drain();expect(g.snapshot().queued).toBe(0);
});
