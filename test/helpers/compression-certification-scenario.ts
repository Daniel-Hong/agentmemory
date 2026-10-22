import {mkdtemp,open,rename,rm,stat,realpath,readdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
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
import {createStorageUnitAdapter,storageUnitFor} from './storage-unit-adapter.js';

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
  storageUnitCount?:1|16;
  writerPlacement?:'unrelated'|'same_shard'|'same_target';
  recoverPendingAtEnd?:boolean;
  // Injected isolated actual engine; lifecycle and temporary store remain caller-owned.
  realEngine?:{sdk:{trigger:(input:any)=>Promise<any>};storePath:string;prepareOnly?:boolean;reuseSyntheticSeed?:boolean;seedChecksums?:Record<string,string>};
}
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));

// Seed setup is outside the measured workload. Only transient publication races
// may retry; corruption, access errors and wrong checkpoint values are failures.
export async function waitForSyntheticSeedPublication(paths:string[],expectedCount:number,{
  read=readNamespaceEntries,timeoutMs=30000,clock=()=>performance.now(),wait=pause,
}:any={}) {
  const deadline=clock()+timeoutMs;
  let attempts=0;
  for(;;){
    attempts++;let count=0,stable=true;
    for(const path of paths)try{await read(path,{keys:new Set(),onEntry:()=>{count++;}});}
    catch(error:any){if(error.code==='ENOENT'||error.code==='state_namespace_changed')stable=false;else throw error;}
    if(stable&&count===expectedCount)return{attempts};
    if(clock()>=deadline)throw Error('actual_engine_seed_not_published');
    await wait(100);
  }
}

