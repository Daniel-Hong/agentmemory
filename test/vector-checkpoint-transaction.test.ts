import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {StateKV} from '../src/state/kv.js';
import {acquireFileWriterLease} from '../src/ops/file-writer-lease.mjs';
import {engineFixture} from './helpers/engine-evidence.js';

const pending='mem:index:vec-pending', index='mem:index:bm25', bucket=index+':vec:0000';
const dirs:string[]=[];
afterEach(()=>{vi.unstubAllEnvs();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function archive(value:unknown){
 const bytes=Buffer.from(JSON.stringify(value));
 if(bytes.length<=8){const inline=Buffer.alloc(8,0xff);bytes.copy(inline);return inline;}
 const root=Math.ceil(bytes.length/4)*4,out=Buffer.alloc(root+8);
 bytes.copy(out);out.writeUInt32LE((bytes.length&63)+128+Math.floor(bytes.length/64)*256,root);out.writeInt32LE(-root,root+4);
 return out;
}
function fixture(){
 const store=mkdtempSync(join(tmpdir(),'am-vector-proof-'));dirs.push(store);vi.stubEnv('AGENTMEMORY_STATE_STORE_PATH',store);
 const {evidence}=engineFixture(store);const lease=acquireFileWriterLease(store,{evidence});
 const data=new Map<string,Map<string,any>>(),path=(scope:string)=>join(store,encodeURIComponent(scope)+'.bin');
 const write=(scope:string)=>writeFileSync(path(scope),archive(Object.fromEntries(data.get(scope)!)));
 const rows=[1,2,3].map(q=>({id:'vec_'+q,s:'session',e:'AACAPw==',q}));
 const meta={v:3,count:3,bucketCount:1,savedAt:'2026-01-01T00:00:00.000Z'};
 data.set(index,new Map([['vectors:meta',meta]]));data.set(bucket,new Map(rows.map(({id,s,e})=>[id,{id,s,e}])));
 data.set(pending,new Map(rows.map(row=>[row.id,row])));
 for(const scope of data.keys())write(scope);
 const receipts='mem:index:vec-retained:v1';
 const actions:Array<{scope:string,key:string,op:string}>=[];let onSet=async(_key:string)=>{};
 const sdk={trigger:async({function_id,payload:{scope,key,value}}:any)=>{
  const scoped=data.get(scope)??new Map();data.set(scope,scoped);
  if(function_id==='state::list')return [...scoped.values()];
  if(function_id==='state::get')return scoped.get(key)??null;
  if(function_id==='state::delete')throw Error('unexpected destructive SDK call');
  if(function_id==='state::set'){await onSet(key);actions.push({scope,key,op:'set'});scoped.set(key,value);write(scope);return value;}
  throw Error('unexpected SDK call');
 }};
 const kv=new StateKV(sdk as never,{writerLease:lease});
 const selection=(rs=rows)=>({pendingRows:rs,meta,buckets:[{bucket:0,ids:rs.map(row=>row.id)}]});
 const prove=(authorize=true)=>kv.reconcileVectorCheckpoint(selection(),()=>true,kv.vectorCheckpointRevision,authorize);
 return {kv,lease,rows,disk:path,actions,data,selection,receipts,prove,write,onSet:(fn:typeof onSet)=>{onSet=fn;}};
}
it('certifies three original rows without modifying their buckets or WAL, including retry or restart',async()=>{
 const x=fixture(),initial=readFileSync(x.disk(bucket)),wal=readFileSync(x.disk(pending));
 try{
  const result=await x.prove();expect(result).toHaveLength(3);
  expect(x.actions).toEqual(result.map(s=>({scope:x.receipts,key:s.digest,op:'set'})));
  expect(await x.prove()).toEqual(result);expect(await x.prove(false)).toEqual(result);
  expect(x.actions).toHaveLength(3);
  expect(readFileSync(x.disk(pending))).toEqual(wal);
  expect(readFileSync(x.disk(bucket))).toEqual(initial);
 }finally{x.lease.close();}
});
it.each(['changed disk checkpoint','lost authorization','no manual authority'])('performs no writes on %s',async mode=>{
 const x=fixture();try{
  if(mode==='changed disk checkpoint')writeFileSync(x.disk(bucket),archive({}));
  await expect(x.kv.reconcileVectorCheckpoint(x.selection(),()=>mode!=='lost authorization',x.kv.vectorCheckpointRevision,mode!=='no manual authority')).rejects.toThrow();
  expect(x.actions).toHaveLength(0);
 }finally{x.lease.close();}
});
it('retains all source records and blocks same-epoch retry on failed receipt creation',async()=>{
 const x=fixture(),wal=readFileSync(x.disk(pending));try{
  let n=0;x.onSet(async()=>{if(++n===2)throw Error('disconnected');});
  await expect(x.prove()).rejects.toThrow();expect(x.actions).toHaveLength(1);
  await expect(x.prove()).rejects.toThrow(/unverified/);
  expect(readFileSync(x.disk(pending))).toEqual(wal);
 }finally{x.lease.close();}
});
it('refuses changed remote bytes even after a receipt write without deleting the changed original',async()=>{
 const x=fixture();try{
  const changed={...x.rows[0],q:17};x.onSet(async()=>{x.data.get(pending)!.set(changed.id,changed);x.write(pending);});
  await expect(x.prove()).rejects.toThrow();
  expect(x.data.get(pending)!.get(changed.id)).toEqual(changed);
  expect(x.actions.every(a=>a.scope===x.receipts)).toBe(true);
  await expect(x.prove()).rejects.toThrow();
 }finally{x.lease.close();}
});
it('serializes a new local WAL key until all originals have been reverified',async()=>{
 const x=fixture();let release!:()=>void,signal!:()=>void;
 const reached=new Promise<void>(r=>signal=r);const wait=new Promise<void>(r=>release=r);
 try{
  x.onSet(async()=>{signal();await wait;});
  const repair=x.prove();await reached;
  const newRow={...x.rows[0],id:'different',q:5};
  const write=x.kv.set(pending,newRow.id,newRow);
  await new Promise(r=>setTimeout(r,10));
  expect(x.data.get(pending)!.has(newRow.id)).toBe(false);release();await repair;await write;
  expect([...x.data.get(pending)!.keys()]).toEqual([...x.rows.map(r=>r.id),'different']);
 }finally{release?.();x.lease.close();}
});
it('rejects a checkpoint changed while the SDK was discovering its bucket map',async()=>{
 const x=fixture();try{
  const revision=x.kv.vectorCheckpointRevision;
  await x.kv.set(bucket,'new-after-load',{id:'new-after-load',s:'s',e:'AACAPw=='});
  await expect(x.kv.reconcileVectorCheckpoint(x.selection(),()=>true,revision,true)).rejects.toThrow(/checkpoint_changed/);
  expect(x.actions.some(a=>a.scope===x.receipts)).toBe(false);
 }finally{x.lease.close();}
});
