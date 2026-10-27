import {afterEach,expect,it,vi} from 'vitest';
const hooks=vi.hoisted(()=>({classify:null as null|(()=>Promise<any>)}));
vi.mock('node:fs/promises',()=>({stat:async()=>hooks.classify?hooks.classify():{size:2*1024*1024}}));
import {createSharedNamespaceReader} from '../src/ops/shared-namespace-reader.mjs';
import {createDurabilityMeasurements} from '../src/ops/durability-measurement.mjs';
const turn=async()=>{for(let n=0;n<20;n++)await Promise.resolve();};
afterEach(()=>{hooks.classify=null;});
it('retains a pending classification at abort without inventing slot wait or starting a read',async()=>{
 let release:any;hooks.classify=()=>new Promise(resolve=>release=resolve);const events:any[]=[],controller=new AbortController();let reads=0;
 const r=createSharedNamespaceReader({maxParallelReads:1,maxSmallParallelReads:1,read:async()=>{reads++;return{values:new Map(),signature:'s'};}});
 const pending=r.read('/PRIVATE',{keys:new Set(['PRIVATE']),signal:controller.signal,onDiagnostic:(e:any)=>events.push(e)});const rejected=expect(pending).rejects.toMatchObject({name:'AbortError'});await turn();controller.abort();await rejected;
 try{expect(events.find(e=>e.phase==='aborted')?.admission).toMatchObject({phase:'classifying',classificationPerformed:true,admissionWaitMs:0});expect(reads).toBe(0);expect(JSON.stringify(events)).not.toContain('PRIVATE');}
 finally{release({size:2*1024*1024});await r.drain();}
});
it('separates slot wait from classification and preserves the blocking holder through completion',async()=>{
 let release:any;const events:any[]=[];const r=createSharedNamespaceReader({maxParallelReads:1,maxSmallParallelReads:1,read:async(path:string,o:any)=>{
  if(path==='/held'){o.onProgress?.({readerPhase:'stream',readerPhaseSince:performance.now(),readerTimings:{streamMs:0},bytesRead:64});await new Promise(resolve=>release=resolve);}
  return{values:new Map([['k',1]]),signature:'s'};
 }});
 const busy=r.read('/held',{keys:new Set(['k'])});await turn();const waiting=r.read('/next',{keys:new Set(['k']),onDiagnostic:(e:any)=>events.push(e)});await turn();
 try{const queued=events.find(e=>e.phase==='admission_queued');expect(queued?.admission).toMatchObject({phase:'queued',classificationPerformed:true,queuedHolders:[{lane:'regular',phase:'stream',bytesRead:64}]});}
 finally{release();await Promise.all([busy,waiting]);await r.drain();}
 const started=events.find(e=>e.phase==='started');expect(started?.admission).toMatchObject({phase:'reading',lastHolders:[{lane:'regular',phase:'stream',bytesRead:64}]});expect(started.admission.classificationMs).toBeGreaterThanOrEqual(0);expect(started.admission.admissionWaitMs).toBeGreaterThanOrEqual(0);expect(started.admission.loopWindowMs).toBeGreaterThanOrEqual(0);expect(JSON.stringify(events)).not.toContain('/held');
});
it('keeps late diagnostic updates out of a finished failure and bounds causal retention independently of timeline overflow',()=>{
 const m=createDurabilityMeasurements();const sample=m.begin(['mem:index:PRIVATE'],1,{budgetMs:15,startedAt:1});
 const context={phase:'queued',classificationPerformed:true,classificationMs:3,admissionWaitMs:4,activeHolders:[{lane:'regular',phase:'stream',readId:9,ageMs:7,bytesRead:64,PRIVATE:'PRIVATE'}],PRIVATE:'PRIVATE'};
 sample.event('read_admission_queued','mem:index:PRIVATE',{readId:1,admission:context});
 for(let n=0;n<80;n++)sample.event('unchanged_mismatch_skip','mem:index:PRIVATE');
 sample.finish('failed','STATE_READBACK_TIMEOUT','readback');context.phase='reading';sample.event('read_started','mem:index:PRIVATE',{readId:1,admission:context});
 const f=m.snapshot().failureTraces.recent[0];expect(f.readAdmissions).toEqual([{readId:1,...{phase:'queued',classificationPerformed:true,classificationMs:3,admissionWaitMs:4,activeHolders:[{lane:'regular',phase:'stream',readId:9,ageMs:7,bytesRead:64}]}}]);expect(JSON.stringify(f)).not.toContain('PRIVATE');
});
it('bounds retained reader contexts even when the request observes many retries',()=>{
 const m=createDurabilityMeasurements(),s=m.begin(['mem:index:test'],1,{budgetMs:15,startedAt:1});for(let readId=1;readId<=20;readId++)s.event('read_admission_queued','mem:index:test',{readId,admission:{phase:'queued',activeHolders:Array.from({length:8},(_,n)=>({lane:'regular',phase:'stream',readId:n,ageMs:1}))}});s.finish('failed','STATE_READBACK_TIMEOUT','readback');const f=m.snapshot().failureTraces.recent[0];expect(f.readAdmissions).toHaveLength(4);expect(f.omittedReadAdmissions).toBe(16);expect(f.readAdmissions.every((v:any)=>v.activeHolders.length===2)).toBe(true);
});
it('does not let a throwing diagnostic callback change the result or leave holders behind',async()=>{
 const r=createSharedNamespaceReader({maxParallelReads:1,maxSmallParallelReads:1,read:async()=>({values:new Map([['k',1]]),signature:'s'})});
 expect((await r.read('/PRIVATE',{keys:new Set(['k']),onDiagnostic:()=>{throw Error('PRIVATE');}})).values.get('k')).toBe(1);await r.drain();expect(r.snapshot()).toMatchObject({activeReads:0,activeWaiters:0,admission:{active:0,queued:0}});
});
it('keeps causal snapshots below 4KiB even with maximum numeric fields and truncates untrusted holder arrays',async()=>{
 const {readAdmissionEvidence}=await import('../src/ops/read-admission-evidence.mjs');
 const fields=['classificationMs','admissionWaitMs','requestCpuMs','requestEventLoopActiveMs','requestEventLoopIdleMs','loopDelayMaxMs','loopDelayMeanMs','loopDelaySamples','loopWindowMs','loopResolutionMs','outstandingPhysicalReads','queueDepth','activeHolderCount','omittedActiveHolders','omittedQueuedHolders'];
 const holder={lane:'regular',phase:'processing',...Object.fromEntries(['readId','ageMs','endedAgoMs','bytesRead','fileBytes','processCpuMs','eventLoopActiveMs','eventLoopIdleMs','openMs','statMs','streamMs','processingMs','closeMs'].map(k=>[k,Number.MAX_SAFE_INTEGER]))};
 const e=readAdmissionEvidence({phase:'queued',classificationPerformed:true,...Object.fromEntries(fields.map(k=>[k,Number.MAX_SAFE_INTEGER])),activeHolders:Array(8).fill(holder),queuedHolders:Array(8).fill(holder),lastHolders:Array(8).fill(holder),PRIVATE:'PRIVATE'});
 expect(Buffer.byteLength(JSON.stringify(e))).toBeLessThanOrEqual(4096);expect(e.activeHolders).toHaveLength(2);expect(e.lastHolders).toHaveLength(2);expect(JSON.stringify(e)).not.toContain('PRIVATE');
});
it('identifies the target lane separately from active holder lanes',async()=>{
 let release:any;const events:any[]=[];const r=createSharedNamespaceReader({maxParallelReads:1,maxSmallParallelReads:1,read:async(path:string)=>{if(path==='/held')await new Promise(resolve=>release=resolve);return{values:new Map(),signature:'s'};}});
 const held=r.read('/held',{keys:new Set(['k'])});await turn();const controller=new AbortController(),pending=r.read('/next',{keys:new Set(['k']),signal:controller.signal,onDiagnostic:(e:any)=>events.push(e)});const rejected=expect(pending).rejects.toMatchObject({name:'AbortError'});await turn();controller.abort();await rejected;
 try{expect(events.find(e=>e.phase==='aborted')?.admission).toMatchObject({phase:'queued',lane:'regular'});}finally{release();await held;await r.drain();}
});
it('records classification rejection without changing its original error or leaking its text',async()=>{
 const error=Object.assign(Error('PRIVATE_PATH'),{code:'EIO'});hooks.classify=async()=>{await turn();throw error;};const events:any[]=[];let reads=0;
 const r=createSharedNamespaceReader({maxParallelReads:1,maxSmallParallelReads:1,read:async()=>{reads++;return{values:new Map(),signature:'s'};}});
 await expect(r.read('/PRIVATE',{keys:new Set(['PRIVATE']),onDiagnostic:(e:any)=>events.push(e)})).rejects.toBe(error);await r.drain();expect(events.find(e=>e.phase==='classification_failed')?.admission).toMatchObject({phase:'classification_failed',classificationPerformed:true,admissionWaitMs:0});expect(reads).toBe(0);expect(JSON.stringify(events)).not.toContain('PRIVATE');
});
