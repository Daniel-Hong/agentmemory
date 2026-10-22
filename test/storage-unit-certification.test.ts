import {expect,it,vi} from 'vitest';
vi.mock('../src/logger.js',()=>({logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}}));
import {runCompressionCertificationScenario} from './helpers/compression-certification-scenario.js';
import {storageUnitFor,createStorageUnitAdapter} from './helpers/storage-unit-adapter.js';

it('routes the complete compression certification and publication through sixteen real namespace units',async()=>{
 const result=await runCompressionCertificationScenario({namespaceBytes:512*1024,itemCount:2,warmCaptureBudget:true,storageUnitCount:16}as any);
 expect((result as any).storageUnits).toMatchObject({count:16,logicalSourceFilePresent:false,duplicateSourceKeys:0,sourceKeysComplete:true});
 expect(result.outcomes.every(row=>row.success)).toBe(true);expect(result.committedTargets).toBe(2);expect(result.pendingTargets).toBe(0);expect(result.originalSourcesPreserved).toBe(true);expect(result.inferencePeak).toBe(1);
 expect((result as any).storageUnits.sourceFileCount).toBe(16);
 const certificates=result.certificateEvents.filter(row=>row.kind==='source_intent');
 expect(certificates).toHaveLength(2);
 expect(certificates.map(row=>row.physicalSelection)).toEqual(['target-0','target-1'].map(key=>[{family:'source',unit:storageUnitFor(key)},{family:'retry',unit:storageUnitFor(key)}]));
 expect(result.certificateEvents.filter(row=>row.kind==='committed_marker').map(row=>row.physicalSelection)).toEqual(['target-0','target-1'].map(key=>[{family:'marker',unit:storageUnitFor(key)}]));
});
it('keeps originals and a real durable retry instead of certifying a delayed shard',async()=>{
 const result=await runCompressionCertificationScenario({namespaceBytes:512*1024,itemCount:1,publicationDelayMs:80,timeoutMs:30,storageUnitCount:16});
 expect(result.outcomes[0]).toMatchObject({success:false,retained:true,revisionWritten:true});expect(result.pendingTargets).toBe(1);expect(result.durablePendingTargets).toBe(1);expect(result.committedTargets).toBe(0);expect(result.embeddingCalls).toBe(0);expect(result.originalSourcesPreserved).toBe(true);
});

