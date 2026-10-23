import {expect,it} from 'vitest';
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
