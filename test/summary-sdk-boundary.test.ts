import {it,expect} from 'vitest';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {readFileSync,appendFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
it('keeps real SDK transport alive for active projections over a namespace above its message cap',async()=>{
 const available=()=>Number(/^MemAvailable:\s+(\d+)/m.exec(readFileSync('/proc/meminfo','utf8'))?.[1]??0)*1024;
 // The child has a 512 MiB V8 heap and an independent 1 GiB RSS cap.
 // Reserve its full RSS budget plus 2 GiB host headroom, not a fixed 12 GiB.
 expect(available(),'isolated fixture requires 3 GiB available before starting').toBeGreaterThanOrEqual(3*1024**3);
 const root=await mkdtemp('/tmp/am-summary-sdk-');for(const d of ['tmp','config','data','cache'])await mkdir(join(root,d));
 await writeFile(join(root,'stdout.log'),'');await writeFile(join(root,'stderr.log'),'');
 const env={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:root,TMPDIR:join(root,'tmp'),XDG_CONFIG_HOME:join(root,'config'),XDG_DATA_HOME:join(root,'data'),XDG_CACHE_HOME:join(root,'cache'),LANG:'C.UTF-8',TZ:'UTC',OTEL_ENABLED:'false',CONSOLIDATION_ENABLED:'true',AGENTMEMORY_STATE_STORE_PATH:join(root,'state'),AM_SYNTHETIC_ROOT:root};
 let passed=false,stdout='',stderr='',stopRequested=false;
 const child=spawn(process.execPath,['--max-old-space-size=512','--import',resolve('node_modules/tsx/dist/loader.mjs'),resolve('test/fixtures/summary-sdk-boundary.mts')],{cwd:root,env,stdio:['pipe','pipe','pipe']});child.stdin.on('error',()=>{});
 const stop=()=>{if(!stopRequested){stopRequested=true;child.stdin.write('stop\n');}};
 child.stdout.on('data',b=>{if(stdout.length+b.length>2*1024*1024)stop();else{stdout+=b.toString();appendFileSync(join(root,'stdout.log'),b);}});child.stderr.on('data',b=>{if(stderr.length+b.length>2*1024*1024)stop();else{stderr+=b.toString();appendFileSync(join(root,'stderr.log'),b);}});
 const monitor=setInterval(()=>{if(available()<1024**3)stop();},250);
 const deadline=setTimeout(stop,120000);
 try{
  const code=await new Promise<number|null>((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});
  await writeFile(join(root,'stdout.log'),stdout);await writeFile(join(root,'stderr.log'),stderr);
  expect(code,'fixture evidence retained at '+root).toBe(0);expect(stopRequested).toBe(false);
  const line=stdout.split('\n').find(l=>l.startsWith('SYNTHETIC_RESULT '));expect(line).toBeDefined();const result=JSON.parse(line!.slice('SYNTHETIC_RESULT '.length));
  expect(result.old).toMatchObject({code:'TIMEOUT',summaryFullLists:1,closeCode:1009});
  expect(result.guarded).toMatchObject({code:'SUMMARY_COLLECTION_TOO_LARGE',summaryFullLists:0,closes:0,writeCompleted:true,connectionState:'connected'});
  expect(result.sourceBytes).toBeGreaterThan(64*1024*1024);
  expect(result.next).toMatchObject({semanticTotal:25,providerCalls:1,evictedStaleSessions:0,summaryFullLists:0,closes:0,connectionState:'connected',probeCompleted:true});
  expect(result.cleanup).toMatchObject({clientsStopped:true,serversClosed:true,portsReleased:true,syntheticStateRemoved:true,errors:[]});
  expect(result.maxRssKiB).toBeLessThan(1024*1024);passed=true;
 }finally{clearInterval(monitor);clearTimeout(deadline);child.stdin.end();if(passed)await rm(root,{recursive:true,force:true});}
},180000);
