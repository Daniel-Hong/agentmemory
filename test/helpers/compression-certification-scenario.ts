import {mkdtemp,open,rename,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StateKV,applyUpdateOps} from '../../src/state/kv.js';
import {KV} from '../../src/state/schema.js';
import {VectorIndex} from '../../src/state/vector-index.js';
import {IndexPersistence} from '../../src/state/index-persistence.js';
import {withKeyedLock} from '../../src/state/keyed-mutex.js';
import {MetricsStore} from '../../src/eval/metrics-store.js';
import {registerCompressFunction} from '../../src/functions/compress.js';
import * as search from '../../src/functions/search.js';
import {createStateDurabilityFence} from '../../src/ops/state-durability.mjs';
import {readNamespaceEntries} from '../../src/ops/namespace-reader.mjs';
import {serializeLongSessionProvider} from '../../src/ops/long-session.mjs';
import {registerEmbeddingRecovery,EMBEDDING_RETRY_NAMESPACE as RETRY,EMBEDDING_COMMITTED_NAMESPACE as COMMITTED} from '../../src/ops/embedding-recovery.mjs';

export interface CompressionCertificationScenario {
  namespaceBytes?:number;
  itemCount?:number;
  inferenceMs?:number;
  publicationDelayMs?:number;
  timeoutMs?:number;
  foregroundWritesAtMs?:number[];
  recoveryAtMs?:number;
  recoveryItemCount?:number;
  firstCompressionPublicationDelayMs?:number;
  arrivalAnchor?:'scenario_start'|'first_compression_write';
  warmCaptureBudget?:boolean;
  recoveryFactory?:typeof registerEmbeddingRecovery;
  durabilityFactory?:typeof createStateDurabilityFence;
  compressFactory?:typeof registerCompressFunction;
}
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const xml='<type>command_run</type><title>Synthetic compressed command</title><facts><fact>Synthetic fixture</fact></facts><narrative>Synthetic bounded result.</narrative><concepts><concept>fixture</concept></concepts><files></files><importance>5</importance>';

