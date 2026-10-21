import {mkdtemp,open,writeFile,copyFile,rename,rm,stat,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';

if(process.argv[2]==='--child'){
 const [root,dir,scenario]=process.argv.slice(3);
 const sourceHashes={};for(const file of ['state-durability.mjs','namespace-reader.mjs','durability-measurement.mjs','shared-namespace-reader.mjs']){try{sourceHashes[file]=createHash('sha256').update(await readFile(join(root,'src/ops',file))).digest('hex');}catch(error){if(error.code!=='ENOENT')throw error;}}
 const {createStateDurabilityFence}=await import(pathToFileURL(join(root,'src/ops/state-durability.mjs')));
 const fence=createStateDurabilityFence({storePath:dir}),kv={get:async(_scope,key)=>scenario==='mismatch'?2:key==='a'?1:2};
 const selected=key=>[{scope:'synthetic',key}];
 let timer;
 if(scenario==='replacement')timer=setTimeout(()=>void rename(join(dir,'next.bin'),join(dir,'synthetic.bin')),100);
 let maximumRss=process.memoryUsage().rss;
 const sampler=setInterval(()=>maximumRss=Math.max(maximumRss,process.memoryUsage().rss),10);
 const cpu=process.cpuUsage(),began=performance.now();let results;
 try{
  if(scenario==='sequential'){
   results=[];for(const key of ['a','b','a'])results.push(await Promise.allSettled([fence.waitForKeys(kv,selected(key))]).then(x=>x[0]));
  }else if(scenario==='late-incompatible'){
   const a=fence.waitForKeys(kv,selected('a'));const b=new Promise(r=>setTimeout(r,30)).then(()=>fence.waitForKeys(kv,selected('b')));
   results=await Promise.allSettled([a,b]);
  }else{
   const keys=scenario==='eight-overlap-stress'?['a','b','a','b','a','b','a','b']:scenario==='five-overlap'?['a','b','a','b','a']:scenario==='mismatch'?['a','a']:['a','b'];
   results=await Promise.allSettled(keys.map(key=>fence.waitForKeys(kv,selected(key))));
  }
 }finally{clearInterval(sampler);clearTimeout(timer);}
 const elapsedMs=performance.now()-began;await fence.drain();
 const cleanupElapsedMs=performance.now()-began-elapsedMs,cpuDelta=process.cpuUsage(cpu),snapshot=fence.snapshot(),samples=snapshot.measurements.recent;
 console.log(JSON.stringify({scenario,sourceHashes,elapsedMs,cleanupElapsedMs,userCpuMs:cpuDelta.user/1000,systemCpuMs:cpuDelta.system/1000,peakRssBytes:Math.max(maximumRss,process.resourceUsage().maxRSS*1024),requests:results.length,verified:results.filter(x=>x.status==='fulfilled').length,timeouts:results.filter(x=>x.status==='rejected'&&x.reason?.code==='STATE_DURABILITY_TIMEOUT').length,otherErrors:results.filter(x=>x.status==='rejected'&&x.reason?.code!=='STATE_DURABILITY_TIMEOUT').map(x=>x.reason?.code??'unknown'),actualScans:snapshot.readSharing?.startedReads??samples.reduce((n,s)=>n+s.scans,0),parserBytes:snapshot.readSharing?.scanBytes??samples.reduce((n,s)=>n+s.scanBytes,0),sharedRequests:snapshot.readSharing?.sharedRequests??0,readSharing:snapshot.readSharing??null}));
}else{
 const baseline=process.argv[2];if(!baseline)throw Error('baseline_source_root_required');
 const rounds=Number(process.argv[3]??2),output=process.argv[4];
 const dir=await mkdtemp(join(tmpdir(),'am-sharing-synthetic-')),fixture=join(dir,'fixture.bin'),results=[];
 try{
  const handle=await open(fixture,'w'),hash=createHash('sha256');let bytes=0;
  async function put(text){hash.update(text);bytes+=Buffer.byteLength(text);await handle.writeFile(text);}
  try{
   await put('{"a":1,"b":2');
   const payload=JSON.stringify({title:'synthetic',narrative:'가 synthetic \\"[{}]\\ tail '.repeat(1100),facts:['alpha','beta'],nested:{flag:true,count:17}});
   for(let i=0;bytes<220000000;i++)await put(',"pad'+i+'":'+payload);
   await put('}');
  }finally{await handle.close();}
  const fixtureHash=hash.digest('hex'),root=resolve(process.argv[5]??new URL('..',import.meta.url).pathname);
  const scenarios=['two-overlap','five-overlap','eight-overlap-stress','sequential','late-incompatible','replacement','mismatch'];
  for(let round=0;round<rounds;round++)for(const scenario of scenarios){
   const implementations=round%2?[['shared',root],['baseline13',resolve(baseline)]]:[['baseline13',resolve(baseline)],['shared',root]];
   for(const [implementation,source] of implementations){
    const work=await mkdtemp(join(dir,'case-'));await copyFile(fixture,join(work,'synthetic.bin'));if(scenario==='replacement')await writeFile(join(work,'next.bin'),'{"a":1,"b":2}');
    try{
     const result=await new Promise((resolve_,reject)=>{
      const child=spawn(process.execPath,[new URL(import.meta.url).pathname,'--child',source,work,scenario],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.on('error',reject);child.on('close',(code,signal)=>{if(code!==0||!stdout.trim())reject(Error('synthetic_child_failed:'+JSON.stringify({code,signal,stderr,stdout})));else {try{resolve_(JSON.parse(stdout));}catch(error){reject(error);}}});
     });results.push({round,implementation,fixtureBytes:bytes,...result});process.stderr.write(JSON.stringify({round,implementation,scenario,elapsedMs:result.elapsedMs,verified:result.verified,timeouts:result.timeouts,actualScans:result.actualScans})+'\n');
    }finally{await rm(work,{recursive:true,force:true});}
   }
  }
  const summary={synthetic:true,productionData:false,providerCalls:0,baselineSource:resolve(baseline),fixtureBytes:bytes,fixtureSha256:fixtureHash,rounds,results,limitations:['Synthetic JSON layout and page-cache conditions do not reproduce production data or establish operational speedups.','Physical disk bytes and engine cost are not measured; parserBytes are logical JSON prefix bytes.','Default certification deadline15000ms/poll100ms/capture concurrency4 unchanged.','Shared projection budget is serialized data only; baseline fallback and total RSS are not globally capped.']};
  if(output)await writeFile(output,JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary));
 }finally{await rm(dir,{recursive:true,force:true});}
}
