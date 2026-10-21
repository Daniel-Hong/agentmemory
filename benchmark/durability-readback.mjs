import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {writeFileSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';

const baseline=process.argv[2];
if(!baseline)throw Error('baseline_source_root_required');
const implementations=[['baseline',resolve(baseline)],['optimized',resolve(new URL('..',import.meta.url).pathname)]];
const results=[];
for(const [name,root] of implementations){
 const {readNamespaceEntries}=await import(pathToFileURL(join(root,'src/ops/namespace-reader.mjs')));
 const {createStateDurabilityFence}=await import(pathToFileURL(join(root,'src/ops/state-durability.mjs')));
 const dir=await mkdtemp(join(tmpdir(),'am-synthetic-readback-'));
 try{
  const path=join(dir,'synthetic.bin'),body=JSON.stringify({head:1,payload:'x'.repeat(16*1024*1024)}),interval=1024*1024;
  for(const changing of [false,true]){
   await writeFile(path,body);let metadata,changed=false,outcome='verified';const began=performance.now();
   try{await readNamespaceEntries(path,{keys:new Set(['head']),checkIntervalBytes:interval,onEntry:()=>{
    if(changing&&!changed){changed=true;writeFileSync(path+'.next','{"head":2}');renameSync(path+'.next',path);}
   },onRead:info=>{metadata=info;}});}catch(e){outcome=e.code??e.message;}
   results.push({name,case:changing?'replacement':'stable',fixtureBytes:Buffer.byteLength(body),elapsedMs:performance.now()-began,outcome,parserBytes:metadata?.bytesRead,complete:metadata?.complete});
  }
  await writeFile(path,'{"key":2,"padding":"'+'x'.repeat(65536)+'"}');
  const fence=createStateDurabilityFence({storePath:dir,timeoutMs:200,pollIntervalMs:5});const began=performance.now();let outcome;
  try{await fence.waitForKeys({get:async()=>1},[{scope:'synthetic',key:'key'}]);outcome='verified';}catch(e){outcome=e.code;}
  const sample=fence.snapshot().measurements.recent[0];results.push({name,case:'unchanged_mismatch',elapsedMs:performance.now()-began,outcome,scans:sample.scans,parserBytes:sample.scanBytes,checks:sample.checkAttempts,unchangedMismatchSkips:sample.unchangedMismatchSkips??0});
 }finally{await rm(dir,{recursive:true,force:true});}
}
console.log(JSON.stringify({synthetic:true,productionData:false,providerCalls:0,deadlineUnchanged:true,results,limitations:['16MiB synthetic data, one local run; not an operational throughput benchmark.','Parser bytes exclude OS prefetch/cache behavior. Stable-read metadata checks add IO.','Unchanged mismatch must still fail at its original deadline; optimization saves scans, not certification requirements.']},null,2));