// SDK replies precede atomic file publication. Queues are independent per scope,
// ordered within a scope, and hold snapshots of the accepted writes.
export async function runCompressionCertificationScenario(options:CompressionCertificationScenario={}) {
  const {namespaceBytes=256*1024,itemCount=2,inferenceMs=5,publicationDelayMs=0,timeoutMs=1000,
    foregroundWritesAtMs=[],recoveryAtMs,recoveryItemCount=1,firstCompressionPublicationDelayMs=0,arrivalAnchor='scenario_start',
    warmCaptureBudget=false,recoveryFactory=registerEmbeddingRecovery,durabilityFactory=createStateDurabilityFence,compressFactory=registerCompressFunction}=options;
  if(namespaceBytes<1024||namespaceBytes>260_000_000||itemCount<1||itemCount>5||recoveryItemCount<1||recoveryItemCount>4||firstCompressionPublicationDelayMs<0||firstCompressionPublicationDelayMs>18000||foregroundWritesAtMs.length>5||[...foregroundWritesAtMs,...(recoveryAtMs===undefined?[]:[recoveryAtMs])].some(n=>!Number.isInteger(n)||n<0||n>8000))throw Error('synthetic_scenario_bounds');
  const directory=await mkdtemp(join(tmpdir(),'am-compression-first-'));
  const scope=KV.observations('synthetic-first-certification');
  const rows=new Map<string,Map<string,any>>(),publications=new Map<string,Promise<void>>();
  const sourcePublicationEvents:Record<string,unknown>[]=[],taskEvents:Record<string,unknown>[]=[];
  const file=(s:string)=>join(directory,encodeURIComponent(s)+'.bin');
  let sdkGets=0,namespacePublishes=0,publicationFailures=0;
  let firstCompressionWriteAtMs:number|null=null,sourcePublishAfter=0;
  let onFirstCompressionWrite=()=>{};
  async function writeNamespace(s:string,snapshot:Map<string,any>) {
    const target=file(s),temporary=target+'.next',handle=await open(temporary,'w');
    try {
      let buffer='{',first=true;
      for(const [key,value]of snapshot){buffer+=(first?'':',')+JSON.stringify(key)+':'+JSON.stringify(value);first=false;
        if(buffer.length>=1024*1024){await handle.writeFile(buffer);buffer='';}}
      await handle.writeFile(buffer+'}');
    }finally{await handle.close();}
    await rename(temporary,target);if(s===scope)namespacePublishes++;
  }
  function publish(s:string) {
    const snapshot=new Map(rows.get(s)??[]);
    const queuedAtMs=began?performance.now()-began:null;
    const task=(publications.get(s)??Promise.resolve()).then(async()=>{
      await pause(publicationDelayMs);if(s===scope&&sourcePublishAfter>performance.now())await pause(sourcePublishAfter-performance.now());
      const startedAtMs=performance.now()-began;await writeNamespace(s,snapshot);
      if(s===scope&&sourcePublicationEvents.length<16)sourcePublicationEvents.push({queuedAtMs,startedAtMs,finishedAtMs:performance.now()-began});
    });
    task.catch(()=>publicationFailures++);publications.set(s,task);
  }
  const handlers=new Map<string,(payload:any)=>Promise<any>>();
  const sdk={registerFunction:(id:string,handler:(payload:any)=>Promise<any>)=>handlers.set(id,handler),trigger:async(input:any)=>{
    const {function_id:id,payload:p}=input;
    if(id==='state::get'){sdkGets++;return rows.get(p.scope)?.get(p.key)??null;}
    if(id==='state::list')return [...rows.get(p.scope)?.values()??[]];
    if(id==='state::set'){
      if(p.scope===scope&&p.key==='target-0'&&p.value.llmCompressionRevision!==undefined&&firstCompressionWriteAtMs===null){firstCompressionWriteAtMs=performance.now()-began;sourcePublishAfter=performance.now()+firstCompressionPublicationDelayMs;onFirstCompressionWrite();}
      if(!rows.has(p.scope))rows.set(p.scope,new Map());rows.get(p.scope)!.set(p.key,JSON.parse(JSON.stringify(p.value)));publish(p.scope);return p.value;
    }
    if(id==='state::delete'){const found=rows.get(p.scope)?.delete(p.key);publish(p.scope);return found;}
    if(id==='state::update'){
      const old=rows.get(p.scope)?.get(p.key)??null,next=applyUpdateOps(old,p.ops);
      if(!rows.has(p.scope))rows.set(p.scope,new Map());rows.get(p.scope)!.set(p.key,next);publish(p.scope);return{old_value:old,new_value:next,errors:[]};
    }
    return handlers.has(id)?handlers.get(id)!(p):null;
  }};
  const previousPath=process.env.AGENTMEMORY_STATE_STORE_PATH;
  process.env.AGENTMEMORY_STATE_STORE_PATH=directory;
  const durability=durabilityFactory({storePath:directory,timeoutMs,pollIntervalMs:5});
  const certificateEvents:Record<string,unknown>[]=[];
  const waitForKeys=durability.waitForKeys,waitForKeyGroups=durability.waitForKeyGroups;
  const role=(selection:any[])=>selection.some(row=>row.scope===scope)?'source_intent':selection.some(row=>row.scope===COMMITTED)?'committed_marker':'index_publication';
  durability.waitForKeys=async(...args:any[])=>{
    const started=performance.now(),event:Record<string,unknown>={kind:role(args[1]),keys:args[1].length,startedAtMs:started-began};
    try{const result=await waitForKeys(...args);Object.assign(event,{outcome:'verified'});return result;}
    catch(error:any){Object.assign(event,{outcome:'failed',code:error?.code??null,stage:error?.diagnostics?.stage??null,cause:error?.diagnostics?.errorCode??null});throw error;}
    finally{event.elapsedMs=performance.now()-started;if(certificateEvents.length<64)certificateEvents.push(event);}
  };
  durability.waitForKeyGroups=async(...args:any[])=>{
    const started=performance.now();try{const result=await waitForKeyGroups(...args);if(certificateEvents.length<64)certificateEvents.push({kind:'source_intent_group',pairs:args[1].length,startedAtMs:started-began,elapsedMs:performance.now()-started,outcomes:result.map((row:any)=>row.status)});return result;}
    catch(error){throw error;}
  };
  const kv=new StateKV(sdk as never,{backend:'file',durability}),index=new VectorIndex();
  const persistence=new IndexPersistence(kv,index);persistence.stop();
  let inferenceActive=0,inferencePeak=0,compressionCalls=0,embeddingCalls=0;
  const inferenceEvents:{kind:string;phase:string;atMs:number}[]=[];
  let began=0;
  async function infer<T>(kind:string,value:T) {
    inferencePeak=Math.max(inferencePeak,++inferenceActive);inferenceEvents.push({kind,phase:'start',atMs:performance.now()-began});
    try{await pause(inferenceMs);return value;}finally{inferenceActive--;inferenceEvents.push({kind,phase:'end',atMs:performance.now()-began});}
  }
  const provider=serializeLongSessionProvider({name:'synthetic',dimensions:2,
    compress:async()=>{compressionCalls++;return infer('compress',xml);},summarize:async()=>{throw Error('unexpected_synthetic_summary');},
    embed:async()=>{embeddingCalls++;return infer('embed',new Float32Array([1,0]));}},withKeyedLock);
  const worker=recoveryFactory({kv,KV,index,provider,withKeyedLock,schedule:false,persistIndex:publication=>persistence.saveVerified(publication)});
  const metrics=new MetricsStore(kv);
  search.setVectorIndex(index);search.setEmbeddingProvider(provider);search.setEmbeddingRecovery(worker);search.setIndexPersistence(null);
  compressFactory(sdk as never,kv,provider,metrics);
  const tasks:Promise<unknown>[]=[],timers:ReturnType<typeof setTimeout>[]=[];
  const errors:string[]=[];
  try {
    const observations=new Map<string,any>(),fillerText='x'.repeat(17_500);
    const fixed={sessionId:'synthetic-first-certification',timestamp:'2026-10-22T00:00:00Z',type:'command_run',title:'Synthetic filler',facts:[],concepts:[],files:[],narrative:'Retained synthetic source.'};
    let estimated=2;
    for(let n=0;estimated<namespaceBytes;n++){
      const key='filler-'+n,row={...fixed,id:key,sourceRaw:{hookType:'post_tool_use',toolOutput:fillerText}};
      observations.set(key,row);estimated+=Buffer.byteLength(JSON.stringify(key)+':'+JSON.stringify(row))+1;
    }
    const raw={id:'source',sessionId:fixed.sessionId,hookType:'post_tool_use',toolName:'synthetic',toolInput:{},toolOutput:'Synthetic original retained.',timestamp:fixed.timestamp,raw:{}};
    for(let n=0;n<itemCount;n++)observations.set('target-'+n,{...fixed,id:'target-'+n,sourceRaw:raw});
    observations.set('foreground',{...fixed,id:'foreground',sourceRaw:{hookType:'post_tool_use',toolOutput:'Synthetic writer original'}});
    if(recoveryAtMs!==undefined)for(let n=0;n<recoveryItemCount;n++)observations.set('recovery-'+n,{...fixed,id:'recovery-'+n,sourceRaw:raw});
    rows.set(scope,observations);
    if(recoveryAtMs!==undefined)rows.set(RETRY,new Map(Array.from({length:recoveryItemCount},(_,n)=>['recovery-'+n,{id:'recovery-'+n,sessionId:fixed.sessionId,kind:'synthetic',attempts:0}])));
    await writeNamespace(scope,observations);
    if(rows.has(RETRY))await writeNamespace(RETRY,rows.get(RETRY)!);
    const initialNamespaceBytes=(await stat(file(scope))).size;
    const warmupStarted=performance.now();if(warmCaptureBudget)await kv.observationReader!.captureSummary(scope,'target-0');const warmupMs=performance.now()-warmupStarted;
    function later(kind:string,at:number,fn:()=>Promise<unknown>){tasks.push(new Promise<void>(resolve=>{timers.push(setTimeout(()=>{
      const event:Record<string,unknown>={kind,arrivalAnchor,requestedAtMs:at,startedAtMs:performance.now()-began};taskEvents.push(event);
      void fn().then(()=>{event.outcome='completed';},error=>{event.outcome='failed';errors.push(error?.code??error?.message??'synthetic_task_failed');}).finally(()=>{event.finishedAtMs=performance.now()-began;resolve();});
    },at));}));}
    began=performance.now();const cpu=process.cpuUsage(),initialReads=durability.snapshot().readSharing;
    const scheduleArrivals=()=>{
      foregroundWritesAtMs.forEach((at,n)=>later('foreground',at,async()=>{const row=await kv.get<any>(scope,'foreground');await kv.set(scope,'foreground',{...row,narrative:'Synthetic writer '+n});}));
      if(recoveryAtMs!==undefined)later('recovery',recoveryAtMs,()=>worker.pump());
    };
    if(arrivalAnchor==='scenario_start')scheduleArrivals();else onFirstCompressionWrite=scheduleArrivals;
    const outcomes:{success:boolean;elapsedMs:number;revisionWritten:boolean;retained:boolean;diagnosticCategory:unknown}[]=[];
    // This deliberately matches enrichment: do not submit the next compress
    // until the previous complete compress handler has returned.
    for(let n=0;n<itemCount;n++){
      const start=performance.now(),result:any=await sdk.trigger({function_id:'mem::compress',payload:{sessionId:fixed.sessionId,observationId:'target-'+n,raw:{...raw,id:'target-'+n}}});
      const stored=await kv.get<any>(scope,'target-'+n);
      outcomes.push({success:result?.success===true,elapsedMs:performance.now()-start,revisionWritten:stored?.llmCompressionRevision!==undefined,retained:result?.retained===true,diagnosticCategory:result?.diagnostics?.category??null});
    }
    await Promise.all(tasks);await worker.drain();
    await Promise.all([...publications.values()]);
    const elapsedMs=performance.now()-began,cpuUsed=process.cpuUsage(cpu),reads=durability.snapshot().readSharing;
    const selected=await readNamespaceEntries(file(scope),{keys:new Set(Array.from({length:itemCount},(_,n)=>'target-'+n))});
    const committedDisk=await readNamespaceEntries(file(COMMITTED),{keys:new Set(Array.from({length:itemCount},(_,n)=>'target-'+n))}).catch(error=>{if(error.code==='ENOENT')return{values:new Map()};throw error;});
    return{scenario:{namespaceBytes,itemCount,inferenceMs,publicationDelayMs,timeoutMs,foregroundWritesAtMs,recoveryAtMs,recoveryItemCount,firstCompressionPublicationDelayMs,arrivalAnchor,warmCaptureBudget},warmupMs,firstCompressionWriteAtMs,initialNamespaceBytes,elapsedMs,cpuMs:(cpuUsed.user+cpuUsed.system)/1000,
      inferencePeak,compressionCalls,embeddingCalls,inferenceEvents,outcomes,sdkGets,certificateEvents,
      durabilityReads:{physicalReads:reads.startedReads-initialReads.startedReads,scanBytes:reads.scanBytes-initialReads.scanBytes,sharedRequests:reads.sharedRequests-initialReads.sharedRequests},
      namespacePublishes,publicationFailures,sourcePublicationEvents,taskEvents,taskErrors:errors,metrics:await metrics.get('mem::compress'),
      originalSourcesPreserved:[...selected.values.values()].every((row:any)=>row?.sourceRaw?.toolOutput===raw.toolOutput),
      diskCompressedTargets:[...selected.values.values()].filter((row:any)=>row.llmCompressionRevision!==undefined).length,
      pendingTargets:(await kv.list<any>(RETRY)).filter(row=>row.id.startsWith('target-')).length,
      committedTargets:committedDisk.values.size,measurementCoverage:durability.snapshot().measurements,
      limitations:['Synthetic SDK, no actual engine or LLM; filesystem namespace publication is serialized per scope.','Sequential compression arrival; only explicit foreground/recovery tasks overlap.','Wall/CPU includes compression list/budget and drain; sharing byte counters exclude those direct list reads.','No capture/outbox/session-end route is invoked; no claim of delivery or warning resolution.']};
  }finally{
    await Promise.allSettled(tasks);timers.forEach(clearTimeout);worker.stop();await worker.drain();persistence.stop();await Promise.allSettled([...publications.values()]);
    search.setEmbeddingRecovery(null);search.setEmbeddingProvider(null);search.setVectorIndex(null);search.setIndexPersistence(null);search.getSearchIndex().clear();
    if(previousPath===undefined)delete process.env.AGENTMEMORY_STATE_STORE_PATH;else process.env.AGENTMEMORY_STATE_STORE_PATH=previousPath;
    await rm(directory,{recursive:true,force:true});
  }
}
