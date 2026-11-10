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
