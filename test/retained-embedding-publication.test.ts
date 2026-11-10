import {afterEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {StateKV} from '../src/state/kv.js';
import {KV} from '../src/state/schema.js';
import {IndexPersistence,vectorBucketScope} from '../src/state/index-persistence.js';
import {VectorIndex,float32ToBase64} from '../src/state/vector-index.js';
import {acquireFileWriterLease} from '../src/ops/file-writer-lease.mjs';
import {registerEmbeddingRecovery} from '../src/ops/embedding-recovery.mjs';
import {withKeyedLock} from '../src/state/keyed-mutex.js';
import {createBackgroundControl,installBackgroundControl} from '../src/ops/background-control.mjs';
import {engineFixture} from './helpers/engine-evidence.js';

const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanups.splice(0))await close();installBackgroundControl(null as never);vi.unstubAllEnvs();vi.restoreAllMocks();});
function archive(value:unknown){
 const bytes=Buffer.from(JSON.stringify(value));
 if(bytes.length<=8){const inline=Buffer.alloc(8,0xff);bytes.copy(inline);return inline;}
 const root=Math.ceil(bytes.length/4)*4,out=Buffer.alloc(root+8);
 bytes.copy(out);out.writeUInt32LE((bytes.length&63)+128+Math.floor(bytes.length/64)*256,root);out.writeInt32LE(-root,root+4);return out;
}
async function fixture(){
 const store=mkdtempSync(join(tmpdir(),'am-retained-embedding-'));vi.stubEnv('AGENTMEMORY_STATE_STORE_PATH',store);
 const {evidence}=engineFixture(store),lease=acquireFileWriterLease(store,{evidence});
 const data=new Map<string,Map<string,any>>(),disk=(scope:string)=>join(store,encodeURIComponent(scope)+'.bin');
 const write=(scope:string)=>writeFileSync(disk(scope),archive(Object.fromEntries(data.get(scope)??[])));
 const embedding=new Float32Array([1,0]),rows=[1,2,3,4].map(q=>({id:'obs_retained_'+q,s:'session',q,e:float32ToBase64(embedding),k:'observation'}));
 const oldCommit={id:rows[3].id,sessionId:'session',kind:'synthetic',fingerprint:'0'.repeat(64),committedAt:'2025-01-01T00:00:00.000Z'};
 data.set(KV.bm25Index,new Map([['vectors:meta',{v:3,count:4,bucketCount:1,savedAt:'2026-01-01T00:00:00.000Z'}]]));
 data.set(vectorBucketScope(0),new Map(rows.map(({id,s,e})=>[id,{id,s,e}])));
 data.set(KV.vectorPendingLog,new Map(rows.map(row=>[row.id,row])));
 data.set(KV.observations('session'),new Map(rows.map(({id})=>[id,{id,sessionId:'session',title:'canonical '+id,narrative:'source text',sourceRaw:{original:'preserved synthetic'}}])));
 const fingerprint=(id:string)=>createHash('sha256').update('canonical '+id+' source text').digest('hex');
 const retries=rows.map(({id})=>({id,sessionId:'session',kind:'observation',attempts:3,retryAt:0,generation:'previous-'+id,fingerprint:fingerprint(id),phase:'queued',errorCode:'VECTOR_RECOVERY_PAUSED'}));
 data.set(KV.embeddingRetry,new Map(retries.map(row=>[row.id,row])));
 data.set(KV.embeddingCommitted,new Map([[oldCommit.id,oldCommit]]));
 for(const scope of data.keys())write(scope);
 const actions:Array<{scope:string;key:string;op:string}>=[];
 const sdk={trigger:async({function_id,payload:{scope,key,value}}:any)=>{
  const table=data.get(scope)??new Map();
  if(function_id==='state::get')return structuredClone(table.get(key)??null);
  if(function_id==='state::list')return structuredClone([...table.values()]);
  if(function_id==='state::set'){data.set(scope,table);table.set(key,structuredClone(value));write(scope);actions.push({scope,key,op:'set'});return value;}
  if(function_id==='state::delete'){table.delete(key);write(scope);actions.push({scope,key,op:'delete'});return;}
  throw Error('unexpected synthetic SDK call');
 }};
 const kv=new StateKV(sdk as never,{writerLease:lease}),index=new VectorIndex();let held=true,epoch=0;
 const persistence=new IndexPersistence(kv,index,{requireRecoveryPlan:true,isStorageHeld:()=>held,storageGeneration:()=>epoch});
 await persistence.load();held=false;expect(await persistence.resumeStorageRecovery(2,true)).toBe(true);
 const provider={name:'synthetic',dimensions:2,embed:vi.fn(async(_text:string)=>new Float32Array(embedding)),embedBatch:async(texts:string[])=>texts.map(()=>new Float32Array(embedding))};
 const recovery=registerEmbeddingRecovery({kv,KV,index,provider,withKeyedLock,schedule:false,
  verifyRetainedPublication:publication=>persistence.verifyRetainedVectorPublication(publication),
  persistIndex:publication=>persistence.saveVerified(publication)});
 cleanups.push(async()=>{recovery.stop();await recovery.drain();persistence.stop();lease.close();await kv.durability?.drain();rmSync(store,{recursive:true,force:true});});
 const wal=readFileSync(disk(KV.vectorPendingLog)),buckets=readFileSync(disk(vectorBucketScope(0)));
 actions.length=0;
 return{kv,index,persistence,recovery,provider,rows,retries,oldCommit,data,write,disk,actions,wal,buckets,
  item:(n=0)=>({id:rows[n].id,sessionId:'session',kind:'observation' as const}),
  changeEpoch:()=>{epoch++;},hold:()=>{held=true;},
  assertOriginals:()=>{expect(readFileSync(disk(KV.vectorPendingLog))).toEqual(wal);expect(readFileSync(disk(vectorBucketScope(0)))).toEqual(buckets);},
 };
}

