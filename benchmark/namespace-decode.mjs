import {mkdtemp,open,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
if(process.argv[2]==='--worker'){
  const {readNamespaceEntries}=await import(pathToFileURL(resolve(process.argv[3])).href);
  const began=performance.now(),cpu=process.cpuUsage();
  const result=await readNamespaceEntries(process.argv[4],{keys:new Set(['item_0'])});
  if(result.entries!==880||result.values.get('item_0')?.text.length!==262144)throw Error('synthetic_result_mismatch');
  const used=process.cpuUsage(cpu);
  console.log(JSON.stringify({ms:performance.now()-began,cpuMs:(used.user+used.system)/1000,bytesRead:result.bytesRead,entries:result.entries,maxRssKiB:process.resourceUsage().maxRSS}));
}else{
  if(!process.argv[2])throw Error('Provide the frozen baseline namespace-reader.mjs path');
  const directory=await mkdtemp(join(tmpdir(),'am-decode-220m-'));
  try{
    const path=join(directory,'synthetic.bin'),file=await open(path,'wx');
    const text='한😀'+ 'x'.repeat(262141);
    try{await file.write('{');for(let i=0;i<880;i++)await file.write((i?',':'')+JSON.stringify('item_'+i)+':'+JSON.stringify({n:i,text}));await file.write('}');await file.write(Buffer.from([255,0,123]));}finally{await file.close();}
    const readers={baseline:resolve(process.argv[2]),candidate:resolve('src/ops/namespace-reader.mjs')};
    const sourceHashes=Object.fromEntries(await Promise.all(Object.entries(readers).map(async([label,path])=>[label,createHash('sha256').update(await readFile(path)).digest('hex')])));
    const samples=[];
    for(let round=0;round<7;round++)for(const label of round%2?['candidate','baseline']:['baseline','candidate']){
      const child=spawnSync(process.execPath,[process.argv[1],'--worker',readers[label],path],{encoding:'utf8',timeout:60_000});
      if(child.status!==0)throw Error(child.stderr||'benchmark_child_failed');
      samples.push({label,round,warmup:round===0,...JSON.parse(child.stdout)});
    }
    const median=values=>{const s=values.sort((a,b)=>a-b);return(s[(s.length-1)>>1]+s[s.length>>1])/2;};
    const summary=Object.fromEntries(Object.keys(readers).map(label=>{const rows=samples.filter(s=>s.label===label&&!s.warmup);return[label,{medianMs:median(rows.map(s=>s.ms)),medianCpuMs:median(rows.map(s=>s.cpuMs)),bytesPerRead:rows[0].bytesRead,entries:rows[0].entries,maxRssKiB:Math.max(...rows.map(s=>s.maxRssKiB))}];}));
    console.log(JSON.stringify({synthetic:true,nodeVersion:process.version,sourceHashes,storage:'temporary file, sequential isolated child processes, alternating order; first pair warmup',samples,summary},null,2));
  }finally{await rm(directory,{recursive:true,force:true});}
}
