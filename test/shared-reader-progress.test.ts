import {expect,it} from 'vitest';
import {createSharedNamespaceReader} from '../src/ops/shared-namespace-reader.mjs';
const turn=async()=>{for(let n=0;n<16;n++)await Promise.resolve();};
it('captures the unfinished physical stage before a cancelled caller detaches, including shared followers',async()=>{
 let release:any;const events:any[]=[],c=new AbortController();
 const reader=createSharedNamespaceReader({maxParallelReads:1,read:async(_p:string,o:any)=>{o.onProgress?.({readerPhase:'stream',readerPhaseSince:performance.now()-20,readerTimings:{openMs:1,statMs:2,streamMs:3,processingMs:4,closeMs:0},bytesRead:64,PRIVATE:'PRIVATE'});return new Promise(r=>release=()=>r({values:new Map([['k',1]]),signature:'s'}));}}as any);
 const a=reader.read('/PRIVATE',{keys:new Set(['k']),signal:c.signal,onDiagnostic:(e:any)=>events.push(e)}),rejected=expect(a).rejects.toMatchObject({name:'AbortError'});await turn();
 const b=reader.read('/PRIVATE',{keys:new Set(['k'])});await turn();c.abort();await rejected;
 const aborted=events.find(e=>e.phase==='aborted');expect(aborted).toMatchObject({readerPhase:'stream',bytesRead:64,readerTimings:{processingMs:4}});expect(aborted.readerTimings.streamMs).toBeGreaterThanOrEqual(23);expect(JSON.stringify(events)).not.toContain('PRIVATE');
 release();expect((await b).values.get('k')).toBe(1);await reader.drain();expect(reader.snapshot().activeReads).toBe(0);
});
