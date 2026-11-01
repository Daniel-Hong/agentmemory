import {afterEach,expect,it,vi} from 'vitest';
import {AsyncLocalStorage} from 'node:async_hooks';
afterEach(()=>vi.restoreAllMocks());
const tick=()=>new Promise(r=>setTimeout(r,0));
const deferred=()=>{let resolve!:()=>void;return {promise:new Promise<void>(r=>resolve=r),resolve:()=>resolve()};};
async function gate(){return import('../src/state/recovery-write-gate.js');}
it('lets normal writes overlap but excludes them during recovery finalization',async()=>{
 const g=(await gate()).createRecoveryWriteGate(),a=deferred(),b=deferred(),events:string[]=[];
 const one=g.read(async()=>{events.push('one');await a.promise;});const two=g.read(async()=>{events.push('two');await a.promise;});
 const recovery=g.exclusive(async()=>{events.push('recovery');await b.promise;});await tick();expect(events).toEqual(['one','two']);a.resolve();await Promise.all([one,two]);await tick();
 const later=g.read(async()=>{events.push('later');});await tick();expect(events).toEqual(['one','two','recovery']);b.resolve();await Promise.all([recovery,later]);expect(events.at(-1)).toBe('later');
});
it('permits internal recovery writes without granting escaped children a stale bypass',async()=>{
 const g=(await gate()).createRecoveryWriteGate(),release=deferred(),child=deferred(),events:string[]=[];let escaped!:Promise<unknown>;
 await g.exclusive(async()=>{await g.read(async()=>events.push('internal'));escaped=child.promise.then(()=>g.read(async()=>events.push('escaped')));});
 const hold=g.exclusive(async()=>{events.push('held');await release.promise;});await tick();child.resolve();await tick();expect(events).toEqual(['internal','held']);release.resolve();await Promise.all([hold,escaped]);expect(events.at(-1)).toBe('escaped');
});
it('coordinates selected records without blocking unrelated writes or leaking entries',async()=>{
 const {createRecordRecoveryGate}=await import('../src/state/recovery-write-gate.js');
 const g=createRecordRecoveryGate(),hold=deferred(),events:string[]=[];
 const keys=[{scope:'fixture',key:'selected'}];
 const recovery=g.exclusive(keys,async()=>{await g.read('fixture','selected',async()=>events.push('internal'));await hold.promise;});
 await tick();const same=g.read('fixture','selected',async()=>events.push('same'));
 await g.read('fixture','unrelated',async()=>events.push('unrelated'));expect(events).toEqual(['internal','unrelated']);
 hold.resolve();await Promise.all([same,recovery]);expect(events.at(-1)).toBe('same');expect(g.size()).toBe(0);
});
it('refuses acquiring an unselected record from a recovery transaction',async()=>{
 const {createRecordRecoveryGate}=await import('../src/state/recovery-write-gate.js');const g=createRecordRecoveryGate();
 await g.exclusive([{scope:'fixture',key:'selected'}],async()=>{
  await expect(g.read('fixture','other',async()=>{})).rejects.toThrow('RECOVERY_LOCK_ORDER');
 });expect(g.size()).toBe(0);
});

it('releases completed per-record contexts instead of retaining every finished write',async()=>{
 const disabled=vi.spyOn(AsyncLocalStorage.prototype,'disable');
 const g=(await gate()).createRecordRecoveryGate();
 for(let n=0;n<100;n++)await g.read('fixture','same',async()=>n);
 expect(g.size()).toBe(0);expect(disabled).toHaveBeenCalledTimes(100);
});

it('retains the context until every overlapping use of a record settles',async()=>{
 const disabled=vi.spyOn(AsyncLocalStorage.prototype,'disable');
 const g=(await gate()).createRecordRecoveryGate(),release=deferred();
 const one=g.read('fixture','same',async()=>release.promise);
 await g.read('fixture','same',async()=>1);
 expect(g.size()).toBe(1);expect(disabled).not.toHaveBeenCalled();
 release.resolve();await one;expect(g.size()).toBe(0);expect(disabled).toHaveBeenCalledTimes(1);
});

