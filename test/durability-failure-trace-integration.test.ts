import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createStateDurabilityFence} from '../src/ops/state-durability.mjs';

it('records a real missing readback without changing timeout, retry retention or SDK reads',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am-trace-missing-'));let gets=0;
 try{
  const fence=createStateDurabilityFence({storePath:dir,timeoutMs:100,pollIntervalMs:1});
  await fence.mutate('mem:obs:PRIVATE','PRIVATE_KEY',async()=>{});
  const error=await fence.waitForKeys({get:async()=>{gets++;return{id:'PRIVATE_KEY',body:'PRIVATE_BODY'};}},[{scope:'mem:obs:PRIVATE',key:'PRIVATE_KEY'}]).catch(error=>error);
  expect(error.code).toBe('STATE_DURABILITY_TIMEOUT');expect(gets).toBe(1);expect(fence.keys()).toHaveLength(1);
  const trace=(fence.snapshot()as any).measurements.failureTraces.recent[0];
  expect(trace.certificateRef).toBe(error.diagnostics.certificateRef);
  expect(trace.timeline.some((event:any)=>event.phase==='mismatch'&&event.mismatch==='missing')).toBe(true);
  expect(trace.timeline.at(-1).phase).toBe('deadline');expect(JSON.stringify(trace)).not.toContain('PRIVATE');
 }finally{await rm(dir,{recursive:true,force:true});}
});
it('records revision recapture booleans without retaining canonical values or generations',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am-trace-recapture-'));const scope='mem:embedding-retry:v1',key='PRIVATE_KEY';
 try{
  const fence=createStateDurabilityFence({storePath:dir,timeoutMs:100,pollIntervalMs:1});
  let gets=0;await fence.mutate(scope,key,async()=>{});
  await writeFile(join(dir,encodeURIComponent(scope)+'.bin'),JSON.stringify({[key]:{generation:'PRIVATE_DISK'}}));
  await fence.waitForKeys({get:async()=>{if(++gets===1){await fence.mutate(scope,key,async()=>{});return{generation:'PRIVATE_OLD'};}return{generation:'PRIVATE_NEW'};}},[{scope,key}]).catch(()=>{});
  expect(gets).toBe(2);expect(fence.keys()).toHaveLength(1);
  const trace=(fence.snapshot()as any).measurements.failureTraces.recent[0];
  expect(trace.timeline.some((event:any)=>event.phase==='revision_recapture'&&event.valueChanged&&event.generationChanged)).toBe(true);
  expect(trace.timeline.some((event:any)=>event.phase==='mismatch'&&event.mismatch==='retry_generation')).toBe(true);
  expect(JSON.stringify(trace)).not.toContain('PRIVATE');
 }finally{await rm(dir,{recursive:true,force:true});}
});
it('links separate failed certificates to one physical read with per-waiter scan attribution',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am-trace-shared-'));
 try{
  const scope='mem:obs:PRIVATE',path=join(dir,encodeURIComponent(scope)+'.bin');await writeFile(path,'{"a":1,"b":2}');
  const fence=createStateDurabilityFence({storePath:dir,timeoutMs:150,pollIntervalMs:2});
  const results=await Promise.allSettled(['a','b'].map(key=>fence.waitForKeys({get:async()=>99},[{scope,key}])));
  expect(results.every(result=>result.status==='rejected')).toBe(true);
  const snapshot=fence.snapshot()as any,traces=snapshot.measurements.failureTraces.recent;
  expect(traces).toHaveLength(2);expect(new Set(traces.map((trace:any)=>trace.certificateRef)).size).toBe(2);
  const ids=traces.map((trace:any)=>trace.timeline.find((event:any)=>event.phase==='read_started')?.readId);
  expect(ids[0]).toBeTypeOf('number');expect(ids[0]).toBe(ids[1]);
  for(const trace of traces){expect(trace.scans).toBe(1);expect(trace.timeline.some((event:any)=>event.phase==='read_opened'&&event.fileBytes===13)).toBe(true);expect(trace.timeline.some((event:any)=>event.phase==='read_completed'&&event.complete)).toBe(true);}
  expect(snapshot.readSharing.startedReads).toBe(1);expect(snapshot.readSharing.scanBytes).toBe(13);
 }finally{await rm(dir,{recursive:true,force:true});}
});
