import {expect,it} from 'vitest';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifiedShutdown} from '../src/ops/verified-shutdown.js';
it('reports completed SDK shutdown without claiming disk verification',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sdk-shutdown-'));
 try{
  const outcome=await verifiedShutdown({receiptDir:dir,engineAlive:()=>true,work:async()=>({completion:'sdk',completed:true,synced:false,mutationFailures:0})});
  expect(outcome).toMatchObject({completed:true,verified:false,errorCode:null});
  expect(JSON.parse(await readFile(join(dir,'shutdown-receipt.json'),'utf8'))).toMatchObject({completed:true,verified:false,durability:{completion:'sdk',synced:false}});
 }finally{await rm(dir,{recursive:true,force:true});}
});
it.each([
 {completion:'sdk',completed:true,synced:true,mutationFailures:0},
 {completion:'unknown',completed:true,synced:true,mutationFailures:0},
 {completion:'sdk',completed:true,synced:false,mutationFailures:1},
])('rejects inconsistent or failed completion metadata: %j',async result=>{
 const dir=await mkdtemp(join(tmpdir(),'sdk-shutdown-invalid-'));
 try{expect(await verifiedShutdown({receiptDir:dir,engineAlive:()=>true,work:async()=>result})).toMatchObject({completed:false,verified:false,errorCode:'SHUTDOWN_NOT_VERIFIED'});}
 finally{await rm(dir,{recursive:true,force:true});}
});
