import {describe,expect,it,vi} from 'vitest';
import {IndexPersistence, vectorBucketScope} from '../src/state/index-persistence.js';
import {receiptFor} from '../src/state/vector-checkpoint-reconciliation.js';
import {VectorIndex} from '../src/state/vector-index.js';

const pending='mem:index:vec-pending',index='mem:index:bm25';
function fixture() {
  const vec=Buffer.from(new Float32Array([1,2,3]).buffer).toString('base64');
  const rows = ['obs_a','obs_b','obs_c'].map((id,i)=>({id,s:'s',q:i+1,e:vec,k:'observation'}));
  const scopes = new Map<string,Map<string,any>>([
    [pending,new Map(rows.map(r=>[r.id,r]))],
    [index,new Map([['vectors:meta',{v:3,count:3,bucketCount:1,savedAt:'2026-01-01T00:00:00.000Z'}]])],
    [vectorBucketScope(0),new Map(rows.map(({id,s,e})=>[id,{id,s,e}]))],
  ]);
  let held=true;
  const kv = {
    backend:'file',
    readVectorRetention: async()=>[...scopes.get('receipts')?.values()??[]],
    delete: async(scope:string,key:string)=>scopes.get(scope)?.delete(key),
    durability:{completion:'sdk',waitForKeys:async()=>({completed:true,synced:false})},
    get:async(scope:string,key:string)=>scopes.get(scope)?.get(key)??null,
    set:async(scope:string,key:string,v:unknown)=>{if(!scopes.has(scope))scopes.set(scope,new Map());scopes.get(scope)!.set(key,v);},
    list:async(scope:string)=>[...scopes.get(scope)?.values()??[]],
    reconcileVectorCheckpoint:vi.fn(async(data:{pendingRows:typeof rows},current:()=>boolean,_rev:number,authorize:boolean)=>{
      if(!current())throw Error('stale');
      const desired=data.pendingRows.map(row=>receiptFor(row as never,0));
      const stored=scopes.get('receipts')??new Map();
      if ([...stored].some(([key])=>!desired.some(row=>row.digest===key))) throw Error('original changed');
      if (!authorize && desired.some(row=>!stored.has(row.digest))) throw Error('new WAL');
      scopes.set('receipts',new Map(desired.map(row=>[row.digest,row])));
      return desired;
    }),
  };
  const v=new VectorIndex();
  const p=new IndexPersistence(kv as never,v,{requireRecoveryPlan:true,isStorageHeld:()=>held});
  const release=async(explicit:boolean)=>{await p.load();held=false;return p.resumeStorageRecovery(3,explicit);};
  return {scopes,rows,kv,v,p,release};
}

