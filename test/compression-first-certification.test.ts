import {expect,it,vi} from 'vitest';
vi.mock('../src/logger.js',()=>({logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}}));
import {runCompressionCertificationScenario} from './helpers/compression-certification-scenario.js';
import {logger} from '../src/logger.js';
async function factories(){return{
 recoveryFactory:process.env.AM_COMPRESSION_RECOVERY_MODULE?(await import(process.env.AM_COMPRESSION_RECOVERY_MODULE)).registerEmbeddingRecovery:undefined,
 durabilityFactory:process.env.AM_COMPRESSION_DURABILITY_MODULE?(await import(process.env.AM_COMPRESSION_DURABILITY_MODULE)).createStateDurabilityFence:undefined,
 compressFactory:process.env.AM_COMPRESSION_COMPRESS_MODULE?(await import(process.env.AM_COMPRESSION_COMPRESS_MODULE)).registerCompressFunction:undefined,
};}
async function report(result:unknown){if(process.env.AM_COMPRESSION_REPORT){const{writeFile}=await import('node:fs/promises');await writeFile(process.env.AM_COMPRESSION_REPORT,JSON.stringify({syntheticCompressionFirstCertification:true,...result as object},null,2)+'\n');}}

it('reproduces compression reported failed after the result and retry intent were written but not certified',async()=>{
 const result=await runCompressionCertificationScenario({itemCount:1,publicationDelayMs:100,timeoutMs:35});
 expect(result.outcomes).toEqual([expect.objectContaining({success:false,revisionWritten:true,retained:true,diagnosticCategory:'state_durability'})]);
 expect(result.metrics).toMatchObject({totalCalls:1,failureCount:1});
 expect(result.embeddingCalls).toBe(0);expect(result.pendingTargets).toBe(1);expect(result.committedTargets).toBe(0);expect(result.originalSourcesPreserved).toBe(true);expect(result.inferencePeak).toBe(1);
});
it('uses serial full compression arrivals and real final vector publication on an uncontended file',async()=>{
 const result=await runCompressionCertificationScenario({itemCount:2,timeoutMs:2000});
 expect(result.outcomes.every(row=>row.success)).toBe(true);expect(result.compressionCalls).toBe(2);expect(result.embeddingCalls).toBe(2);expect(result.inferencePeak).toBe(1);
 expect(result.originalSourcesPreserved).toBe(true);expect(result.pendingTargets).toBe(0);expect(result.committedTargets).toBe(2);expect(result.publicationFailures).toBe(0);
 expect(result.inferenceEvents.map(row=>row.kind+':'+row.phase)).toEqual(['compress:start','compress:end','embed:start','embed:end','compress:start','compress:end','embed:start','embed:end']);
});
it('keeps foreground writes and recovery separate from serial compression submission',async()=>{
 const result=await runCompressionCertificationScenario({itemCount:2,inferenceMs:15,foregroundWritesAtMs:[10,35],recoveryAtMs:20,publicationDelayMs:3,timeoutMs:2000});
 expect(result.inferencePeak).toBe(1);expect(result.originalSourcesPreserved).toBe(true);expect(result.publicationFailures).toBe(0);expect(result.taskErrors).toEqual([]);
 expect(result.compressionCalls).toBe(2);expect(result.outcomes).toHaveLength(2);
});
it.runIf(process.env.AM_COMPRESSION_BIG==='1')('measures the bounded 253 MB first-attempt full path without concurrent compression injection',async()=>{
 const result=await runCompressionCertificationScenario({namespaceBytes:253_000_000,itemCount:2,inferenceMs:25,foregroundWritesAtMs:[100],recoveryAtMs:200,publicationDelayMs:40,timeoutMs:15000,warmCaptureBudget:process.env.AM_COMPRESSION_WARM==='1',...await factories()});
 expect(result.initialNamespaceBytes).toBeGreaterThanOrEqual(253_000_000);expect(result.inferencePeak).toBe(1);expect(result.originalSourcesPreserved).toBe(true);
 process.stdout.write(JSON.stringify({syntheticCompressionFirstCertification:true,...result})+'\n');
 await report(result);
},180000);
for(const delay of [6000,17000])it.runIf(process.env.AM_COMPRESSION_STRESS===String(delay))(`measures fixed15s full-path certification with source publication gated ${delay}ms after first compressed write`,async()=>{
 const result=await runCompressionCertificationScenario({namespaceBytes:253_000_000,itemCount:2,inferenceMs:25,foregroundWritesAtMs:[1000,4000,8000],recoveryAtMs:200,recoveryItemCount:4,publicationDelayMs:40,firstCompressionPublicationDelayMs:delay,arrivalAnchor:'first_compression_write',timeoutMs:15000,warmCaptureBudget:process.env.AM_COMPRESSION_WARM==='1',...await factories()});
 await report(result);
 expect(result.inferencePeak).toBe(1);expect(result.originalSourcesPreserved).toBe(true);expect(result.diskCompressedTargets).toBe(2);expect(result.publicationFailures).toBe(0);
 if(delay>15000){expect(result.outcomes[0]).toMatchObject({success:false,revisionWritten:true,retained:true,diagnosticCategory:'state_durability'});expect(result.certificateEvents.some(row=>row.kind==='source_intent'&&row.outcome==='failed'&&row.code==='STATE_DURABILITY_TIMEOUT')).toBe(true);}
},180000);
it.runIf(process.env.AM_COMPRESSION_PREWRITE==='1')('compares the original scenario-start prewrite churn with a warm existing capture budget',async()=>{
 const result=await runCompressionCertificationScenario({namespaceBytes:253_000_000,itemCount:2,inferenceMs:25,foregroundWritesAtMs:[1000,4000,8000],recoveryAtMs:200,recoveryItemCount:4,publicationDelayMs:40,firstCompressionPublicationDelayMs:6000,arrivalAnchor:'scenario_start',timeoutMs:15000,warmCaptureBudget:true,...await factories()});
 const known=new Set(['state_namespace_changed','state_durability_timeout','state_namespace_not_committed']);
 const compressionErrors=vi.mocked(logger.error).mock.calls.filter(row=>row[0]==='Compression failed').map(row=>{const code=(row[1] as any)?.error;return known.has(code)?code:'other_error';});
 await report({...result,compressionErrors});expect(result.inferencePeak).toBe(1);expect(result.originalSourcesPreserved).toBe(true);expect(result.publicationFailures).toBe(0);
},180000);
