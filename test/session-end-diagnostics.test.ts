import{afterEach,expect,it,vi}from'vitest';import{createSessionEndDiagnostics}from'../src/ops/session-end-diagnostics.js';
afterEach(()=>vi.useRealTimers());
it('reports the slow phase and completion without accepting user identifiers or raw errors',async()=>{
 vi.useFakeTimers();const emit=vi.fn();const d=createSessionEndDiagnostics({emit,clock:Date.now});const span=d.begin();span.enter('feature_observations_read');await vi.advanceTimersByTimeAsync(4000);
 expect(emit).toHaveBeenCalledTimes(1);expect(emit.mock.calls[0]![0]).toMatchObject({requestKind:'session_end',stage:'feature_observations_read',outcome:'pending',elapsedMs:4000});span.finish('failed');expect(emit).toHaveBeenCalledTimes(2);await vi.advanceTimersByTimeAsync(60000);expect(emit).toHaveBeenCalledTimes(2);
});
it('bounds active timers and log frequency and ignores logger failures',async()=>{
 vi.useFakeTimers();const emit=vi.fn(()=>{throw Error('private logger exception');});const d=createSessionEndDiagnostics({emit,clock:Date.now});const spans=Array.from({length:50},()=>d.begin());await vi.advanceTimersByTimeAsync(6000);expect(emit.mock.calls.length).toBeLessThanOrEqual(2);for(const s of spans)s.finish('acknowledged');expect(emit.mock.calls.length).toBeLessThanOrEqual(2);expect(d.snapshot().active).toBe(0);
});
it('does not log normal fast acknowledgements or retain timers after finish',async()=>{
 vi.useFakeTimers();const emit=vi.fn();const d=createSessionEndDiagnostics({emit,clock:Date.now});const span=d.begin();span.enter('PRIVATE_SESSION' as never);span.finish('acknowledged');await vi.advanceTimersByTimeAsync(10000);expect(emit).not.toHaveBeenCalled();expect(d.snapshot().active).toBe(0);
});
it('observes session end lock/read/write without changing completion and ignores observer errors',async()=>{
 const{finishLongSession}=await import('../src/ops/long-session.mjs');const events:string[]=[];const kv={get:vi.fn(async()=>({id:'PRIVATE_SESSION'})),update:vi.fn(async()=>{})};const lock=async(_key:string,fn:()=>unknown)=>fn();
 expect(await finishLongSession(kv as never,{sessions:'synthetic'} as never,lock as never,'PRIVATE_SESSION',true,(stage:string)=>{events.push(stage);throw Error('PRIVATE_ERROR');})).toBe(true);
 expect(events).toEqual(['session_lock_wait','session_read','session_write']);expect(kv.update).toHaveBeenCalledTimes(1);
});