it('keeps timed-out caller work locked until the actual callback completes',async()=>{
 const g=(await gate()).createRecordRecoveryGate(),release=deferred(),events:string[]=[];
 const work=g.read('fixture','same',async()=>{await release.promise;events.push('write-finished');});
 const timeout=tick().then(()=>{throw Error('caller-timeout');});
 await expect(Promise.race([work,timeout])).rejects.toThrow('caller-timeout');
 const recovery=g.exclusive([{scope:'fixture',key:'same'}],async()=>events.push('exclusive'));
 await tick();expect(events).toEqual([]);expect(g.size()).toBe(1);
 release.resolve();await Promise.all([work,recovery]);expect(events).toEqual(['write-finished','exclusive']);expect(g.size()).toBe(0);
});

it('keeps aborted caller work locked and releases queued recovery after cooperative rejection',async()=>{
 const g=(await gate()).createRecordRecoveryGate(),release=deferred(),abort=new AbortController(),events:string[]=[];
 const work=g.read('fixture','same',async()=>{await release.promise;abort.signal.throwIfAborted();});
 const rejected=expect(work).rejects.toMatchObject({name:'AbortError'});abort.abort();
 const recovery=g.exclusive([{scope:'fixture',key:'same'}],async()=>events.push('exclusive'));
 await tick();expect(events).toEqual([]);expect(g.size()).toBe(1);
 release.resolve();await rejected;await recovery;expect(events).toEqual(['exclusive']);expect(g.size()).toBe(0);
});

it('does not let a live async descendant reuse a disposed exclusive context',async()=>{
 const g=(await gate()).createRecordRecoveryGate(),child=deferred(),release=deferred(),events:string[]=[];let escaped!:Promise<unknown>;
 await g.exclusive([{scope:'fixture',key:'same'}],async()=>{
  await g.read('fixture','same',async()=>events.push('internal'));
  escaped=child.promise.then(()=>g.read('fixture','same',async()=>events.push('escaped')));
 });
 const held=g.exclusive([{scope:'fixture',key:'same'}],async()=>{events.push('held');await release.promise;});
 await tick();child.resolve();await tick();expect(events).toEqual(['internal','held']);
 release.resolve();await Promise.all([held,escaped]);expect(events).toEqual(['internal','held','escaped']);expect(g.size()).toBe(0);
});

it('does not restore old exclusive privileges through an explicitly bound callback',async()=>{
 const g=(await gate()).createRecordRecoveryGate(),release=deferred(),events:string[]=[];let bound!:()=>Promise<unknown>;
 await g.exclusive([{scope:'fixture',key:'same'}],async()=>{
  bound=AsyncLocalStorage.bind(()=>g.read('fixture','same',async()=>events.push('bound')));
 });
 const held=g.exclusive([{scope:'fixture',key:'same'}],async()=>{events.push('held');await release.promise;});
 await tick();const late=bound();await tick();expect(events).toEqual(['held']);
 release.resolve();await Promise.all([held,late]);expect(events).toEqual(['held','bound']);expect(g.size()).toBe(0);
});

it('preserves unrelated active gates and independent trace context during disposal',async()=>{
 const disabled=vi.spyOn(AsyncLocalStorage.prototype,'disable');
 const g=(await gate()).createRecordRecoveryGate(),release=deferred(),trace=new AsyncLocalStorage<string>();
 try{await trace.run('trace-owner',async()=>{
  const held=g.read('fixture','held',async()=>{await release.promise;expect(trace.getStore()).toBe('trace-owner');});
  await g.read('fixture','unrelated',async()=>expect(trace.getStore()).toBe('trace-owner'));
  expect(disabled).toHaveBeenCalledTimes(1);expect(g.size()).toBe(1);expect(trace.getStore()).toBe('trace-owner');
  release.resolve();await held;expect(trace.getStore()).toBe('trace-owner');expect(g.size()).toBe(0);
 });}finally{trace.disable();}
});

it('releases every selected record after nested failure and admits the queued successor',async()=>{
 const g=(await gate()).createRecordRecoveryGate(),release=deferred(),events:string[]=[];
 const failed=g.exclusive([{scope:'fixture',key:'b'},{scope:'fixture',key:'a'},{scope:'fixture',key:'a'}],async()=>{await release.promise;throw Error('expected');});
 const rejected=expect(failed).rejects.toThrow('expected');
 const next=g.read('fixture','b',async()=>events.push('next'));await tick();expect(events).toEqual([]);
 release.resolve();await Promise.all([rejected,next]);expect(events).toEqual(['next']);expect(g.size()).toBe(0);
});
