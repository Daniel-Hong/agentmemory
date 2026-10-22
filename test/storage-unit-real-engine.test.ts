import {expect,it,vi} from 'vitest';
import {writeFile,realpath,readFile} from 'node:fs/promises';
import {registerWorker} from 'iii-sdk';
import {runCompressionCertificationScenario} from './helpers/compression-certification-scenario.js';
vi.mock('../src/logger.js',()=>({logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}}));

// Lifecycle/configuration is deliberately external: this test never starts an
// engine, reads operating configuration, writes engine files, or deletes a store.
const enabled=process.env.AM_ISOLATED_ENGINE_EXPERIMENT==='1';
it.skipIf(!enabled)('measures synthetic compression through an explicitly supplied isolated real engine',async()=>{
 const endpoint=new URL(process.env.AM_ISOLATED_ENGINE_URL??'');
 if(endpoint.protocol!=='ws:'||!['127.0.0.1','localhost'].includes(endpoint.hostname)||!endpoint.port||['49134','3111','3112'].includes(endpoint.port))throw Error('isolated_loopback_endpoint_required');
 const storePath=await realpath(process.env.AM_ISOLATED_ENGINE_STORE??'');
 if(!storePath.startsWith('/tmp/'))throw Error('temporary_store_required');
 const output=process.env.AM_ISOLATED_ENGINE_RESULT;
 if(!output||(!output.startsWith('/tmp/')&&!output.startsWith(process.cwd()+'/../storage-unit-development-evidence/')))throw Error('synthetic_result_path_required');
 const units=Number(process.env.AM_ISOLATED_ENGINE_UNITS??'1');if(units!==1&&units!==16)throw Error('invalid_units');
 const sdk=registerWorker(endpoint.href,{workerName:'synthetic-storage-unit-experiment',invocationTimeoutMs:30000,enableMetricsReporting:false,otel:{enabled:false}});
 try{
  const readyUntil=performance.now()+10000;for(;;){try{await sdk.trigger({function_id:'state::get',payload:{scope:'synthetic-readiness',key:'absent'}});break;}catch(error){if(performance.now()>readyUntil)throw error;await new Promise(resolve=>setTimeout(resolve,100));}}
  const manifestPath=process.env.AM_ISOLATED_ENGINE_REUSE_MANIFEST;
  if(manifestPath&&!manifestPath.startsWith('/tmp/'))throw Error('temporary_seed_manifest_required');
  if(process.env.AM_ISOLATED_ENGINE_REUSE_SEED==='1'&&!manifestPath)throw Error('synthetic_seed_manifest_required');
  const manifest=manifestPath?JSON.parse(await readFile(manifestPath,'utf8')):null;
  const seedChecksums=manifest?Object.fromEntries(manifest.sourceFiles.map((row:any)=>[row.scope,row.sha256])):undefined;
  const result=await runCompressionCertificationScenario({realEngine:{sdk,storePath,prepareOnly:process.env.AM_ISOLATED_ENGINE_PREPARE_ONLY==='1',reuseSyntheticSeed:!!manifest,seedChecksums},namespaceBytes:Number(process.env.AM_ISOLATED_ENGINE_BYTES??'256000000'),itemCount:2,inferenceMs:Number(process.env.AM_ISOLATED_ENGINE_INFERENCE_MS??'2000'),timeoutMs:15000,storageUnitCount:units,warmCaptureBudget:true,arrivalAnchor:'first_compression_write',foregroundWritesAtMs:process.env.AM_ISOLATED_ENGINE_CHURN==='1'?[1000,4000,7000,10000,13000]:[],writerPlacement:'unrelated',recoverPendingAtEnd:true});
  await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  expect(result.engine).toBe('actual-iii');
  if('preparationOnly'in result){expect(result.preparationOnly).toBe(true);expect(result.businessMeasured).toBe(false);return;}
  expect(result.inferencePeak).toBe(1);expect(result.originalSourcesPreserved).toBe(true);expect(result.storageUnits.duplicateSourceKeys).toBe(0);expect(result.storageUnits.sourceKeysComplete).toBe(true);
  if(units===16)expect(result.storageUnits.logicalSourceFilePresent).toBe(false);
 }finally{await sdk.shutdown();}
},180000);