it('publishes all four freshly reembedded exact retained vectors without mutating WAL or vectors',async()=>{
 const f=await fixture();await f.recovery.pump();await f.recovery.drain();
 expect(f.provider.embed).toHaveBeenCalledTimes(4);expect(f.recovery.snapshot()).toMatchObject({pendingCount:0,completedCount:4,lastError:null,publicationEvidence:{completion:'sdk'}});
 for(const [n,row] of f.rows.entries()){
  expect(f.provider.embed).toHaveBeenCalledWith('canonical '+row.id+' source text');
  expect(await f.kv.get(KV.embeddingRetry,row.id)).toBeNull();
  const marker:any=await f.kv.get(KV.embeddingCommitted,row.id);
  expect(marker.fingerprint).toBe(f.retries[n].fingerprint);
  expect(marker.retainedRecovery).toMatchObject({version:1,completion:'sdk',verified:false,synced:false,previousIntent:f.retries[n]});
  expect(marker.retainedRecovery.previousCommit).toEqual(n===3?f.oldCommit:null);
  expect(f.recovery.observedPublication(row.id)).toMatchObject({completion:'sdk',durable:false});
 }
 expect(f.actions.filter(a=>a.scope===KV.vectorPendingLog||a.scope.startsWith(KV.bm25Index+':vec:')||a.scope===KV.vectorRetentionReceipts)).toEqual([]);
 f.assertOriginals();expect(f.index.pendingChanges).toBe(0);
 expect(f.persistence.status()).toMatchObject({pendingLog:4,retainedCheckpointRows:4,pendingLogAcknowledged:0});
 expect(()=>f.index.add(f.rows[0].id,'session',new Float32Array([1,0]))).toThrow(/VECTOR_RECOVERY_PAUSED/);
 expect(()=>f.index.remove(f.rows[0].id)).toThrow(/VECTOR_RECOVERY_PAUSED/);expect(()=>f.index.clear()).toThrow(/VECTOR_RECOVERY_PAUSED/);
});

it.each(['different bytes','negative zero','wrong owner','epoch changed','missing receipt','stale receipt','changed checkpoint'])('retains an exact original on %s',async mode=>{
 const f=await fixture();
 if(mode==='different bytes')f.provider.embed.mockResolvedValue(new Float32Array([0,1]));
 if(mode==='negative zero')f.provider.embed.mockResolvedValue(new Float32Array([1,-0]));
 if(mode==='wrong owner')f.provider.embed.mockImplementation(async()=>{f.index.get(f.rows[0].id)!.sessionId='other';return new Float32Array([1,0]);});
 if(mode==='epoch changed')f.provider.embed.mockImplementation(async()=>{f.changeEpoch();return new Float32Array([1,0]);});
 if(mode==='missing receipt'||mode==='stale receipt'){
  const table=f.data.get(KV.vectorRetentionReceipts)!;
  if(mode==='missing receipt')table.clear();else{const first=table.keys().next().value!;table.get(first).q++;}
  f.write(KV.vectorRetentionReceipts);
 }
 if(mode==='changed checkpoint'){f.data.get(vectorBucketScope(0))!.get(f.rows[0].id).e=float32ToBase64(new Float32Array([0,1]));f.write(vectorBucketScope(0));}
 await f.recovery.add(f.item());await f.recovery.drain();
 expect(await f.kv.get(KV.embeddingRetry,f.rows[0].id)).not.toBeNull();expect(await f.kv.get(KV.embeddingCommitted,f.rows[0].id)).toBeNull();
 expect(f.recovery.snapshot()).toMatchObject({completedCount:0});expect(f.recovery.observedPublication(f.rows[0].id)).toBeNull();
 expect(readFileSync(f.disk(KV.vectorPendingLog))).toEqual(f.wal);
});

