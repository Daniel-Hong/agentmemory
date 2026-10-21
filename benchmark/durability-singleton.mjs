import {mkdtemp,open,copyFile,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';

const selectedBytes=60*1024*1024;
if(process.argv[2]==='--child'){
 const [root,dir,scenario]=process.argv.slice(3);
 const sourceHashes={};for(const name of ['state-durability.mjs','namespace-reader.mjs','shared-namespace-reader.mjs'])sourceHashes[name]=createHash('sha256').update(await readFile(join(root,'src/ops',name))).digest('hex');
 const {createStateDurabilityFence}=await import(pathToFileURL(join(root,'src/ops/state-durability.mjs')));
 const fence=createStateDurabilityFence({storePath:dir}),large='x'.repeat(selectedBytes),kv={get:async(_scope,key)=>key==='large'?large:1};
 const request=key=>fence.waitForKeys(kv,[{scope:'synthetic',key}]);
 const cpu=process.cpuUsage(),began=performance.now();let results;
 if(scenario==='sequential-large'){
  results=[];for(let i=0;i<2;i++)results.push((await Promise.allSettled([request('large')]))[0]);
 }else if(scenario==='two-overlap-large')results=await Promise.allSettled([request('large'),request('large')]);
 else if(scenario==='late-subset-small'){
  const first=request('small');const second=new Promise(r=>setTimeout(r,30)).then(()=>request('small'));
  results=await Promise.allSettled([first,second]);
 }else results=await Promise.allSettled([request(scenario==='singleton-small'?'small':'large')]);
 const elapsedMs=performance.now()-began;await fence.drain();const cleanupElapsedMs=performance.now()-began-elapsedMs;
 const delta=process.cpuUsage(cpu),snapshot=fence.snapshot();
 console.log(JSON.stringify({scenario,sourceHashes,elapsedMs,cleanupElapsedMs,userCpuMs:delta.user/1000,systemCpuMs:delta.system/1000,peakRssBytes:process.resourceUsage().maxRSS*1024,requests:results.length,verified:results.filter(r=>r.status==='fulfilled').length,timeouts:results.filter(r=>r.status==='rejected'&&r.reason?.code==='STATE_DURABILITY_TIMEOUT').length,otherErrors:results.filter(r=>r.status==='rejected'&&r.reason?.code!=='STATE_DURABILITY_TIMEOUT').map(r=>r.reason?.code??'unknown'),readSharing:snapshot.readSharing}));
}else{
 const baseline=resolve(process.argv[2]),rounds=Number(process.argv[3]??2),output=process.argv[4],root=resolve(process.argv[5]??new URL('..',import.meta.url).pathname);
 const dir=await mkdtemp(join(tmpdir(),'am-singleton-synthetic-')),fixture=join(dir,'fixture.bin'),results=[];
 try{
  const handle=await open(fixture,'w'),hash=createHash('sha256');let bytes=0;
  async function put(text){hash.update(text);bytes+=Buffer.byteLength(text);await handle.writeFile(text);}
  try{
   await put('{"small":1,"large":"');const chunk='x'.repeat(1024*1024);
   for(let i=0;i<60;i++)await put(chunk);await put('"');
   const payload=JSON.stringify({synthetic:'가 escaped \\"[{}]\\ '.repeat(1000),nested:{flag:true,count:17}});
   for(let i=0;bytes<220000000;i++)await put(',"pad'+i+'":'+payload);await put('}');
  }finally{await handle.close();}
  const fixtureSha256=hash.digest('hex');
  for(let round=0;round<rounds;round++)for(const scenario of ['singleton-large','sequential-large','singleton-small','two-overlap-large','late-subset-small']){
   const implementations=round%2?[['optimized',root],['baseline14',baseline]]:[['baseline14',baseline],['optimized',root]];
   for(const [implementation,source] of implementations){
    const work=await mkdtemp(join(dir,'case-'));await copyFile(fixture,join(work,'synthetic.bin'));
    try{
     const result=await new Promise((done,reject)=>{
      const child=spawn(process.execPath,[new URL(import.meta.url).pathname,'--child',source,work,scenario],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
      child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.on('error',reject);
      child.on('close',(code,signal)=>{if(code!==0||!stdout.trim())reject(Error('synthetic_child_failed:'+JSON.stringify({code,signal,stderr,stdout})));else{try{done(JSON.parse(stdout));}catch(error){reject(error);}}});
     });results.push({round,implementation,...result});process.stderr.write(JSON.stringify({round,implementation,scenario,elapsedMs:result.elapsedMs,verified:result.verified,timeouts:result.timeouts,startedReads:result.readSharing.startedReads})+'\n');
    }finally{await rm(work,{recursive:true,force:true});}
   }
  }
  const summary={synthetic:true,productionData:false,providerCalls:0,baselineSource:baseline,fixtureBytes:bytes,fixtureSha256,selectedBytes,rounds,results,limitations:['Synthetic JSON, page cache and expected-value allocations do not establish operational speedups.','Logical parser bytes are not physical disk IO; peak RSS includes expected values and runtime overhead.','Late subsets may share within the projection bound; crossing the bound closes admission before an exclusive scan continues.','Actual multi-waiter oversized projections retain baseline fallback; no global RSS or direct-read concurrency bound is added.','Certification deadline, fsync and final signature verification are unchanged.']};
  if(output)await writeFile(output,JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary));
 }finally{await rm(dir,{recursive:true,force:true});}
}