import {waitForSyntheticSeedPublication,verifySyntheticSeed} from './helpers/compression-certification-scenario.js';
it('retries only transient seed publication races within its setup deadline',async()=>{
 let calls=0,now=0;const read=vi.fn(async(_path:string,{onEntry}:any)=>{calls++;if(calls<=2)throw Object.assign(Error('publication'),{code:calls===1?'ENOENT':'state_namespace_changed'});onEntry('fixture',{});});
 expect(await waitForSyntheticSeedPublication(['synthetic'],1,{read,clock:()=>now,wait:async(ms:number)=>{now+=ms;},timeoutMs:300})).toEqual({attempts:3});
 expect(read).toHaveBeenCalledTimes(3);
});
it('does not turn corrupt/access-denied seed files into readiness retries',async()=>{
 for(const code of ['EACCES','state_namespace_corrupt']){const error=Object.assign(Error(code),{code}),read=vi.fn(async()=>{throw error;});await expect(waitForSyntheticSeedPublication(['synthetic'],1,{read})).rejects.toBe(error);expect(read).toHaveBeenCalledTimes(1);}
});
it('bounds persistent publication races without certifying a partial seed',async()=>{
 let now=0;const read=vi.fn(async()=>{throw Object.assign(Error('changed'),{code:'state_namespace_changed'});});
 await expect(waitForSyntheticSeedPublication(['synthetic'],1,{read,clock:()=>now,wait:async(ms:number)=>{now+=ms;},timeoutMs:200})).rejects.toThrow('actual_engine_seed_not_published');expect(read).toHaveBeenCalledTimes(3);
});

it('verifies every checkpoint value and pinned source checksum before reuse',async()=>{
 const paths=[{scope:'unit',path:'synthetic',expected:new Map([['a',{id:'a',sourceRaw:{toolOutput:'synthetic'}}]])}];
 const read=async(_path:string,{onEntry}:any)=>{onEntry('a',{id:'a',sourceRaw:{toolOutput:'synthetic'}});};
 const checksum=async()=> 'abc';
 expect(await verifySyntheticSeed(paths,{read,checksum,pinnedChecksums:{unit:'abc'}})).toEqual([{scope:'unit',sha256:'abc',entries:1}]);
 await expect(verifySyntheticSeed(paths,{read,checksum,pinnedChecksums:{unit:'wrong'}})).rejects.toThrow('synthetic_seed_checksum_mismatch');
 await expect(verifySyntheticSeed(paths,{read,checksum,pinnedChecksums:{unit:'abc',extra:'abc'}})).rejects.toThrow('synthetic_seed_checksum_scope_mismatch');
});
it('rejects missing, foreign, duplicate and wrong-value checkpoint rows',async()=>{
 const paths=[{scope:'unit',path:'synthetic',expected:new Map([['a',{id:'a'}]])}];
 for(const records of [[],[['foreign',{id:'a'}]],[['a',{id:'changed'}]],[['a',{id:'a'}],['a',{id:'a'}]]]){
  await expect(verifySyntheticSeed(paths,{read:async(_path:string,{onEntry}:any)=>{for(const[key,value]of records)onEntry(key,value);},checksum:async()=> 'abc'})).rejects.toThrow(/synthetic_seed_(content|count)_mismatch/);
 }
});

it('allows only exact retained rows when identifying missing synthetic seed keys for preparation',async()=>{
 const paths=[{scope:'unit',path:'synthetic',expected:new Map([['a',{id:'a'}],['b',{id:'b'}]])}];
 const read=async(_path:string,{onEntry}:any)=>{onEntry('a',{id:'a'});};
 const result=await verifySyntheticSeed(paths,{read,checksum:async()=> 'partial',pinnedChecksums:{unit:'partial'},allowMissing:true});
 expect(result).toEqual([{scope:'unit',sha256:'partial',entries:1,missingKeys:['b']}]);
 await expect(verifySyntheticSeed(paths,{read,checksum:async()=> 'partial',pinnedChecksums:{unit:'partial'}})).rejects.toThrow('synthetic_seed_count_mismatch');
 await expect(verifySyntheticSeed(paths,{read:async(_path:string,{onEntry}:any)=>onEntry('a',{id:'foreign'}),checksum:async()=> 'partial',pinnedChecksums:{unit:'partial'},allowMissing:true})).rejects.toThrow('synthetic_seed_content_mismatch');
});
