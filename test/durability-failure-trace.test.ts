import {expect,it} from 'vitest';
import {createDurabilityMeasurements} from '../src/ops/durability-measurement.mjs';

it('correlates certificates across bounded recent and failure histories with restart-distinct epochs',()=>{
 const a=createDurabilityMeasurements(),b=createDurabilityMeasurements();
 const first=a.begin(['mem:obs:PRIVATE_SESSION'],1,{budgetMs:15000,startedAt:123})!;
 expect(first.certificateRef).toMatch(/^[a-f0-9]{32}:1$/);
 first.event('capture_finished','mem:obs:PRIVATE_SESSION',{capturedKeyCount:1,privateValue:'PRIVATE'});
 first.finish('failed','STATE_READBACK_TIMEOUT','readback');
 const snapshot=a.snapshot()!;
 expect(snapshot.recent[0]).toMatchObject({certificateRef:first.certificateRef,budgetMs:15000,startedAt:123});
 expect(snapshot.failureTraces.recent[0]).toMatchObject({certificateRef:first.certificateRef,timeline:[{phase:'capture_finished',capturedKeyCount:1}]});
 expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE|mem:obs/);
 expect(b.begin([],0)!.certificateRef.split(':')[0]).not.toBe(first.certificateRef.split(':')[0]);
});
it('bounds failed trace detail separately from recent-eight samples and expires it honestly',()=>{
 let now=0;const measurements=createDurabilityMeasurements({wallClock:()=>now,clock:()=>now});
 for(let n=0;n<40;n++){
  const m=measurements.begin(Array.from({length:12},(_,i)=>'mem:obs:PRIVATE'+i),12)!;
  for(let event=0;event<50;event++)m.event('read_started','mem:obs:PRIVATE0',{readId:event});
  m.finish('failed','STATE_READBACK_TIMEOUT','readback');now++;
 }
 const snapshot=measurements.snapshot()!;
 expect(snapshot.recent).toHaveLength(8);
 expect(snapshot.failureTraces).toMatchObject({limit:32,retentionMs:900000,evicted:8,expired:0,lookupCoverage:'bounded_missing_is_unknown'});
 expect(snapshot.failureTraces.recent).toHaveLength(32);
 expect(snapshot.failureTraces.recent[0].timeline).toHaveLength(32);
 expect(snapshot.failureTraces.recent[0].omittedEvents).toBe(18);
 expect(snapshot.failureTraces.recent[0].namespaces).toHaveLength(8);
 now+=900000;
 expect(measurements.snapshot()!.failureTraces).toMatchObject({recent:[],expired:32});
 expect(measurements.snapshot()!.totals.completed).toBe(0); // Trace expiry never invents storage outcome counts.
});
it('ignores unapproved event fields/enums and invalid namespace references',()=>{
 const measurements=createDurabilityMeasurements(),m=measurements.begin(['mem:embedding-retry:v1'],1)!;
 m.event('PRIVATE_PHASE','PRIVATE_SCOPE',{readId:1});
 m.event('mismatch','mem:embedding-retry:v1',{mismatch:'retry_generation',generation:'PRIVATE_GENERATION',key:'PRIVATE_KEY',signature:'PRIVATE_SIGNATURE'});
 m.event('mismatch','mem:embedding-retry:v1',{mismatch:'PRIVATE_VALUE'});
 m.finish('failed','state_namespace_not_committed','readback');
 const trace=measurements.snapshot()!.failureTraces.recent[0];
 expect(trace.timeline).toHaveLength(2);expect(trace.timeline[0]).toMatchObject({phase:'mismatch',mismatch:'retry_generation'});
 expect(trace.timeline[1].mismatch).toBeUndefined();expect(JSON.stringify(trace)).not.toContain('PRIVATE');
});
it('never throws when telemetry clocks or metadata access fail',()=>{
 let fail=false;const measurements=createDurabilityMeasurements({clock:()=>{if(fail)throw Error('PRIVATE_CLOCK');return 0;}});
 const m=measurements.begin([],0)!;fail=true;
 expect(()=>m.event('read_started',undefined,{get readId(){throw Error('PRIVATE_EVENT');}})).not.toThrow();
 expect(()=>m.finish('failed','STATE_READBACK_TIMEOUT','readback')).not.toThrow();
 expect(measurements.snapshot()).toMatchObject({unavailable:1,recent:[]});
});
it('retains existing evidence with unknown expiry coverage when the telemetry wall clock is unavailable',()=>{
 let fail=false;const measurements=createDurabilityMeasurements({wallClock:()=>{if(fail)throw Error('PRIVATE_WALL_CLOCK');return 123;}});
 measurements.begin([],0)!.finish('failed','STATE_READBACK_TIMEOUT','readback');
 fail=true;
 const view=measurements.snapshot()!;
 expect(view.failureTraces).toMatchObject({clockUnavailable:true,expired:0});expect(view.failureTraces.recent).toHaveLength(1);
 expect(JSON.stringify(view)).not.toContain('PRIVATE');
});
it('limits event metadata to safe primitive numbers and booleans',()=>{
 const measurements=createDurabilityMeasurements(),m=measurements.begin([],0)!;
 m.event('read_opened',undefined,{readId:1.5,fileBytes:-1,bytesRead:Infinity,ageMs:3.2,started:true,key:'PRIVATE'});
 m.finish('failed','STATE_READBACK_TIMEOUT','readback');
 expect(measurements.snapshot()!.failureTraces.recent[0].timeline).toEqual([{phase:'read_opened',atMs:expect.any(Number),ageMs:3.2,started:true}]);
});
it('pins compact first failures despite later trace eviction and returns safe evidence for recovery checkpoints',()=>{
 const measurements=createDurabilityMeasurements();
 for(let n=0;n<50;n++){
  const m=measurements.begin(['mem:obs:PRIVATE'],1)!;
  m.event('read_aborted','mem:obs:PRIVATE',{readerPhase:'stream',readerTimings:{streamMs:123,processingMs:4,PRIVATE:999},bytesRead:64,path:'PRIVATE',processCpuMs:2,eventLoopActiveMs:3});
  expect(m.readbackEvidence()).toEqual({readerPhase:'stream',readerTimings:{streamMs:123,processingMs:4},bytesRead:64,processCpuMs:2,eventLoopActiveMs:3});
  m.finish('failed','STATE_READBACK_TIMEOUT','readback');
 }
 const view=measurements.snapshot()!;
 expect(view.readbackFailureEvidence).toMatchObject({limit:8,omitted:42,retention:'first_per_process'});
 expect(view.readbackFailureEvidence.first).toHaveLength(8);expect(view.readbackFailureEvidence.first[0].certificateRef).toMatch(/:1$/);
 expect(JSON.stringify(view)).not.toContain('PRIVATE');
});
