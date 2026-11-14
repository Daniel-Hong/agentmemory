import {openSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
if(!process.send||process.env.FIXTURE_DIR!==join(process.env.HOME,'spool'))throw Error('FIXTURE_ISOLATION');
if(process.env.MODE==='holder'){
 const fd=openSync(join(process.env.FIXTURE_DIR,'queue/lease.lock'),'r+');
 const lock=spawnSync('/usr/bin/flock',['--exclusive','--nonblock','3'],{stdio:['ignore','ignore','ignore',fd]});
 if(lock.status!==0)throw Error('FIXTURE_LOCK_FAILED');
 process.send({ready:true});
 process.once('message',message=>setTimeout(()=>{closeSync(fd);process.disconnect();},message.holdMs));
}else{
 const {deliverSdkCaptureV2}=await import(pathToFileURL(process.env.FIXTURE_MODULE));
 process.send({ready:true});
 process.once('message',async()=>{
  const started=performance.now(),phases=[];let posts=0;process.send({started:true});
  const result=await deliverSdkCaptureV2(process.env.FIXTURE_TARGET,{eventId:'multiprocess-'+process.env.FIXTURE_INDEX},async body=>{posts++;return {status:201,body:{eventId:body.eventId,completion:'sdk',completed:true,durable:false}};},{dir:process.env.FIXTURE_DIR,deadline:started+3000,storeOptions:{onPhase:phase=>phases.push({phase,elapsedMs:performance.now()-started})}});
  process.send({result:{...result,posts,elapsedMs:performance.now()-started,phases}});process.disconnect();
 });
}
