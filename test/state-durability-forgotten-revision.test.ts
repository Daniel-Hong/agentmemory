import {it,expect} from 'vitest';
import {mkdtemp,writeFile,rename,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createStateDurabilityFence} from '../src/ops/state-durability.mjs';

async function overlappingCertificates(mode:'latest'|'corrupt'|'pinned'){
 const dir=await mkdtemp('/tmp/am-forgotten-revision-'),scope='synthetic-index',key='vectors:meta',file=join(dir,encodeURIComponent(scope)+'.bin');
 let value:any=null,release!:()=>void,captured!:()=>void,first=true;
 const gate=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{captured=r;});
 const fence=createStateDurabilityFence({storePath:dir,timeoutMs:1000,pollIntervalMs:5,completion:'disk'});
 const kv={get:async()=>{const selected=structuredClone(value);if(first){first=false;captured();await gate;}return selected;}};
 const publish=async(count:number)=>fence.mutate(scope,key,async()=>{value={v:3,count,bucketCount:1};await writeFile(file+'.next',JSON.stringify({[key]:value}));await rename(file+'.next',file);});
 try{
  await publish(1);const early=fence.waitForKeys(kv,[{scope,key}],mode==='pinned'?{expectedValues:[structuredClone(value)]}:undefined).then((receipt:any)=>({status:'fulfilled',receipt}),error=>({status:'rejected',code:error.code}));
  await ready;await publish(2);const later=await fence.waitForKeys(kv,[{scope,key}]);expect(later.synced).toBe(true);expect(fence.keys()).toEqual([]);
  if(mode==='corrupt'){await writeFile(file+'.next',JSON.stringify({[key]:{v:3,count:999,bucketCount:1}}));await rename(file+'.next',file);}
  release();const result=await early;await fence.drain();const disk=JSON.parse(await readFile(file,'utf8'));
  return{result,disk,sdkValue:value};
 }finally{release();await fence.drain();await rm(dir,{recursive:true,force:true});}
}
it('recaptures a superseding local revision after another certificate has already forgotten its dirty key',async()=>{
 const{result,disk,sdkValue}=await overlappingCertificates('latest');expect(result).toMatchObject({status:'fulfilled',receipt:{synced:true}});expect(disk['vectors:meta']).toEqual(sdkValue);expect(sdkValue.count).toBe(2);
});
it('still refuses a disk value that differs from the recaptured latest SDK value',async()=>{
 const{result,disk,sdkValue}=await overlappingCertificates('corrupt');expect(result).toMatchObject({status:'rejected',code:'STATE_DURABILITY_TIMEOUT'});expect(disk['vectors:meta']).not.toEqual(sdkValue);
});
it('does not turn an exact pinned old-value receipt into a superseding-value receipt',async()=>{
 const{result,disk}=await overlappingCertificates('pinned');expect(result).toMatchObject({status:'rejected',code:'STATE_DURABILITY_TIMEOUT'});expect(disk['vectors:meta'].count).toBe(2);
});
it('tracks a third local publication that is certified while the first certificate recaptures',async()=>{
 const dir=await mkdtemp('/tmp/am-recapture-third-'),scope='synthetic-index',key='vectors:meta',file=join(dir,encodeURIComponent(scope)+'.bin');let value:any,calls=0;
 let releaseFirst!:()=>void,releaseRecapture!:()=>void,firstCaptured!:()=>void,recaptured!:()=>void;
 const firstGate=new Promise<void>(r=>{releaseFirst=r;}),recaptureGate=new Promise<void>(r=>{releaseRecapture=r;}),firstReady=new Promise<void>(r=>{firstCaptured=r;}),recaptureReady=new Promise<void>(r=>{recaptured=r;});
 const fence=createStateDurabilityFence({storePath:dir,timeoutMs:1000,pollIntervalMs:5,completion:'disk'});
 const kv={get:async()=>{const copy=structuredClone(value);const call=++calls;if(call===1){firstCaptured();await firstGate;}if(call===3){recaptured();await recaptureGate;}return copy;}};
 const publish=async(count:number)=>fence.mutate(scope,key,async()=>{value={v:3,count,bucketCount:1};await writeFile(file+'.next',JSON.stringify({[key]:value}));await rename(file+'.next',file);});
 try{
  await publish(1);const early=fence.waitForKeys(kv,[{scope,key}]);await firstReady;
  await publish(2);await fence.waitForKeys(kv,[{scope,key}]);releaseFirst();await recaptureReady;
  await publish(3);await fence.waitForKeys(kv,[{scope,key}]);releaseRecapture();await expect(early).resolves.toMatchObject({synced:true});
  expect(JSON.parse(await readFile(file,'utf8'))[key]).toEqual(value);expect(value.count).toBe(3);
 }finally{releaseFirst();releaseRecapture();await fence.drain();await rm(dir,{recursive:true,force:true});}
});
it('can verify the same key after an earlier capture rejects',async()=>{
 const dir=await mkdtemp('/tmp/am-recapture-reject-'),scope='synthetic-index',key='vectors:meta',file=join(dir,encodeURIComponent(scope)+'.bin');let value:any={v:3,count:1,bucketCount:1};
 const fence=createStateDurabilityFence({storePath:dir,timeoutMs:1000,pollIntervalMs:5,completion:'disk'});
 try{
  await fence.mutate(scope,key,async()=>{});await expect(fence.waitForKeys({get:async()=>{throw Error('synthetic capture rejection');}},[{scope,key}])).rejects.toMatchObject({code:'STATE_DURABILITY_TIMEOUT'});
  await fence.mutate(scope,key,async()=>{value={...value,count:2};await writeFile(file,JSON.stringify({[key]:value}));});
  await expect(fence.waitForKeys({get:async()=>structuredClone(value)},[{scope,key}])).resolves.toMatchObject({synced:true});expect(fence.keys()).toEqual([]);
 }finally{await fence.drain();await rm(dir,{recursive:true,force:true});}
});
