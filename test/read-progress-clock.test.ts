import {afterEach,expect,it,vi} from 'vitest';import {performance} from 'node:perf_hooks';
import {readerEvidence,validReaderEvidence} from '../src/ops/read-progress.mjs';
import {createSharedNamespaceReader} from '../src/ops/shared-namespace-reader.mjs';
afterEach(()=>vi.restoreAllMocks());
it('isolates diagnostic clock failure before validating progress',()=>{
 vi.spyOn(performance,'now').mockImplementation(()=>{throw Error('PRIVATE_CLOCK');});
 expect(()=>readerEvidence({readerPhase:'stream',readerTimings:{streamMs:1}})).not.toThrow();
});
it('still cancels one active shared caller when the diagnostic clock fails',async()=>{
 let release:any;const c=new AbortController();const reader=createSharedNamespaceReader({read:async(_p:string,o:any)=>{o.onProgress({readerPhase:'stream',readerPhaseSince:1,readerTimings:{streamMs:1}});return new Promise(r=>release=()=>r({values:new Map(),signature:'s'}));}}as any);
 const a=reader.read('/synthetic',{keys:new Set(['k']),signal:c.signal}),rejected=expect(a).rejects.toMatchObject({name:'AbortError'});
 for(let n=0;n<16;n++)await Promise.resolve();const b=reader.read('/synthetic',{keys:new Set(['k'])});
 vi.spyOn(performance,'now').mockImplementation(()=>{throw Error('PRIVATE_CLOCK');});c.abort();await rejected;vi.restoreAllMocks();release();await b;await reader.drain();expect(reader.snapshot().activeReads).toBe(0);
});

it('rejects unsupported persisted reader fields and nonfinite timing instead of trusting them',()=>{
 expect(validReaderEvidence({readerPhase:'stream',readerTimings:{streamMs:2},bytesRead:1})).toBe(true);
 for(const v of [{readerPhase:'PRIVATE',readerTimings:{}},{readerPhase:'stream',readerTimings:{PRIVATE:1}},{readerPhase:'stream',readerTimings:{streamMs:Infinity}},{readerPhase:'stream',readerTimings:{},path:'PRIVATE'}])expect(validReaderEvidence(v)).toBe(false);
 expect(validReaderEvidence({get readerPhase(){throw Error('PRIVATE');}})).toBe(false);
});