export async function verifySyntheticSeed(paths:{path:string;scope:string;expected:Map<string,any>}[],{
 read=readNamespaceEntries,checksum=async(path:string)=>{const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');},pinnedChecksums,
 allowMissing=false,
}:any={}){
 const sourceFiles=[];
 for(const {path,scope,expected}of paths){
  const seen=new Set<string>();
  try{await read(path,{keys:new Set(),onEntry:(key:string,value:any)=>{
   if(seen.has(key)||!expected.has(key)||!isDeepStrictEqual(expected.get(key),value))throw Error('synthetic_seed_content_mismatch');seen.add(key);
  }});}catch(error:any){if(error.code!=='ENOENT'||expected.size)throw error;}
  if(!allowMissing&&seen.size!==expected.size)throw Error('synthetic_seed_count_mismatch');
  if(!expected.size)continue;
  const sha256=await checksum(path);
  if(pinnedChecksums&&pinnedChecksums[scope]!==sha256)throw Error('synthetic_seed_checksum_mismatch');
  sourceFiles.push({scope,sha256,entries:seen.size,...(allowMissing?{missingKeys:[...expected.keys()].filter(key=>!seen.has(key))}:{})});
 }
 if(pinnedChecksums&&Object.keys(pinnedChecksums).length!==sourceFiles.length)throw Error('synthetic_seed_checksum_scope_mismatch');
 return sourceFiles;
}
const xml='<type>command_run</type><title>Synthetic compressed command</title><facts><fact>Synthetic fixture</fact></facts><narrative>Synthetic bounded result.</narrative><concepts><concept>fixture</concept></concepts><files></files><importance>5</importance>';

// SDK replies precede atomic file publication. Queues are independent per scope,
// ordered within a scope, and hold snapshots of the accepted writes.
export async function runCompressionCertificationScenario(options:CompressionCertificationScenario={}) {
  const {namespaceBytes=256*1024,itemCount=2,inferenceMs=5,publicationDelayMs=0,timeoutMs=1000,
    foregroundWritesAtMs=[],recoveryAtMs,recoveryItemCount=1,firstCompressionPublicationDelayMs=0,arrivalAnchor='scenario_start',
    warmCaptureBudget=false,recoveryFactory=registerEmbeddingRecovery,durabilityFactory=createStateDurabilityFence,compressFactory=registerCompressFunction,
    storageUnitCount=1,writerPlacement='unrelated',recoverPendingAtEnd=false,realEngine}=options;
  if(namespaceBytes<1024||namespaceBytes>260_000_000||itemCount<1||itemCount>5||![1,16].includes(storageUnitCount)||recoveryItemCount<1||recoveryItemCount>4||firstCompressionPublicationDelayMs<0||firstCompressionPublicationDelayMs>18000||foregroundWritesAtMs.length>5||[...foregroundWritesAtMs,...(recoveryAtMs===undefined?[]:[recoveryAtMs])].some(n=>!Number.isInteger(n)||n<0||n>13000))throw Error('synthetic_scenario_bounds');
  if(realEngine&&(publicationDelayMs!==0||firstCompressionPublicationDelayMs!==0))throw Error('actual_engine_cannot_simulate_publication');
  const directory=realEngine?await realpath(realEngine.storePath):await mkdtemp(join(tmpdir(),'am-compression-first-'));
  if(realEngine&&!directory.startsWith('/tmp/'))throw Error('actual_engine_requires_temporary_store');
  const scope=KV.observations('synthetic-first-certification');
  const sourceUnits=storageUnitCount===16?Array.from({length:16},(_,n)=>scope+':unit:'+n.toString(16).padStart(2,'0')):[scope];
  const sourceUnitSet=new Set(sourceUnits);
  const firstSourceUnit=storageUnitCount===16?sourceUnits[storageUnitFor('target-0')]!:scope;
  let foregroundKey='foreground';
  if(writerPlacement==='same_target')foregroundKey='target-0';
  if(writerPlacement==='same_shard')for(let n=0;;n++){const key='same-unit-peer-'+n;if(storageUnitFor(key)===storageUnitFor('target-0')){foregroundKey=key;break;}}
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
    await rename(temporary,target);if(sourceUnitSet.has(s))namespacePublishes++;
  }
  function publish(s:string) {
    const snapshot=new Map(rows.get(s)??[]);
    const queuedAtMs=began?performance.now()-began:null;
    const task=(publications.get(s)??Promise.resolve()).then(async()=>{
      await pause(publicationDelayMs);if(s===firstSourceUnit&&sourcePublishAfter>performance.now())await pause(sourcePublishAfter-performance.now());
      const startedAtMs=performance.now()-began;await writeNamespace(s,snapshot);
      if(sourceUnitSet.has(s)&&sourcePublicationEvents.length<16)sourcePublicationEvents.push({unit:sourceUnits.indexOf(s),queuedAtMs,startedAtMs,finishedAtMs:performance.now()-began});
    });
    task.catch(()=>publicationFailures++);publications.set(s,task);
  }
  const handlers=new Map<string,(payload:any)=>Promise<any>>();
  const sdk={registerFunction:(id:string,handler:(payload:any)=>Promise<any>)=>handlers.set(id,handler),trigger:async(input:any)=>{
    const {function_id:id,payload:p}=input;
    if(realEngine&&id.startsWith('state::')){
      if(id==='state::get')sdkGets++;
      if(id==='state::set'&&p.scope===firstSourceUnit&&p.key==='target-0'&&p.value.llmCompressionRevision!==undefined&&firstCompressionWriteAtMs===null){firstCompressionWriteAtMs=performance.now()-began;onFirstCompressionWrite();}
      return realEngine.sdk.trigger(input);
    }
    if(id==='state::get'){sdkGets++;return rows.get(p.scope)?.get(p.key)??null;}
    if(id==='state::list')return [...rows.get(p.scope)?.values()??[]];
    if(id==='state::set'){
      if(p.scope===firstSourceUnit&&p.key==='target-0'&&p.value.llmCompressionRevision!==undefined&&firstCompressionWriteAtMs===null){firstCompressionWriteAtMs=performance.now()-began;sourcePublishAfter=performance.now()+firstCompressionPublicationDelayMs;onFirstCompressionWrite();}
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
  const role=(selection:any[])=>selection.some(row=>sourceUnitSet.has(row.scope))?'source_intent':selection.some(row=>row.scope===COMMITTED||row.scope.startsWith(COMMITTED+':unit:'))?'committed_marker':'index_publication';
  const physicalSelection=(selection:any[])=>selection.map(row=>({family:sourceUnitSet.has(row.scope)?'source':row.scope===RETRY||row.scope.startsWith(RETRY+':unit:')?'retry':row.scope===COMMITTED||row.scope.startsWith(COMMITTED+':unit:')?'marker':'index',unit:sourceUnitSet.has(row.scope)?sourceUnits.indexOf(row.scope):storageUnitCount===16&&row.scope.includes(':unit:')?parseInt(row.scope.slice(-2),16):0}));
  durability.waitForKeys=async(...args:any[])=>{
    const started=performance.now(),event:Record<string,unknown>={kind:role(args[1]),keys:args[1].length,physicalSelection:physicalSelection(args[1]),startedAtMs:started-began};
    try{const result=await waitForKeys(...args);Object.assign(event,{outcome:'verified'});return result;}
    catch(error:any){Object.assign(event,{outcome:'failed',code:error?.code??null,stage:error?.diagnostics?.stage??null,cause:error?.diagnostics?.errorCode??null});throw error;}
    finally{event.elapsedMs=performance.now()-started;if(certificateEvents.length<64)certificateEvents.push(event);}
  };
  durability.waitForKeyGroups=async(...args:any[])=>{
    const started=performance.now();try{const result=await waitForKeyGroups(...args);if(certificateEvents.length<64)certificateEvents.push({kind:'source_intent_group',pairs:args[1].length,startedAtMs:started-began,elapsedMs:performance.now()-started,outcomes:result.map((row:any)=>row.status)});return result;}
    catch(error){throw error;}
  };
  const physicalKV=new StateKV(sdk as never,{backend:'file',durability});
  const storage=createStorageUnitAdapter(physicalKV,[scope,RETRY,COMMITTED],storageUnitCount),kv=storage.kv,index=new VectorIndex();
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
    if(writerPlacement!=='same_target')observations.set(foregroundKey,{...fixed,id:foregroundKey,sourceRaw:{hookType:'post_tool_use',toolOutput:'Synthetic writer original'}});
    if(recoveryAtMs!==undefined)for(let n=0;n<recoveryItemCount;n++)observations.set('recovery-'+n,{...fixed,id:'recovery-'+n,sourceRaw:raw});
    for(const unit of sourceUnits)rows.set(unit,new Map());
    for(const [key,row]of observations)rows.get(storage.route(scope,key))!.set(key,row);
    if(recoveryAtMs!==undefined)for(let n=0;n<recoveryItemCount;n++){const key='recovery-'+n,unit=storage.route(RETRY,key);if(!rows.has(unit))rows.set(unit,new Map());rows.get(unit)!.set(key,{id:key,sessionId:fixed.sessionId,kind:'synthetic',attempts:0});}
    const initializationStarted=performance.now();
    if(realEngine){
      const entries=[...rows].flatMap(([scope,data])=>[...data].map(([key,value])=>({scope,key,value})));
      if(realEngine.reuseSyntheticSeed&&!realEngine.seedChecksums)throw Error('synthetic_seed_checksums_required');
      if(!realEngine.reuseSyntheticSeed)for(let n=0;n<entries.length;n+=4)await Promise.all(entries.slice(n,n+4).map(payload=>realEngine.sdk.trigger({function_id:'state::set',payload})));
      // The engine publishes the files. Never construct or rename its state files.
      if(!(realEngine.prepareOnly&&realEngine.reuseSyntheticSeed))await waitForSyntheticSeedPublication(sourceUnits.filter(unit=>rows.get(unit)!.size>0).map(file),observations.size);
      const allowed=new Set(sourceUnits.map(unit=>encodeURIComponent(unit)+'.bin'));
      if((await readdir(directory)).some(name=>name.endsWith('.bin')&&!allowed.has(name)))throw Error('synthetic_seed_extra_namespace');
      const seedPaths=sourceUnits.map(scope=>({scope,path:file(scope),expected:rows.get(scope)!}));
      let sourceFiles=await verifySyntheticSeed(seedPaths,{pinnedChecksums:realEngine.reuseSyntheticSeed?realEngine.seedChecksums:undefined,allowMissing:!!(realEngine.prepareOnly&&realEngine.reuseSyntheticSeed)});
      const seedExpectedRows=observations.size,seedPresentRows=realEngine.reuseSyntheticSeed?sourceFiles.reduce((n,row)=>n+row.entries,0):0;
      let seedWrittenRows=realEngine.reuseSyntheticSeed?0:entries.length;
      if(realEngine.prepareOnly&&realEngine.reuseSyntheticSeed){
        const missing=sourceFiles.flatMap(row=>(row.missingKeys??[]).map((key:string)=>({scope:row.scope,key,value:rows.get(row.scope)!.get(key)})));
        for(let n=0;n<missing.length;n+=4)await Promise.all(missing.slice(n,n+4).map(payload=>realEngine.sdk.trigger({function_id:'state::set',payload})));
        seedWrittenRows=missing.length;
        await waitForSyntheticSeedPublication(sourceUnits.filter(unit=>rows.get(unit)!.size>0).map(file),observations.size);
        sourceFiles=await verifySyntheticSeed(seedPaths);
      }

      // Probe the actual engine state as well as its persisted files. Every
      // physical unit and target is represented, without returning row bodies.
      const probes=[...rows].filter(([unit,data])=>sourceUnitSet.has(unit)&&data.size).flatMap(([scope,data])=>{const entries=[...data];return[entries[0]!,entries.at(-1)!].map(([key,expected])=>({scope,key,expected}));});
      for(let n=0;n<itemCount;n++)probes.push({scope:storage.route(scope,'target-'+n),key:'target-'+n,expected:observations.get('target-'+n)});
      for(let n=0;n<probes.length;n+=4)await Promise.all(probes.slice(n,n+4).map(async row=>{if(!isDeepStrictEqual(await realEngine.sdk.trigger({function_id:'state::get',payload:{scope:row.scope,key:row.key}}),row.expected))throw Error('synthetic_seed_sdk_mismatch');}));
      const last=[...rows].filter(([unit,data])=>sourceUnitSet.has(unit)&&data.size).map(([scope,data])=>{const [key,value]=[...data].at(-1)!;return{scope,key,expected:value};});
      await durability.waitForKeys(physicalKV,last,{expectedValues:last.map(row=>row.expected)});
      if(realEngine.prepareOnly)return{preparationOnly:true,businessMeasured:false,engine:'actual-iii',storageUnitCount,namespaceBytes,itemCount,initializationMs:performance.now()-initializationStarted,sourceFiles,seedExpectedRows,seedPresentRows,seedWrittenRows,seedReused:realEngine.reuseSyntheticSeed===true};
    }else for(const [unit,data]of rows)await writeNamespace(unit,data);
    const initializationMs=performance.now()-initializationStarted;
    const sourceFileBytes=await Promise.all(sourceUnits.map(async unit=>stat(file(unit)).then(row=>row.size,error=>{if(realEngine&&error.code==='ENOENT')return 0;throw error;})));
    certificateEvents.length=0;
    const initialNamespaceBytes=sourceFileBytes.reduce((n,bytes)=>n+bytes,0);
    const warmupStarted=performance.now(),warmupCpu=process.cpuUsage();if(warmCaptureBudget)await kv.observationReader!.captureSummary(scope,'target-0');const warmupMs=performance.now()-warmupStarted,warmupUsed=process.cpuUsage(warmupCpu),warmupCpuMs=(warmupUsed.user+warmupUsed.system)/1000;
    function later(kind:string,at:number,fn:()=>Promise<unknown>){tasks.push(new Promise<void>(resolve=>{timers.push(setTimeout(()=>{
      const event:Record<string,unknown>={kind,arrivalAnchor,requestedAtMs:at,startedAtMs:performance.now()-began};taskEvents.push(event);
      void fn().then(()=>{event.outcome='completed';},error=>{event.outcome='failed';errors.push(error?.code??error?.message??'synthetic_task_failed');}).finally(()=>{event.finishedAtMs=performance.now()-began;resolve();});
    },at));}));}
    began=performance.now();const cpu=process.cpuUsage(),initialReads=durability.snapshot().readSharing;
    const scheduleArrivals=()=>{
      foregroundWritesAtMs.forEach((at,n)=>later('foreground',at,async()=>{const row=await kv.get<any>(scope,foregroundKey);await kv.set(scope,foregroundKey,{...row,narrative:'Synthetic writer '+n});}));
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
    const compressionBatchReturnedMs=performance.now()-began;
    await worker.drain();
    const firstPassDrainedMs=performance.now()-began,firstPassCompleted=worker.snapshot().completedCount;
    await Promise.all(tasks);
    if(recoverPendingAtEnd){await worker.pump();await worker.drain();}
    await Promise.all([...publications.values()]);
    const elapsedMs=performance.now()-began,cpuUsed=process.cpuUsage(cpu),reads=durability.snapshot().readSharing;
    const targetKeys=new Set(Array.from({length:itemCount},(_,n)=>'target-'+n)),seen=new Set<string>();let duplicateSourceKeys=0;
    const selected={values:new Map<string,any>()};
    for(const unit of sourceUnits){const read=await readNamespaceEntries(file(unit),{keys:targetKeys,onEntry:key=>{if(seen.has(key))duplicateSourceKeys++;seen.add(key);}}).catch(error=>{if(realEngine&&error.code==='ENOENT')return{values:new Map()};throw error;});for(const [key,value]of read.values)selected.values.set(key,value);}
    async function disk(scope:string){const result=new Map<string,any>();for(const unit of storage.units(scope)){const read=await readNamespaceEntries(file(unit),{keys:targetKeys}).catch(error=>{if(error.code==='ENOENT')return{values:new Map()};throw error;});for(const [key,value]of read.values)result.set(key,value);}return result;}
    const committedDisk={values:await disk(COMMITTED)},pendingDisk=await disk(RETRY);
    const logicalSourceFilePresent=await stat(file(scope)).then(()=>true,()=>false);
    return{engine:realEngine?'actual-iii':'synthetic',initializationMs,scenario:{namespaceBytes,itemCount,inferenceMs,publicationDelayMs,timeoutMs,foregroundWritesAtMs,recoveryAtMs,recoveryItemCount,firstCompressionPublicationDelayMs,arrivalAnchor,warmCaptureBudget,storageUnitCount,writerPlacement,recoverPendingAtEnd},warmupMs,warmupCpuMs,includingWarmupMs:elapsedMs+warmupMs,includingWarmupCpuMs:(cpuUsed.user+cpuUsed.system)/1000+warmupCpuMs,firstCompressionWriteAtMs,initialNamespaceBytes,elapsedMs,cpuMs:(cpuUsed.user+cpuUsed.system)/1000,
      storageUnits:{count:storageUnitCount,sourceFileCount:sourceUnits.length,sourceFileBytes,logicalSourceFilePresent,duplicateSourceKeys,sourceKeysComplete:seen.size===observations.size,writerUnit:storageUnitFor(foregroundKey),targetUnits:[...targetKeys].map(storageUnitFor)},
      compressionBatchReturnedMs,firstPassDrainedMs,firstPassCompleted,completedItemsPerMinute:committedDisk.values.size/(elapsedMs/60000),firstAttemptFailures:outcomes.filter(row=>!row.success).length,
      inferencePeak,compressionCalls,embeddingCalls,inferenceEvents,outcomes,sdkGets,certificateEvents,
      durabilityReads:{physicalReads:reads.startedReads-initialReads.startedReads,scanBytes:reads.scanBytes-initialReads.scanBytes,sharedRequests:reads.sharedRequests-initialReads.sharedRequests},
      namespacePublishes,publicationFailures,sourcePublicationEvents,taskEvents,taskErrors:errors,metrics:await metrics.get('mem::compress'),
      originalSourcesPreserved:[...selected.values.values()].every((row:any)=>row?.sourceRaw?.toolOutput===raw.toolOutput),
      diskCompressedTargets:[...selected.values.values()].filter((row:any)=>row.llmCompressionRevision!==undefined).length,
      pendingTargets:(await kv.list<any>(RETRY)).filter(row=>row.id.startsWith('target-')).length,
      durablePendingTargets:pendingDisk.size,
      committedTargets:committedDisk.values.size,measurementCoverage:durability.snapshot().measurements,
      limitations:[realEngine?'Actual isolated iii engine state SDK and publication; provider is synthetic serialized inference, no actual LLM.':'Synthetic SDK, no actual engine or LLM; publication has independent per-physical-scope queues, unlike a possible engine-wide flush lock.','Experimental routing only: no migration, production list/cursor/order, recovery-tool or snapshot compatibility is solved.','Sequential compression arrival; only explicit foreground/recovery tasks overlap.','Wall/CPU includes compression list/budget and drain; sharing byte counters exclude those direct list reads. Warm capture-budget construction is reported separately and in includingWarmup totals.','No capture/outbox/session-end route is invoked; no claim of delivery or warning resolution.']};
  }finally{
    await Promise.allSettled(tasks);timers.forEach(clearTimeout);worker.stop();await worker.drain();persistence.stop();await Promise.allSettled([...publications.values()]);
    search.setEmbeddingRecovery(null);search.setEmbeddingProvider(null);search.setVectorIndex(null);search.setIndexPersistence(null);search.getSearchIndex().clear();
    if(previousPath===undefined)delete process.env.AGENTMEMORY_STATE_STORE_PATH;else process.env.AGENTMEMORY_STATE_STORE_PATH=previousPath;
    if(!realEngine)await rm(directory,{recursive:true,force:true});
  }
}