async function restartFixture(mode:'cancel'|'publication_failure'|'foreign_generation'|'same_target'){
 const{mkdtemp,writeFile,rename,readdir,readFile,rm}=await import('node:fs/promises');const{tmpdir}=await import('node:os');const{join}=await import('node:path');
 const{StateKV}=await import('../src/state/kv.js');const{KV}=await import('../src/state/schema.js');const{VectorIndex}=await import('../src/state/vector-index.js');const{IndexPersistence}=await import('../src/state/index-persistence.js');const{withKeyedLock}=await import('../src/state/keyed-mutex.js');
 const{createStateDurabilityFence}=await import('../src/ops/state-durability.mjs');const{registerEmbeddingRecovery,EMBEDDING_RETRY_NAMESPACE:RETRY,EMBEDDING_COMMITTED_NAMESPACE:COMMITTED}=await import('../src/ops/embedding-recovery.mjs');
 const dir=await mkdtemp(join(tmpdir(),'am-unit-restart-'));const oldPath=process.env.AGENTMEMORY_STATE_STORE_PATH;process.env.AGENTMEMORY_STATE_STORE_PATH=dir;
 let rows=new Map<string,Map<string,any>>(),failPublication=mode==='publication_failure',now=0;
 const sdk={trigger:async({function_id,payload:p}:any)=>{
  if(function_id==='state::get')return rows.get(p.scope)?.get(p.key)??null;
  if(function_id==='state::list')return[...rows.get(p.scope)?.values()??[]];
  if(function_id==='state::set'||function_id==='state::delete'){
   if(failPublication&&p.scope.startsWith(KV.bm25Index+':vec:'))throw Error('synthetic publication failure');
   if(!rows.has(p.scope))rows.set(p.scope,new Map());if(function_id==='state::set')rows.get(p.scope)!.set(p.key,JSON.parse(JSON.stringify(p.value)));else rows.get(p.scope)!.delete(p.key);
   await withKeyedLock('fixture-file:'+p.scope,async()=>{const path=join(dir,encodeURIComponent(p.scope)+'.bin');await writeFile(path+'.next',JSON.stringify(Object.fromEntries(rows.get(p.scope)!)));await rename(path+'.next',path);});return p.value??true;
  }
 }};
 const source=KV.observations('restart'),item={id:'target',sessionId:'restart',kind:'synthetic' as const};let hotWritten=false;
 const embed=vi.fn(async()=>{if(mode==='same_target'&&!hotWritten){hotWritten=true;await first.storage.kv.set(source,item.id,{id:item.id,sessionId:item.sessionId,title:'new canonical',sourceRaw:{toolOutput:'original retained'}});}return new Float32Array([1,0]);});
 function create(){const fence=createStateDurabilityFence({storePath:dir,timeoutMs:500,pollIntervalMs:5}),physical=new StateKV(sdk as never,{backend:'file',durability:fence});const storage=createStorageUnitAdapter(physical,[source,RETRY,COMMITTED],16),index=new VectorIndex(),persistence=new IndexPersistence(storage.kv,index);persistence.stop();const worker=registerEmbeddingRecovery({kv:storage.kv,KV,index,provider:{dimensions:2,embed},withKeyedLock,schedule:false,clock:()=>now,persistIndex:publication=>persistence.saveVerified(publication)});return{fence,storage,index,persistence,worker};}
 let first=create(),second:ReturnType<typeof create>|undefined;
 try{
  await first.storage.kv.set(source,item.id,{id:item.id,sessionId:item.sessionId,title:'original canonical',sourceRaw:{toolOutput:'original retained'}});await first.worker.enqueue(item);
  if(mode==='cancel'||mode==='foreign_generation'){
   const original=first.fence.waitForKeys;let release!:()=>void,entered=false;const gate=new Promise<void>(resolve=>release=resolve);
   first.fence.waitForKeys=async(...args:any[])=>{if(args[1].some((row:any)=>row.scope.startsWith(source))){entered=true;await gate;}return original(...args);};
   const pending=first.worker.add(item);await vi.waitFor(()=>expect(entered).toBe(true));
   if(mode==='cancel')first.worker.stop();else await first.storage.kv.set(RETRY,item.id,{...await first.storage.kv.get(RETRY,item.id),generation:'foreign',attempts:7});
   release();expect(await pending).toBe(false);
   if(mode==='foreign_generation')expect(await first.storage.kv.get(RETRY,item.id)).toMatchObject({generation:'foreign',attempts:7});
   expect(embed).not.toHaveBeenCalled();
  }else if(mode==='same_target'){expect(await first.worker.add(item)).toBe(false);await first.worker.drain();expect(first.index.has(item.id)).toBe(false);expect(await first.storage.kv.get(COMMITTED,item.id)).toBeNull();expect(await first.storage.kv.get(RETRY,item.id)).not.toBeNull();}
  else{await first.worker.add(item);await first.worker.drain();expect(await first.storage.kv.get(RETRY,item.id)).toMatchObject({attempts:1});}
  first.worker.stop();await first.worker.drain();first.persistence.stop();
  const restartedRows=new Map<string,Map<string,any>>();for(const name of await readdir(dir)){if(!name.endsWith('.bin'))continue;restartedRows.set(decodeURIComponent(name.slice(0,-4)),new Map(Object.entries(JSON.parse(await readFile(join(dir,name),'utf8')))));}rows=restartedRows;failPublication=false;now+=60000;
  second=create();await second.worker.pump();await second.worker.drain();
  expect(await second.storage.kv.get(RETRY,item.id)).toBeNull();expect(await second.storage.kv.get(COMMITTED,item.id)).toBeTruthy();expect(await second.storage.kv.get<any>(source,item.id)).toMatchObject({sourceRaw:{toolOutput:'original retained'}});
  const markerFile=join(dir,encodeURIComponent(second.storage.route(COMMITTED,item.id))+'.bin');expect(JSON.parse(await readFile(markerFile,'utf8'))[item.id]).toBeTruthy();
  expect(await readFile(join(dir,encodeURIComponent(source)+'.bin')) .catch(()=>null)).toBeNull();
 }finally{first.worker.stop();await first.worker.drain();first.persistence.stop();second?.worker.stop();if(second)await second.worker.drain();second?.persistence.stop();if(oldPath===undefined)delete process.env.AGENTMEMORY_STATE_STORE_PATH;else process.env.AGENTMEMORY_STATE_STORE_PATH=oldPath;await rm(dir,{recursive:true,force:true});}
}
for(const mode of ['cancel','publication_failure','foreign_generation','same_target']as const)it(`restarts from physical durable units after ${mode} without losing source or acknowledging an unfinished intent`,()=>restartFixture(mode));

it.runIf(process.env.AM_STORAGE_BENCH==='1')('measures fixed storage units with identical serialized inference and namespace dataset',async()=>{
 const count=process.env.AM_STORAGE_UNITS==='16'?16:1,mode=process.env.AM_STORAGE_MODE??'normal';
 const negative=mode==='publication17',placement=mode==='same_shard'?'same_shard':mode==='same_target'?'same_target':'unrelated';
 const writes=mode==='normal'||negative?[]:[1000,4000,7000,10000,13000];
 const result=await runCompressionCertificationScenario({namespaceBytes:256_000_000,itemCount:negative?1:2,inferenceMs:2000,publicationDelayMs:40,timeoutMs:15000,foregroundWritesAtMs:writes,arrivalAnchor:'first_compression_write',warmCaptureBudget:true,storageUnitCount:count,writerPlacement:placement,firstCompressionPublicationDelayMs:negative?17000:0,recoverPendingAtEnd:!negative});
 if(process.env.AM_STORAGE_REPORT){const{writeFile}=await import('node:fs/promises');await writeFile(process.env.AM_STORAGE_REPORT,JSON.stringify({mode,layout:count,...result},null,2)+'\n');}
 expect(result.inferencePeak).toBe(1);expect(result.originalSourcesPreserved).toBe(true);expect(result.storageUnits.duplicateSourceKeys).toBe(0);expect(result.storageUnits.sourceKeysComplete).toBe(true);
 expect(result.storageUnits.logicalSourceFilePresent).toBe(count===1);
 if(negative){expect(result.firstAttemptFailures).toBe(1);expect(result.embeddingCalls).toBe(0);expect(result.committedTargets).toBe(0);expect(result.durablePendingTargets).toBe(1);}
 else{expect(result.committedTargets).toBe(2);expect(result.pendingTargets).toBe(0);}
},180000);
