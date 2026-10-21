import {mkdtemp,mkdir,open,writeFile,copyFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join,resolve,dirname} from 'node:path';import {pathToFileURL} from 'node:url';import {createRequire} from 'node:module';import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url),ts=require('typescript');
const root=resolve(new URL('..',import.meta.url).pathname),baseline=resolve(process.argv[2]??'');
if(!process.argv[2])throw Error('Provide a frozen baseline namespace-reader.mjs');
if(createHash('sha256').update(await readFile(baseline)).digest('hex')!=='c0d7f7e4ff1f8670e54664d4e38761d2ae1b3845b39279b93aa7533307c01d35')throw Error('BASELINE_IS_NOT_FROZEN_DANIEL16_READER');
const temp=await mkdtemp(join(tmpdir(),'am-receipt-budget-'));
const priorFetch=globalThis.fetch,priorEnv={...process.env};
async function put(path,bytes){await mkdir(dirname(path),{recursive:true});await writeFile(path,bytes);}
try{
 await put(join(temp,'package.json'),'{"type":"module"}');
 for(const name of ['capture/receipts','capture/event-record','capture/receipt-digest','state/schema','state/cjk-segmenter','state/keyed-mutex','functions/privacy']){
  const text=await readFile(join(root,'src',name+'.ts'),'utf8');const code=ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;await put(join(temp,'src',name+'.js'),code);
 }
 const {registerCaptureReceipts}=await import(pathToFileURL(join(temp,'src/capture/receipts.js')));
 const {KV}=await import(pathToFileURL(join(temp,'src/state/schema.js')));
 const {captureEventScope}=await import(pathToFileURL(join(temp,'src/capture/event-record.js')));
 process.env.AGENTMEMORY_HOME=join(temp,'home');process.env.AGENTMEMORY_URL='http://127.0.0.1:45679';process.env.AGENTMEMORY_SECRET='synthetic-secret';process.env.AGENTMEMORY_CAPTURE_DRAIN_CHILD='1';process.env.AGENTMEMORY_CAPTURE_SPOOL_DIR=join(temp,'managed');
 const clientDir=join(temp,'client');await mkdir(clientDir);
 await copyFile(join(root,'plugin/scripts/codex-compat/_capture.mjs'),join(clientDir,'_capture.mjs'));
 await copyFile(join(root,'integrations/codex-compat/long-session-hook-client.mjs'),join(clientDir,'long-session-hook-client.mjs'));
 const {HookClient}=await import(pathToFileURL(join(clientDir,'long-session-hook-client.mjs')));
 const body={project:'synthetic-project',sessionId:'synthetic-session',eventId:'synthetic-event',hookType:'post_tool_use',timestamp:'2026-10-21T00:00:00Z',cwd:'/synthetic',data:{tool_output:'synthetic '.repeat(560000)}};
 const key='cap_'+createHash('sha256').update(`${body.project}\0${body.sessionId}\0${body.eventId}`).digest('hex').slice(0,40);
 const obs={id:'obs_synthetic',sessionId:body.sessionId,captureKey:key,sourceRaw:{id:'obs_synthetic',sessionId:body.sessionId,captureKey:key,eventId:body.eventId,hookType:body.hookType,timestamp:body.timestamp,raw:body.data}};
 const done={key,eventId:body.eventId,sessionId:body.sessionId,project:body.project,observationId:obs.id,acceptedAt:body.timestamp,completedAt:body.timestamp,attempts:1};
 const pad={synthetic:true,nested:{vector:Array.from({length:512},(_,i)=>Math.sin(i)/17),text:'한 😀 escaped "\\ \n'.repeat(300)}};
 const fixture=join(temp,'fixture.bin'),handle=await open(fixture,'wx');let fixtureBytes=0,entries=1;
 async function append(s){await handle.writeFile(s);fixtureBytes+=Buffer.byteLength(s);}
 try{await append('{'+JSON.stringify(obs.id)+':'+JSON.stringify(obs));while(fixtureBytes<220000000)await append(',"pad_'+entries+++'":'+JSON.stringify(pad));await append('}');await handle.writeFile(Buffer.from([255,0,123]));}finally{await handle.close();}
 const results=[];
 for(let round=0;round<2;round++)for(const [label,reader] of (round%2?[['candidate',join(root,'src/ops/namespace-reader.mjs')],['baseline',baseline]]:[['baseline',baseline],['candidate',join(root,'src/ops/namespace-reader.mjs')]])){
  const dir=join(temp,label+'-'+round),ops=join(dir,'ops');await mkdir(ops,{recursive:true});
  for(const name of ['state-durability.mjs','shared-namespace-reader.mjs','durability-measurement.mjs'])await copyFile(join(root,'src/ops',name),join(ops,name));await copyFile(reader,join(ops,'namespace-reader.mjs'));
  const {createStateDurabilityFence}=await import(pathToFileURL(join(ops,'state-durability.mjs')));
  const store=join(dir,'store');await mkdir(store);const observationScope=KV.observations(body.sessionId),backgroundScope=KV.observations('synthetic-background');
  for(const scope of [observationScope,backgroundScope])await copyFile(fixture,join(store,encodeURIComponent(scope)+'.bin'));
  await put(join(store,encodeURIComponent(captureEventScope(key))+'.bin'),JSON.stringify({[key]:done}));
  const durability=createStateDurabilityFence({storePath:store});
  const kv={durability,get:async(scope,k)=>scope===captureEventScope(key)?done:k===obs.id?obs:pad};
  const fns=new Map();registerCaptureReceipts({registerFunction:(id,fn)=>fns.set(id,fn)},kv);
  const trace=[];const begin=performance.now();let posts=0;
  globalThis.fetch=async(input,options={})=>{
   const url=new URL(String(input));if(options.method!=='GET'){posts++;throw Error('Unexpected synthetic resend');}
   const t=performance.now(),query={key:url.searchParams.get('key'),digest:url.searchParams.get('digest'),budgetMs:Number(url.searchParams.get('budgetMs'))};
   if(url.pathname!=='/agentmemory/capture/receipts')throw Error('Unexpected synthetic route');
   const request=fns.get('mem::capture-receipt')(query).then(result=>{trace.push({stage:'pre_handoff_receipt',requestedBudgetMs:query.budgetMs,elapsedMs:performance.now()-t,state:result.state,durable:result.durable});return new Response(JSON.stringify(result),{status:200});});
   let abort;try{options.signal?.throwIfAborted();return await Promise.race([request,new Promise((_,reject)=>{abort=()=>reject(options.signal.reason);options.signal?.addEventListener('abort',abort,{once:true});})]);}
   finally{if(abort)options.signal?.removeEventListener('abort',abort);}
  };
  const outbox=join(dir,'outbox');const client=new HookClient({url:'http://127.0.0.1:45679',dir:outbox,timeoutMs:5000,secret:'synthetic-secret'});await client.enqueue('/agentmemory/observe',body);
  const background=durability.waitForKeys(kv,[{scope:backgroundScope,key:'pad_1'}]);
  const flushed=await client.flush({limit:1,budgetMs:15000});const callerElapsedMs=performance.now()-begin;const backgroundResult=await Promise.allSettled([background]);await durability.drain();
  const snapshot=durability.snapshot(),remaining=(await readdir(outbox)).filter(n=>n.endsWith('.json')).length;
  const row={round,label,fixtureBytes,entries,clientBudgetMs:5000,serverFenceDefaultMs:15000,callerElapsedMs,flushed,remainingOriginalRecords:remaining,posts,backgroundVerified:backgroundResult[0].status==='fulfilled',trace,reader:snapshot.readSharing,certificates:snapshot.measurements.recent,readerSha256:createHash('sha256').update(await readFile(reader)).digest('hex')};results.push(row);console.log(JSON.stringify(row));
 }
 if(process.argv.includes('--assert-release')){if(results.some(r=>r.remainingOriginalRecords!==(r.label==='baseline'?1:0)))throw Error('SYNTHETIC_EXPECTED_BASELINE_RETAIN_AND_CANDIDATE_RELEASE');}
 console.log(JSON.stringify({synthetic:true,productionData:false,modelCalls:0,realNetworkRequests:0,transport:'in-process adapter with AbortSignal, real file parsing/fsync; mocked SDK get, no real engine or HTTP',alternatingRounds:2,results}));
}finally{globalThis.fetch=priorFetch;for(const key of Object.keys(process.env))if(!(key in priorEnv))delete process.env[key];Object.assign(process.env,priorEnv);await rm(temp,{recursive:true,force:true});}