it.each(['source','intent'])('rejects a changed %s during retained physical verification',async mode=>{
 const f=await fixture(),verify=f.persistence.verifyCaptureVectorPending.bind(f.persistence);
 vi.spyOn(f.persistence,'verifyCaptureVectorPending').mockImplementation(async(...args)=>{
  const valid=await verify(...args);
  if(mode==='source')await f.kv.set(KV.observations('session'),f.rows[0].id,{id:f.rows[0].id,sessionId:'session',title:'changed',narrative:'source text'});
  else await f.kv.set(KV.embeddingRetry,f.rows[0].id,{...await f.kv.get<any>(KV.embeddingRetry,f.rows[0].id),generation:'new-owner'});
  return valid;
 });
 await f.recovery.add(f.item());await f.recovery.drain();
 expect(await f.kv.get(KV.embeddingRetry,f.rows[0].id)).not.toBeNull();expect(await f.kv.get(KV.embeddingCommitted,f.rows[0].id)).toBeNull();f.assertOriginals();
});

it.each(['receipt','WAL'])('rechecks %s evidence during publication instead of trusting earlier reuse',async evidence=>{
 const f=await fixture(),save=f.persistence.saveVerified.bind(f.persistence);
 vi.spyOn(f.persistence,'saveVerified').mockImplementation(async publication=>{
  if(evidence==='receipt'){f.data.get(KV.vectorRetentionReceipts)!.clear();f.write(KV.vectorRetentionReceipts);}
  else{f.data.get(KV.vectorPendingLog)!.delete(f.rows[0].id);f.write(KV.vectorPendingLog);}
  return save(publication);
 });
 await f.recovery.add(f.item());await f.recovery.drain();
 expect(await f.kv.get(KV.embeddingRetry,f.rows[0].id)).not.toBeNull();expect(await f.kv.get(KV.embeddingCommitted,f.rows[0].id)).toBeNull();
 if(evidence==='receipt')f.assertOriginals();
 else expect(readFileSync(f.disk(vectorBucketScope(0)))).toEqual(f.buckets);
});

it('does not infer or reuse retained vectors while background admission is paused',async()=>{
 const f=await fixture(),control=createBackgroundControl();await control.init(f.kv);installBackgroundControl(control);await control.change('pause');await control.settled();
 await f.recovery.add(f.item());await f.recovery.pump();await f.recovery.drain();
 expect(f.provider.embed).not.toHaveBeenCalled();expect(await f.kv.get(KV.embeddingRetry,f.rows[0].id)).not.toBeNull();f.assertOriginals();
});

it('keeps completed SDK metadata and retained WAL valid after a new persistence worker loads them',async()=>{
 const f=await fixture();await f.recovery.pump();await f.recovery.drain();
 const nextIndex=new VectorIndex(),nextPersistence=new IndexPersistence(f.kv,nextIndex,{requireRecoveryPlan:true});
 try {
  const loaded=await nextPersistence.load();expect(loaded.state).toBe('buckets');await nextPersistence.prepareBackfill(loaded);nextIndex.restoreFrom(loaded.vector!);
  expect(await nextPersistence.replayPendingLog(2)).toMatchObject({entries:0,added:0});
  expect(nextIndex.size).toBe(4);expect(nextPersistence.status()).toMatchObject({pendingLog:4,retainedCheckpointRows:4,pendingChanges:0});
  for(const row of f.rows)expect(await nextPersistence.verifyRetainedVectorPublication({id:row.id,entry:nextIndex.get(row.id)!})).toBe(true);
  expect(()=>nextIndex.remove(f.rows[0].id)).toThrow(/VECTOR_RECOVERY_PAUSED/);
  f.assertOriginals();
 }finally{nextPersistence.stop();}
});

