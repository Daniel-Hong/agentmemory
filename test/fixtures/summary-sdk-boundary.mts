import {createRequire} from 'node:module';
import {open,stat,readFile,rm,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
const root=resolve(process.env.AM_SYNTHETIC_ROOT??'');let rootVerified=false,state:string|undefined,WebSocketServer:any,registerWorker:any,StateKV:any,registerConsolidationPipelineFunction:any,registerEvictFunction:any;
const require=createRequire(new URL('../../node_modules/iii-sdk/dist/index.mjs',import.meta.url));const net=require('node:net');
const clients:any[]=[],servers:any[]=[],ports:number[]=[],active=new Set<Promise<unknown>>();const result:any={sdk:'0.25.0',engine:'synthetic WebSocket protocol server, no installed/operating engine'};
const started=performance.now(),events:any[]=[];let maxRss=0,lastSample=0,stopRequested=false;process.stdin.on('data',()=>{stopRequested=true;});
function budget(stage:string){
 const u=process.resourceUsage(),now=performance.now(),rss=process.memoryUsage().rss;maxRss=Math.max(maxRss,rss);
 if(stage!=='read_chunk'||now-lastSample>=250){events.push({stage,elapsedMs:Math.round(now-started),rss,cpuMs:(u.userCPUTime+u.systemCPUTime)/1000});if(events.length>64)events.shift();lastSample=now;}
 assert(!stopRequested,'fixture_monitor_stop');assert(now-started<120000,'fixture_time_limit');assert(maxRss<1024**3,'fixture_rss_limit');assert((u.userCPUTime+u.systemCPUTime)/1000<20000,'fixture_cpu_limit');
}
async function server(mode:string){
 const s=new WebSocketServer({host:'127.0.0.1',port:0,maxPayload:1024*1024});servers.push(s);await new Promise((r,j)=>{s.once('listening',r);s.once('error',j);});const port=s.address().port;ports.push(port);
 const stats={summaryFullLists:0,connections:0,closes:0,closeCode:null as number|null,invocations:0};const data=new Map<string,any>();
 s.on('connection',(socket:any)=>{stats.connections++;socket.on('error',()=>{});socket.on('close',(c:number)=>{stats.closes++;stats.closeCode=c;});socket.on('message',(buffer:Buffer)=>{
  const x=JSON.parse(buffer.toString());if(x.type==='invocationresult'){socket.send(JSON.stringify(x));return;}if(x.type!=='invokefunction')return;stats.invocations++;const p=x.data??{};
  if(x.function_id==='state::list'&&p.scope==='mem:summaries'){stats.summaryFullLists++;const h=Buffer.alloc(10);h[0]=0x81;h[1]=127;h.writeBigUInt64BE(BigInt(64*1024*1024+1),2);socket._socket.write(h);return;}
  if(x.function_id.startsWith('mem::')){socket.send(JSON.stringify({...x,action:undefined}));return;}
  let value:any=null;const key=p.scope+'/'+p.key;
  if(x.function_id==='state::get')value=data.get(key)??null;
  else if(x.function_id==='state::set'){value={old_value:data.get(key)??null,new_value:p.value};data.set(key,p.value);}
  else if(x.function_id==='state::list')value=p.scope==='mem:sessions'?[{id:'synthetic_s24',project:'synthetic',cwd:'/synthetic',startedAt:'2020-01-01T00:00:00Z',status:'completed',observationCount:0}]:[];
  else if(x.function_id==='state::delete'){value={old_value:data.get(key)??null};data.delete(key);}
  else{socket.send(JSON.stringify({type:'invocationresult',invocation_id:x.invocation_id,error:{code:'unexpected_synthetic_function',message:'fixture refused unsupported function'}}));return;}
  socket.send(JSON.stringify({type:'invocationresult',invocation_id:x.invocation_id,result:value}));
 });});return {s,port,stats};
}
try{
assert(root.startsWith('/tmp/am-summary-sdk-'));assert.equal(process.env.HOME,root);assert.equal(resolve(process.env.AGENTMEMORY_STATE_STORE_PATH??''),join(root,'state'));assert.equal(resolve(process.cwd()),root);for(const name of ['AGENTMEMORY_ENV_FILE','AGENTMEMORY_DATA_DIR','III_TOKEN','OPENAI_API_KEY','ANTHROPIC_API_KEY'])assert.equal(process.env[name],undefined,'unexpected_env_override_'+name);rootVerified=true;({WebSocketServer}=require('ws'));
({registerWorker}=await import('../../node_modules/iii-sdk/dist/index.mjs'));
({StateKV}=await import('../../src/state/kv.ts'));
({registerConsolidationPipelineFunction}=await import('../../src/functions/consolidation-pipeline.ts'));
({registerEvictFunction}=await import('../../src/functions/evict.ts'));
state=join(root,'state');await mkdir(state);const path=join(state,encodeURIComponent('mem:summaries')+'.bin');
const row=(i:number)=>({sessionId:'synthetic_s'+i,createdAt:new Date(1700000000000+i*1000).toISOString(),title:'synthetic title'+i,narrative:'synthetic narrative'+i,concepts:['synthetic'],sourceProjectionSnapshots:{}});
const sample=JSON.stringify(row(24));assert.equal(JSON.parse(sample.slice(0,-3)+'{"sourceOriginal":"xxxxxxxx"}}').sourceProjectionSnapshots.sourceOriginal,'xxxxxxxx');
budget('seed_begin');const file=await open(path,'wx',0o600);try{await file.write('{');for(let i=0;i<25;i++){if(i)await file.write(',');const r=row(i);let text=JSON.stringify(r);if(i!==24)await file.write(JSON.stringify('key'+i)+':'+text);else{const prefix=text.slice(0,-3);await file.write(JSON.stringify('key'+i)+':'+prefix+'{"sourceOriginal":"');const block='x'.repeat(64*1024);for(let n=0;n<1056;n++){if(n%64===0)budget('seed_chunk');await file.write(block);}await file.write('"}}');}}await file.write('}');await file.sync();}finally{await file.close();}
const bytes=(await stat(path)).size;assert(bytes>64*1024*1024&&bytes<100*1024*1024);budget('seed_complete');
result.sourceBytes=bytes;result.preparedMs=Math.round(performance.now()-started);
const source=await readFile(new URL('../../node_modules/iii-sdk/dist/index.mjs',import.meta.url),'utf8');assert(source.includes('const MAX_JSON_MESSAGE_BYTES = 64 * 1024 * 1024;'));

 const old=await server('old');const sdk=registerWorker('ws://127.0.0.1:'+old.port,{workerName:'synthetic-old',enableMetricsReporting:false,otel:{enabled:false},reconnectionConfig:{maxRetries:0},invocationTimeoutMs:300});clients.push(sdk);
 let oldCode='unexpected_success';try{await new StateKV(sdk).list('mem:summaries');}catch(e:any){oldCode=e.code??e.constructor.name;}await sdk.shutdown();assert.equal(oldCode,'TIMEOUT');assert.equal(old.stats.summaryFullLists,1);assert.equal(old.stats.closeCode,1009);result.old={code:oldCode,...old.stats};budget('old_failure_proven');
 const next=await server('new');const current=registerWorker('ws://127.0.0.1:'+next.port,{workerName:'synthetic-new',enableMetricsReporting:false,otel:{enabled:false},reconnectionConfig:{maxRetries:0},invocationTimeoutMs:15000});clients.push(current);const kv=new StateKV(current);const fence=kv.durability as any;const originalBulk=fence.withBulkRead;fence.withBulkRead=(work:any,options:any)=>originalBulk(async()=>{budget('read_chunk');const value=await work();budget('read_chunk');return value;},options);
 const tracked=new Proxy(current,{get(target,prop){if(prop==='registerFunction')return(id:any,fn:any,...rest:any[])=>target.registerFunction(id,async(...args:any[])=>{const p=Promise.resolve().then(()=>fn(...args));active.add(p);try{return await p;}finally{active.delete(p);}},...rest);const v=Reflect.get(target,prop,target);return typeof v==='function'?v.bind(target):v;}});
 let providerCalls=0;registerConsolidationPipelineFunction(tracked,kv,{name:'synthetic',summarize:async()=>{providerCalls++;return '<facts></facts>';}} as never);registerEvictFunction(tracked,kv);
 const begin=performance.now();const merge:any=await current.trigger({function_id:'mem::consolidate-pipeline',payload:{tier:'semantic'},dispatch:'remote'});assert.equal(merge.success,true);assert.equal(merge.results.semantic.totalSummaries,25);assert.equal(providerCalls,1);budget('consolidation_complete');
 const evict:any=await current.trigger({function_id:'mem::evict',payload:{dryRun:true},dispatch:'remote'});assert.equal(evict.staleSessions,0);budget('eviction_complete');
 assert.equal(await kv.countSummaries(),25);const probe=await current.trigger({function_id:'state::get',payload:{scope:'mem:config',key:'synthetic_liveness'}});assert.equal(probe,null);assert.equal(next.stats.summaryFullLists,0);assert.equal(next.stats.closes,0);assert.equal(current.getConnectionState(),'connected');
 result.next={semanticTotal:merge.results.semantic.totalSummaries,providerCalls,protectedStaleSessions:1,evictedStaleSessions:evict.staleSessions,...next.stats,connectionState:current.getConnectionState(),probeCompleted:true,elapsedMs:Math.round(performance.now()-begin)};budget('new_queries_proven');
}catch(error:any){result.failure={stage:events.at(-1)?.stage??'preflight',name:error?.constructor?.name,code:error?.code??null,message:String(error?.message??'').slice(0,300)};process.exitCode=1;
}finally{
 const cleanupErrors:string[]=[];while(active.size)await Promise.allSettled([...active]);
 for(const c of clients)try{await c.shutdown();}catch{cleanupErrors.push('sdk_shutdown_failed');}
 for(const server of servers)await new Promise<void>(r=>server.close((error:any)=>{if(error)cleanupErrors.push('server_close_failed');r();}));
 let portsReleased=true;for(const port of ports){const probe=net.createServer();await new Promise<void>(r=>{probe.once('error',()=>{portsReleased=false;r();});probe.listen(port,'127.0.0.1',()=>probe.close(()=>r()));});}
 let removed=false;if(rootVerified&&state&&cleanupErrors.length===0&&portsReleased){await rm(state,{recursive:true,force:true});removed=true;}
 result.cleanup={clientsStopped:cleanupErrors.length===0,serversClosed:cleanupErrors.length===0,portsReleased,syntheticStateRemoved:removed,errors:cleanupErrors};result.events=events;result.elapsedMs=Math.round(performance.now()-started);result.maxObservedRss=maxRss;result.maxRssKiB=process.resourceUsage().maxRSS;
 if(cleanupErrors.length||!portsReleased)process.exitCode=1;process.stdin.pause();console.log('SYNTHETIC_RESULT '+JSON.stringify(result));
}