describe('operator-requested vector checkpoint recovery',()=>{
 it('certifies three exact rows before release and does not replay them',async()=>{
  const f=fixture();try{
   expect(await f.release(true)).toBe(true);
   expect(f.kv.reconcileVectorCheckpoint).toHaveBeenCalledTimes(1);
   expect(f.kv.reconcileVectorCheckpoint.mock.calls[0][0]).toMatchObject({pendingRows:f.rows,buckets:[{bucket:0,ids:f.rows.map(r=>r.id)}]});
   expect(f.v.size).toBe(3);expect([...f.scopes.get(pending)!.values()]).toEqual(f.rows);
   expect(f.p.status()).toMatchObject({pendingLog:3,pendingLogAcknowledged:0,retainedCheckpointRows:3,pendingChanges:0});
   expect(()=>f.v.add('obs_a','s',new Float32Array([3,2,1]))).toThrow(/PAUSED/);
   expect(()=>f.v.remove('obs_b')).toThrow(/PAUSED/);expect(()=>f.v.clear()).toThrow(/PAUSED/);expect(()=>f.v.markAllChanged()).toThrow(/PAUSED/);
   const added=new Float32Array([4,5,6]);
   f.v.add('new','s',added);await f.p.save();
   expect(f.scopes.get(vectorBucketScope(0))!.get('new')).toMatchObject({id:'new'});
   expect([...f.scopes.get(pending)!.values()]).toEqual(f.rows);
   expect(f.p.status()).toMatchObject({pendingChanges:0,pendingLog:3});
   expect(await f.p.verifyCaptureVectorPending('obs_a','s',f.rows[0])).toBe(true);
   expect(await f.p.verifyCaptureVectorPending('obs_a','s',null)).toBe(false);
   expect(await f.p.verifyCaptureVectorPending('obs_a','other',f.rows[0])).toBe(false);
   expect(await f.p.verifyCaptureVectorPending('obs_a','s',{...f.rows[0],q:9})).toBe(false);
   expect(await f.p.verifyCaptureVectorPending('new','s',null)).toBe(true);
   expect(await f.p.verifyCaptureVectorPending('new','s',f.rows[0])).toBe(false);
   expect(f.kv.reconcileVectorCheckpoint.mock.calls.at(-1)?.[3]).toBe(false);
   const next=new VectorIndex(),p2=new IndexPersistence(f.kv as never,next,{requireRecoveryPlan:true});
   try{
     const loaded=await p2.load();expect(loaded.state).toBe('buckets');await p2.prepareBackfill(loaded);
     next.restoreFrom(loaded.vector!);
     expect(await p2.replayPendingLog(3)).toMatchObject({entries:0,added:0});
     expect(next.size).toBe(4);expect(next.pendingChanges).toBe(0);
     expect(()=>next.markRemoved('obs_a')).toThrow(/PAUSED/);
     await p2.save();expect([...f.scopes.get(pending)!.values()]).toEqual(f.rows);
     expect(f.kv.reconcileVectorCheckpoint.mock.calls.at(-1)?.[3]).toBe(false);
   }finally{p2.stop();}
  }finally{f.p.stop();}
 });
 it.each(['updated q','mismatched bytes','additional row','missing row','clear'])('fails closed on subsequent boot with %s',async mode=>{
   const f=fixture();const v2=new VectorIndex(),p2=new IndexPersistence(f.kv as never,v2,{requireRecoveryPlan:true});
   try{
     expect(await f.release(true)).toBe(true);const log=f.scopes.get(pending)!;
     if(mode==='updated q')log.set('obs_a',{...f.rows[0],q:12});
     if(mode==='mismatched bytes')log.set('obs_a',{...f.rows[0],e:Buffer.from(new Float32Array([8,2,3]).buffer).toString('base64')});
     if(mode==='additional row')log.set('extra',{...f.rows[0],id:'extra',q:18});
     if(mode==='missing row')log.delete('obs_a');
     if(mode==='clear')log.set('~clear',{q:19,c:1});
     const before=new Map(log);
     expect((await p2.load()).state).toBe('unavailable');expect(p2.isRecoveryPaused()).toBe(true);
     await p2.replayPendingLog(3);await p2.save();expect(log).toEqual(before);
     expect(()=>v2.add('obs_a','s',new Float32Array(3))).toThrow(/PAUSED/);
   }finally{f.p.stop();p2.stop();}
 });
 it('requires an explicit request even when all checkpoints match',async()=>{
  const f=fixture();try{expect(await f.release(false)).toBe(false);expect(f.kv.reconcileVectorCheckpoint).not.toHaveBeenCalled();expect(f.scopes.get(pending)!.size).toBe(3);}finally{f.p.stop();}
 });
 it.each(['clear','tombstone','duplicate ID in two buckets','checkpoint shortfall','mismatched vector'])('retains the originals on %s',async reason=>{
  const f=fixture();
  if(reason==='clear')f.scopes.get(pending)!.set('~clear',{q:20,c:1});
  if(reason==='tombstone')f.scopes.get(pending)!.set('obs_a',{q:1,id:'obs_a',t:1});
  if(reason==='duplicate ID in two buckets'){f.scopes.get(index)!.get('vectors:meta').bucketCount=2;f.scopes.set(vectorBucketScope(1),new Map(f.scopes.get(vectorBucketScope(0))));}
  if(reason==='checkpoint shortfall')f.scopes.get(index)!.get('vectors:meta').count=42;
  if(reason==='mismatched vector')f.scopes.get(vectorBucketScope(0))!.get('obs_a').e=Buffer.from(new Float32Array([9,2,3]).buffer).toString('base64');
  const before=new Map(f.scopes.get(pending));
  try{expect(await f.release(true)).toBe(false);expect(f.kv.reconcileVectorCheckpoint).not.toHaveBeenCalled();expect(f.scopes.get(pending)).toEqual(before);}finally{f.p.stop();}
 });
});