it('records only one defensive-copy retained proof diagnostic and ignores unknown IDs',async()=>{
 const f=await fixture();expect(f.persistence.status().retainedProofLastCheck).toBeNull();
 expect(await f.persistence.verifyRetainedVectorPublication({id:'unknown-untrusted-id',entry:null})).toBe(false);
 expect(f.persistence.status().retainedProofLastCheck).toBeNull();
 for(const row of f.rows)expect(await f.persistence.verifyRetainedVectorPublication({id:row.id,entry:f.index.get(row.id)!})).toBe(true);
 const status=f.persistence.status();expect(status.retainedProofLastCheck).toMatchObject({id:f.rows[3].id,operation:'retained_publication',reason:'verified',
  freshBytesMatch:true,loadedBytesMatch:true,freshSessionMatch:true,loadedSessionMatch:true,retentionReady:true,
  stopped:false,storageHeld:false,storageGenerationChanged:false,storageRecovering:false,storageBlocked:false,recoveryPaused:false,
  pendingLog:0,logChains:0,dirty:0,revisionChanged:false,physicalProofErrorCode:null});
 status.retainedProofLastCheck!.reason='publication_invalid';expect(f.persistence.status().retainedProofLastCheck!.reason).toBe('verified');
 expect(JSON.stringify(status)).not.toContain(f.rows[0].e);expect(JSON.stringify(status)).not.toContain('source text');
 expect(f.actions).toEqual([]);f.assertOriginals();
});

it.each(['different bytes','negative zero','fresh owner','loaded owner','loaded bytes'])('diagnoses %s without relaxing exact publication rejection',async mode=>{
 const f=await fixture(),row=f.rows[0],entry={...f.index.get(row.id)!,embedding:new Float32Array([1,0])};
 if(mode==='different bytes')entry.embedding=new Float32Array([0,1]);
 if(mode==='negative zero')entry.embedding=new Float32Array([1,-0]);
 if(mode==='fresh owner')entry.sessionId='other';
 if(mode==='loaded owner')f.index.get(row.id)!.sessionId='other';
 if(mode==='loaded bytes')f.index.get(row.id)!.embedding[0]=0;
 expect(await f.persistence.verifyRetainedVectorPublication({id:row.id,entry})).toBe(false);
 expect(f.persistence.status().retainedProofLastCheck).toMatchObject({id:row.id,reason:'publication_mismatch',physicalProofErrorCode:null,
  freshBytesMatch:mode!=='different bytes'&&mode!=='negative zero',loadedBytesMatch:mode!=='loaded bytes',
  freshSessionMatch:mode!=='fresh owner',loadedSessionMatch:mode!=='loaded owner'});
 expect(f.actions).toEqual([]);f.assertOriginals();
 expect(()=>f.index.remove(row.id)).toThrow(/VECTOR_RECOVERY_PAUSED/);
});

it.each(['known','unknown'])('retains only allowlisted physical proof error codes (%s)',async mode=>{
 const f=await fixture(),row=f.rows[0];
 vi.spyOn(f.kv,'reconcileVectorCheckpoint').mockRejectedValue(Object.assign(new Error('synthetic private path and source text'),{code:mode==='known'?'VECTOR_CHECKPOINT_UNVERIFIED':'PRIVATE_UNKNOWN_SECRET'}));
 expect(await f.persistence.verifyRetainedVectorPublication({id:row.id,entry:f.index.get(row.id)!})).toBe(false);
 expect(f.persistence.status().retainedProofLastCheck).toMatchObject({reason:'physical_proof_rejected',freshBytesMatch:true,loadedBytesMatch:true,
  physicalProofErrorCode:mode==='known'?'VECTOR_CHECKPOINT_UNVERIFIED':'UNCLASSIFIED_PROOF_ERROR'});
 expect(JSON.stringify(f.persistence.status().retainedProofLastCheck)).not.toMatch(/private|source text|PRIVATE_UNKNOWN_SECRET/);
 expect(f.actions).toEqual([]);f.assertOriginals();
});

