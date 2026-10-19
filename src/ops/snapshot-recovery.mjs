import {mkdir,chmod,lstat,open,rename,unlink,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

export async function ensurePrivateSnapshotDir(dir){
 await mkdir(dir,{recursive:true,mode:0o700});
 if(!(await lstat(dir)).isDirectory())throw Object.assign(Error('invalid_snapshot_directory'),{code:'SNAPSHOT_DIRECTORY'});
 await chmod(dir,0o700);
}

export async function publishSnapshotFile(dir,name,content){
 await ensurePrivateSnapshotDir(dir);
 const path=join(dir,name),temp=path+'.'+randomUUID()+'.tmp';
 let file;
 try{
  file=await open(temp,'wx',0o600);
  await file.writeFile(content,'utf8');await file.sync();await file.close();file=null;
  await rename(temp,path);
  const directory=await open(dir,'r');try{await directory.sync();}finally{await directory.close();}
 }finally{if(file)await file.close();await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}

// This is a partial application export; Lessons, source cursors and retries are not restored by the legacy format.
export function createSnapshotRecovery({dir,intervalMs,gitExec,create,isPaused=()=>false,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}){
 const metadataName='.snapshot-schedule.json';
 let state={version:1,lastSuccessAt:null,lastCommitHash:null,lastAttemptAt:null,nextAttemptAt:0,failures:0,lastErrorCode:null};
 let initialized=false,closed=false,timer=null,activeTick=null,activeCreate=null,initializing=null,nextCheckAt=null,initError=null;
 const errorCode=e=>typeof e?.code==='string'&&/^[A-Z0-9_]+$/.test(e.code)?e.code:'SNAPSHOT_FAILED';
 const retryDelay=()=>Math.min(15*60*1000,60*1000*2**Math.min(state.failures,4));
 const save=()=>publishSnapshotFile(dir,metadataName,JSON.stringify(state)+'\n');
 async function init(){
  if(initialized)return;
  if(initializing)return initializing;
  initializing=(async()=>{
   let saved;
   try{saved=JSON.parse(await readFile(join(dir,metadataName),'utf8'));}
   catch(e){if(e.code!=='ENOENT')throw Object.assign(Error('invalid_snapshot_schedule'),{code:e instanceof SyntaxError?'SNAPSHOT_METADATA_INVALID':errorCode(e)});}
   if(saved){
    if(saved.version!==1||!Number.isFinite(saved.nextAttemptAt)||saved.nextAttemptAt<0||!Number.isInteger(saved.failures)||saved.failures<0||
       (saved.lastSuccessAt!==null&&!Number.isFinite(Date.parse(saved.lastSuccessAt)))||
       (saved.lastAttemptAt!==null&&!Number.isFinite(Date.parse(saved.lastAttemptAt)))||
       (saved.lastCommitHash!==null&&!/^[0-9a-f]{40}$/i.test(saved.lastCommitHash))||
       (saved.lastErrorCode!==null&&!/^[A-Z0-9_]+$/.test(saved.lastErrorCode)))throw Object.assign(Error('invalid_snapshot_schedule'),{code:'SNAPSHOT_METADATA_INVALID'});
    state={...state,...saved};
   }else{
    // Read existing history without checking out files or changing the KV store.
    try{
     await lstat(join(dir,'.git'));
     await gitExec(dir,['rev-parse','--is-inside-work-tree']);
     const line=await gitExec(dir,['log','--all','-1','--format=%H|%ct','--','state.json']);
     if(line){const [hash,seconds]=line.split('|');const stamp=Number(seconds)*1000;
      if(!/^[0-9a-f]{40}$/i.test(hash)||!Number.isFinite(stamp))throw Object.assign(Error('invalid_snapshot_history'),{code:'SNAPSHOT_HISTORY_INVALID'});
      state.lastSuccessAt=new Date(stamp).toISOString();state.lastCommitHash=hash;
     }
    }catch(e){if(e.code!=='ENOENT')throw e;}
   }
   initialized=true;initError=null;
  })().catch(e=>{initError=errorCode(e);throw e;}).finally(()=>{initializing=null;});
  return initializing;
 }
 function due(){return state.failures>0||state.lastErrorCode?state.nextAttemptAt:Math.max(state.lastSuccessAt?Date.parse(state.lastSuccessAt)+intervalMs:0,state.nextAttemptAt);}
 function schedule(delay){
  if(closed)return;
  if(timer)clearTimer(timer);
  nextCheckAt=new Date(now()+delay).toISOString();
  timer=setTimer(()=>{timer=null;void tick();},delay);timer?.unref?.();
 }
 async function failed(e){
  state.lastErrorCode=errorCode(e);state.failures=Math.min(state.failures+1,16);state.nextAttemptAt=now()+retryDelay();
  if(initialized)try{await save();}catch{state.lastErrorCode='SNAPSHOT_METADATA_WRITE_FAILED';}
 }
 async function runCreate(fn){
  if(closed||isPaused())return{success:false,deferred:true,reason:closed?'snapshot_stopped':'background_paused'};
  if(activeCreate)return{success:false,deferred:true,reason:'snapshot_in_progress'};
  activeCreate=(async()=>{
   try{
    await init();
    state.lastAttemptAt=new Date(now()).toISOString();state.nextAttemptAt=now()+retryDelay();
    await save(); // Persist admission cooldown before exporting, including across a crash/reboot.
    const result=await fn();
    if(result?.success!==true||(!result.snapshot?.commitHash&&!result.commitHash))throw Object.assign(Error('snapshot_failed'),{code:result?.errorCode||'SNAPSHOT_FAILED'});
    state.lastSuccessAt=new Date(now()).toISOString();state.lastCommitHash=result.snapshot?.commitHash||result.commitHash;
    state.failures=0;state.lastErrorCode=null;state.nextAttemptAt=0;
    await save();return result;
   }catch(e){
    await failed(e);
    return{success:false,error:state.lastErrorCode,errorCode:state.lastErrorCode};
   }
  })();
  try{return await activeCreate;}finally{activeCreate=null;}
 }
 async function tick(){
  if(closed||activeTick)return;
  activeTick=(async()=>{
   try{await init();if(!isPaused()&&now()>=due())await create();}
   catch(e){if(initialized)await failed(e);else initError=errorCode(e);}
  })();
  try{await activeTick;}finally{
   activeTick=null;
   schedule(!initialized?15*60*1000:isPaused()?30*1000:Math.max(1000,Math.min(30*1000,due()-now())));
  }
 }
 return {
  init,runCreate,
  start(){schedule(0);},
  async drain(){if(activeTick)await activeTick;if(activeCreate)await activeCreate;if(initializing)await initializing;},
  async stop(){closed=true;if(timer)clearTimer(timer);timer=null;nextCheckAt=null;if(activeTick)await activeTick;if(activeCreate)await activeCreate;},
  snapshot(){return{status:closed?'stopped':initError?'error':activeCreate?'running':!initialized?'queued':isPaused()?'paused':state.lastErrorCode?'retrying':now()>=due()?'queued':'current',lastSuccessAt:state.lastSuccessAt,lastCommitHash:state.lastCommitHash,lastAttemptAt:state.lastAttemptAt,lastErrorCode:initError||state.lastErrorCode,failures:state.failures,nextAttemptAt:state.nextAttemptAt?new Date(state.nextAttemptAt).toISOString():null,nextCheckAt,intervalMs,format:'partial-application-export'};}
 };
}
