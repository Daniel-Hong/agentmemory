import {afterEach, beforeEach, expect, it} from "vitest";
import {mkdtemp, rename, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {verifyVectorCheckpointFiles, verifyRemainingVectorPending, verifyVectorRetentionReceipts} from "../src/ops/vector-checkpoint-proof.mjs";

const pending = "mem:index:vec-pending", metaScope = "mem:index:bm25", bucket = metaScope + ":vec:0000";
const row = {id:"v1",q:1,s:"session",e:"AACAPw=="};
const vector = {id:row.id,s:row.s,e:row.e};
const metadata = {v:3,bucketCount:1,count:1,savedAt:"2026-11-07T00:00:00Z"};
let storePath:string;
const file = (scope:string) => join(storePath,encodeURIComponent(scope)+".bin");

// rkyv 0.8 LE32 ArchivedString: short JSON is inline, long strings use an aligned length/offset.
function archive(text:string){
  const bytes=Buffer.from(text);
  if(bytes.length<=8){const result=Buffer.alloc(8,0xff);bytes.copy(result);return result;}
  const position=Math.ceil(bytes.length/4)*4,result=Buffer.alloc(position+8);
  bytes.copy(result);
  result.writeUInt32LE((bytes.length & 63) + 128 + Math.floor(bytes.length/64)*256,position);
  result.writeInt32LE(-position,position+4);
  return result;
}
const put = (scope:string, value:unknown) => writeFile(file(scope),archive(JSON.stringify(value)));
const input = () => ({storePath,pendingRows:[{...row}],meta:{...metadata},buckets:[{bucket:0,ids:["v1"]}],admitted:()=>true});
beforeEach(async()=>{
  storePath=await mkdtemp(join(tmpdir(),"am-vector-proof-"));
  await put(pending,{v1:row});await put(metaScope,{"vectors:meta":metadata});await put(bucket,{v1:vector});
});
afterEach(async()=>{await rm(storePath,{recursive:true,force:true});});

it("matches physical keys and SDK values under one admitted generation",async()=>{
  const check=await verifyVectorCheckpointFiles(input());
  await expect(check()).resolves.toBeUndefined();
  await expect(verifyRemainingVectorPending({...input(),pendingRows:[]})).rejects.toThrow();
  await rm(file(pending));
  await expect(verifyRemainingVectorPending({...input(),pendingRows:[]})).resolves.toBeUndefined();
  await put(pending,{});
  await expect(verifyRemainingVectorPending({...input(),pendingRows:[]})).resolves.toBeUndefined();
});
it.each(["alias","extra","trailer","duplicate","changed_meta","symlink","unadmitted"])("refuses %s",async kind=>{
  const opts=input();
  if(kind==="alias")await put(bucket,{other:vector});
  if(kind==="extra")await put(pending,{v1:row,stale:{...row,id:"stale",q:2}});
  if(kind==="trailer"){const buf=archive(JSON.stringify({v1:row}));buf.writeInt32LE(0,buf.length-4);await writeFile(file(pending),buf);}
  if(kind==="duplicate")await writeFile(file(pending),archive('{"v1":'+JSON.stringify(row)+',"v1":'+JSON.stringify(row)+'}'));
  if(kind==="changed_meta")await put(metaScope,{"vectors:meta":{...metadata,count:2}});
  if(kind==="symlink"){await rename(file(bucket),file("elsewhere"));await symlink(file("elsewhere"),file(bucket));}
  if(kind==="unadmitted")opts.admitted=()=>false;
  await expect(verifyVectorCheckpointFiles(opts)).rejects.toThrow();
});
it("rejects same-byte inode replacement or a lost writer before mutation",async()=>{
  let admitted=true;
  const check=await verifyVectorCheckpointFiles({...input(),admitted:()=>admitted});
  admitted=false;await expect(check()).rejects.toThrow();
  admitted=true;await rename(file(bucket),file("old"));await put(bucket,{v1:vector});
  await expect(check()).rejects.toThrow();
});

it("rejects an extra physical copy of a selected ID even under another key or selected bucket",async()=>{
  const second={...row,id:"v2",q:2},meta={...metadata,bucketCount:2,count:2};
  await put(pending,{v1:row,v2:second});await put(metaScope,{"vectors:meta":meta});
  await put(metaScope+":vec:0001",{v2:{...vector,id:"v2"},other:vector});
  await expect(verifyVectorCheckpointFiles({...input(),meta,pendingRows:[row,second],
    buckets:[{bucket:0,ids:["v1"]},{bucket:1,ids:["v2"]}]})).rejects.toThrow();
});

it("never treats a missing namespace as evidence for remaining work",async()=>{
  await rm(file(pending));
  await expect(verifyRemainingVectorPending(input())).rejects.toThrow();
  await expect(verifyVectorCheckpointFiles(input())).rejects.toThrow();
  await symlink(file("missing"),file(pending));
  await expect(verifyRemainingVectorPending({...input(),pendingRows:[]})).rejects.toThrow();
});

it("rejects ambiguous sequence numbers and invalid float data before proof",async()=>{
  await expect(verifyRemainingVectorPending({...input(),pendingRows:[row,{...row,id:"v2"}]})).rejects.toThrow();
  const bad={...row,e:Buffer.from(new Float32Array([NaN]).buffer).toString("base64")};
  await put(pending,{v1:bad});
  await expect(verifyRemainingVectorPending({...input(),pendingRows:[bad]})).rejects.toThrow();
});

const retained = "mem:index:vec-retained:v1";
const digest = "ab".repeat(32), otherDigest = "cd".repeat(32);
const stamp = {v:1,id:"v1",q:1,bucket:0,digest};
const retention = (receipts:Record<string,unknown>, admitted=()=>true) =>
  verifyVectorRetentionReceipts({storePath,receipts,admitted});

it("proves exactly all receipt keys and accepts an absent namespace only for zero receipts",async()=>{
  await expect(retention({})).resolves.toBeUndefined();
  await expect(retention({[digest]:stamp})).rejects.toThrow();
  await put(retained,{[digest]:stamp});
  await expect(retention({[digest]:stamp})).resolves.toBeUndefined();
  await expect(retention({})).rejects.toThrow();
  const other={...stamp,digest:otherDigest,id:"v2",q:2};
  await put(retained,{[otherDigest]:other,[digest]:stamp});
  await expect(retention({[digest]:stamp,[otherDigest]:other})).resolves.toBeUndefined();
  await expect(retention({[digest]:stamp})).rejects.toThrow();
});

it.each(["digest","key","version","extra","missing","empty_id","clear_id","id_length","sequence","bucket",
  "duplicate_id","duplicate_q","too_many"])("rejects invalid retention receipt %s even on matching disk",async kind=>{
  const row:Record<string,unknown>={...stamp};
  const receipts:Record<string,unknown>={[digest]:row};
  if(kind==="digest")row.digest=otherDigest;
  if(kind==="key"){delete receipts[digest];row.digest="X".repeat(64);receipts[String(row.digest)]=row;}
  if(kind==="version")row.v=2;
  if(kind==="extra")row.unsupported=true;
  if(kind==="missing")delete row.bucket;
  if(kind==="empty_id")row.id="";
  if(kind==="clear_id")row.id="~clear";
  if(kind==="id_length")row.id="a".repeat(513);
  if(kind==="sequence")row.q=0;
  if(kind==="bucket")row.bucket=-1;
  if(kind==="duplicate_id")receipts[otherDigest]={...stamp,digest:otherDigest,q:2};
  if(kind==="duplicate_q")receipts[otherDigest]={...stamp,digest:otherDigest,id:"v2"};
  if(kind==="too_many")for(let i=1;i<=16;i++){
    const d=i.toString(16).padStart(64,"0");receipts[d]={...stamp,id:"v"+(i+1),q:i+1,digest:d};
  }
  await put(retained,receipts);
  await expect(retention(receipts)).rejects.toThrow();
});

it("refuses duplicate physical receipt keys, a symlink and writer loss during recheck", async()=>{
  const receipts={[digest]:stamp};
  const kv=JSON.stringify(digest)+":"+JSON.stringify(stamp);
  await writeFile(file(retained),archive("{"+kv+","+kv+"}"));
  await expect(retention(receipts)).rejects.toThrow();
  await rename(file(retained),file("old-receipts"));
  await symlink(file("old-receipts"),file(retained));
  await expect(retention(receipts)).rejects.toThrow();
  await rm(file(retained));
  await put(retained,receipts);
  let checks=0;
  await expect(retention(receipts,()=>++checks<4)).rejects.toThrow();
});

it('waits for a previous savedAt to flush, then still checks the complete selected bucket',async()=>{
 const stale={...metadata,savedAt:'2026-11-06T23:59:59Z'};
 await put(metaScope,{'vectors:meta':stale});await put(bucket,{v1:{...vector,e:'AAAAAA=='}});
 const flushed=new Promise<void>((resolve,reject)=>setTimeout(()=>{put(metaScope,{'vectors:meta':metadata}).then(resolve,reject);},175));
 await expect(verifyVectorCheckpointFiles({...input(),waitForCaptureMeta:true})).rejects.toThrow('VECTOR_CHECKPOINT_UNVERIFIED');
 await flushed;
 await put(metaScope,{'vectors:meta':stale});await put(bucket,{v1:vector});
 const next=new Promise<void>((resolve,reject)=>setTimeout(()=>{put(metaScope,{'vectors:meta':metadata}).then(resolve,reject);},175));
 const recheck=await verifyVectorCheckpointFiles({...input(),waitForCaptureMeta:true});
 await next;await recheck();
});
it.each(['persistent lag','revoked epoch'])('keeps the original rejection on %s during capture proof',async mode=>{
 await put(metaScope,{'vectors:meta':{...metadata,savedAt:'2026-11-06T23:59:59Z'}});
 let active=true;const timer=mode==='revoked epoch'?setTimeout(()=>{active=false},100):undefined;
 try{await expect(verifyVectorCheckpointFiles({...input(),admitted:()=>active,waitForCaptureMeta:true})).rejects.toThrow('VECTOR_CHECKPOINT_UNVERIFIED');}
 finally{clearTimeout(timer);}
});