it.each(['stopped','held','generation','dirty','log chain','pending log','not ready','recovering','blocked','paused','pending mismatch'])('reports %s while preserving capture pending false',async mode=>{
 const f=await fixture(),row=f.rows[0],p=f.persistence as any;
 if(mode==='stopped')p.stopped=true;
 if(mode==='held')f.hold();
 if(mode==='generation')f.changeEpoch();
 if(mode==='dirty')vi.spyOn(f.index,'pendingChanges','get').mockReturnValue(1);
 if(mode==='log chain')p.logChains.set('synthetic',Promise.resolve());
 if(mode==='pending log')p.pendingLog.set('synthetic',1);
 if(mode==='not ready')p.retentionReady=false;
 if(mode==='recovering')p.storageRecovering=true;
 if(mode==='blocked')p.storageBlocked=true;
 if(mode==='paused')p.recoveryReady=false;
 const pending=mode==='pending mismatch'?{...row,q:99}:row;
 expect(await f.persistence.verifyCaptureVectorPending(row.id,'session',pending)).toBe(false);
 const last=f.persistence.status().retainedProofLastCheck!;
 expect(last).toMatchObject({id:row.id,operation:'capture_pending',freshBytesMatch:null,physicalProofErrorCode:null});
 if(mode==='stopped')expect(last.stopped).toBe(true);
 if(mode==='held')expect(last.storageHeld).toBe(true);
 if(mode==='generation')expect(last.storageGenerationChanged).toBe(true);
 if(mode==='dirty')expect(last.dirty).toBe(1);
 if(mode==='log chain')expect(last.logChains).toBe(1);
 if(mode==='pending log')expect(last.pendingLog).toBe(1);
 if(mode==='not ready')expect(last.retentionReady).toBe(false);
 if(mode==='recovering')expect(last.storageRecovering).toBe(true);
 if(mode==='blocked')expect(last.storageBlocked).toBe(true);
 if(mode==='paused')expect(last.recoveryPaused).toBe(true);
 if(mode==='pending mismatch')expect(last.reason).toBe('pending_row_mismatch');
 expect(f.actions).toEqual([]);f.assertOriginals();
});

it('reports revision changes and preserves both successful and rejected capture decisions',async()=>{
 const f=await fixture(),row=f.rows[0];
 expect(await f.persistence.verifyCaptureVectorPending(row.id,'session',row)).toBe(true);
 expect(f.persistence.status().retainedProofLastCheck).toMatchObject({reason:'verified',freshBytesMatch:null,loadedBytesMatch:true,revisionChanged:false});
 vi.spyOn(f.kv,'reconcileVectorCheckpoint').mockImplementation(async()=>{Object.defineProperty(f.kv,'vectorCheckpointRevision',{value:999});throw Error('vector_recovery_checkpoint_changed');});
 expect(await f.persistence.verifyCaptureVectorPending(row.id,'session',row)).toBe(false);
 expect(f.persistence.status().retainedProofLastCheck).toMatchObject({reason:'physical_proof_rejected',revisionChanged:true,physicalProofErrorCode:'vector_recovery_checkpoint_changed'});
 expect(f.actions).toEqual([]);f.assertOriginals();
});

it('never lets hostile physical error properties escape the original false result',async()=>{
 const f=await fixture(),row=f.rows[0];
 vi.spyOn(f.kv,'reconcileVectorCheckpoint').mockRejectedValue(Object.defineProperty({},'code',{get(){throw Error('synthetic private getter');}}));
 expect(await f.persistence.verifyCaptureVectorPending(row.id,'session',row)).toBe(false);
 expect(f.persistence.status().retainedProofLastCheck).toMatchObject({reason:'physical_proof_rejected',physicalProofErrorCode:'UNCLASSIFIED_PROOF_ERROR'});
 f.assertOriginals();
});

it('does not label a rejected publication with an earlier verified capture diagnostic',async()=>{
 const f=await fixture(),row=f.rows[0];
 expect(await f.persistence.verifyCaptureVectorPending(row.id,'session',row)).toBe(true);
 vi.spyOn(f.persistence,'verifyCaptureVectorPending').mockResolvedValue(false);
 expect(await f.persistence.verifyRetainedVectorPublication({id:row.id,entry:f.index.get(row.id)!})).toBe(false);
 expect(f.persistence.status().retainedProofLastCheck).toMatchObject({reason:'capture_pending_rejected'});
 f.assertOriginals();
});

it('clears an earlier diagnostic if local diagnostic collection becomes unavailable',async()=>{
 const f=await fixture(),row=f.rows[0];
 expect(await f.persistence.verifyCaptureVectorPending(row.id,'session',row)).toBe(true);
 (f.persistence as any).isStorageHeld=()=>{throw Error('synthetic unavailable local observation');};
 expect(await f.persistence.verifyCaptureVectorPending(row.id,'session',row)).toBe(false);
 expect(f.persistence.status().retainedProofLastCheck).toBeNull();
 f.assertOriginals();
});
