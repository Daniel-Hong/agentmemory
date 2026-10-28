import {mkdir,chmod,lstat,open,rename,unlink,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

async function* bufferedSnapshotChunks(content,signal){
 const capacity=64*1024,encoder=new TextEncoder();
 let buffer=Buffer.allocUnsafe(capacity),used=0;
 for await(const chunk of content){
  signal?.throwIfAborted();
  if(typeof chunk==='string'){
   let offset=0;
   while(offset<chunk.length){
    signal?.throwIfAborted();
    const {read,written}=encoder.encodeInto(chunk.slice(offset),buffer.subarray(used));
    offset+=read;used+=written;
    if(used===capacity||read===0){yield buffer.subarray(0,used);buffer=Buffer.allocUnsafe(capacity);used=0;}
   }
  }else{
   if(!ArrayBuffer.isView(chunk))throw new TypeError('snapshot chunk must be a string or buffer view');
   const bytes=Buffer.from(chunk.buffer,chunk.byteOffset,chunk.byteLength);
   let offset=0;
   while(offset<bytes.length){
    signal?.throwIfAborted();
    const count=Math.min(capacity-used,bytes.length-offset);
    bytes.copy(buffer,used,offset,offset+count);offset+=count;used+=count;
    if(used===capacity){yield buffer;buffer=Buffer.allocUnsafe(capacity);used=0;}
   }
  }
 }
 signal?.throwIfAborted();
 if(used)yield buffer.subarray(0,used);
}

export async function ensurePrivateSnapshotDir(dir){
 await mkdir(dir,{recursive:true,mode:0o700});
 if(!(await lstat(dir)).isDirectory())throw Object.assign(Error('invalid_snapshot_directory'),{code:'SNAPSHOT_DIRECTORY'});
 await chmod(dir,0o700);
}

export async function publishSnapshotFile(dir,name,content,{signal}={}){
 signal?.throwIfAborted();
 await ensurePrivateSnapshotDir(dir);
 const path=join(dir,name),temp=path+'.'+randomUUID()+'.tmp';
 let file;
 try{
  file=await open(temp,'wx',0o600);
  const output=typeof content==='string'||ArrayBuffer.isView(content)?content:bufferedSnapshotChunks(content,signal);
  await file.writeFile(output,{encoding:'utf8',signal});signal?.throwIfAborted();await file.sync();await file.close();file=null;
  signal?.throwIfAborted();
  await rename(temp,path);
  const directory=await open(dir,'r');try{await directory.sync();}finally{await directory.close();}
 }finally{try{if(file)await file.close();}finally{await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}}
}

// This is a partial application export; Lessons, source cursors and retries are not restored by the legacy format.
export function createSnapshotRecovery({dir,intervalMs,gitExec,create,isPaused=()=>false,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}){
 const metadataName='.snapshot-schedule.json';
 let state={version:1,lastSuccessAt:null,lastCommitHash:null,lastAttemptAt:null,lastFinishedAttemptAt:null,lastFinishedErrorCode:null,nextAttemptAt:0,failures:0,lastErrorCode:null};
 let initialized=false,closed=false,timer=null,activeTick=null,activeCreate=null,initializing=null,nextCheckAt=null,initError=null,lastOwner=null,invocationError=null;
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
       (saved.lastFinishedAttemptAt!==undefined&&saved.lastFinishedAttemptAt!==null&&!Number.isFinite(Date.parse(saved.lastFinishedAttemptAt)))||
       (saved.lastFinishedErrorCode!==undefined&&saved.lastFinishedErrorCode!==null&&!/^[A-Z0-9_]+$/.test(saved.lastFinishedErrorCode))||
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
 async function failed(e,attemptAt){
  if(attemptAt){state.lastFinishedAttemptAt=attemptAt;state.lastFinishedErrorCode=errorCode(e);}
  state.lastErrorCode=errorCode(e);state.failures=Math.min(state.failures+1,16);state.nextAttemptAt=now()+retryDelay();
  if(initialized)try{await save();}catch{state.lastErrorCode='SNAPSHOT_METADATA_WRITE_FAILED';}
 }
 async function runCreate(fn,onAdmitted){
  if(closed||isPaused())return{success:false,deferred:true,reason:closed?'snapshot_stopped':'background_paused'};
  if(activeCreate)return{success:false,deferred:true,reason:'snapshot_in_progress'};
  lastOwner={};let attemptAt=null;
  activeCreate=(async()=>{
   try{
    await init();
    attemptAt=new Date(now()).toISOString();state.lastAttemptAt=attemptAt;state.lastFinishedAttemptAt=null;state.lastFinishedErrorCode=null;state.nextAttemptAt=now()+retryDelay();
    await save(); // Persist admission cooldown before exporting, including across a crash/reboot.
    onAdmitted?.({attemptAt:state.lastAttemptAt});
    const result=await fn();
    if(result?.success!==true||(!result.snapshot?.commitHash&&!result.commitHash))throw Object.assign(Error('snapshot_failed'),{code:result?.errorCode||'SNAPSHOT_FAILED'});
    state.lastSuccessAt=new Date(now()).toISOString();state.lastCommitHash=result.snapshot?.commitHash||result.commitHash;
    state.lastFinishedAttemptAt=attemptAt;state.lastFinishedErrorCode=null;
    state.failures=0;state.lastErrorCode=null;state.nextAttemptAt=0;
    await save();return result;
   }catch(e){
    await failed(e,attemptAt);
    return{success:false,error:state.lastErrorCode,errorCode:state.lastErrorCode};
   }
  })();
  try{return await activeCreate;}finally{activeCreate=null;}
 }
 function requestCreate(fn){
  return new Promise(resolve=>{
   let admitted=false;
   void runCreate(fn,details=>{admitted=true;resolve({accepted:true,completed:false,...details});})
    .then(result=>{if(!admitted)resolve(result);},()=>{if(!admitted)resolve({success:false,errorCode:'SNAPSHOT_REQUEST_UNCONFIRMED'});});
  });
 }
 async function tick(){
  if(closed||activeTick)return;
  activeTick=(async()=>{
   let previousOwner=lastOwner;
   try{await init();previousOwner=lastOwner;if(activeCreate){await activeCreate;return;}if(!isPaused()&&now()>=due()){await create();if(activeCreate)await activeCreate;}}
   catch(e){invocationError={code:errorCode(e),at:new Date(now()).toISOString()};if(activeCreate)await activeCreate;else if(lastOwner===previousOwner&&initialized)await failed(e);else if(!initialized)initError=errorCode(e);}
  })();
  try{await activeTick;}finally{
   activeTick=null;
   schedule(!initialized?15*60*1000:isPaused()?30*1000:Math.max(1000,Math.min(30*1000,due()-now())));
  }
 }
 return {
  init,runCreate,requestCreate,
  start(){schedule(0);},
  async drain(){if(activeTick)await activeTick;if(activeCreate)await activeCreate;if(initializing)await initializing;},
  async stop(){closed=true;if(timer)clearTimer(timer);timer=null;nextCheckAt=null;if(activeTick)await activeTick;if(activeCreate)await activeCreate;},
  snapshot(){return{status:closed?'stopped':initError?'error':activeCreate?'running':!initialized?'queued':isPaused()?'paused':state.lastErrorCode?'retrying':now()>=due()?'queued':'current',attemptStatus:activeCreate?'running':initError?'unknown':!state.lastAttemptAt?'not_started':state.lastFinishedAttemptAt!==state.lastAttemptAt?'unknown':state.lastFinishedErrorCode?'failed':'succeeded',lastFinishedAttemptAt:state.lastFinishedAttemptAt,attemptErrorCode:state.lastFinishedAttemptAt===state.lastAttemptAt?state.lastFinishedErrorCode:null,invocationError,lastSuccessAt:state.lastSuccessAt,lastCommitHash:state.lastCommitHash,lastAttemptAt:state.lastAttemptAt,lastErrorCode:initError||state.lastErrorCode,failures:state.failures,nextAttemptAt:state.nextAttemptAt?new Date(state.nextAttemptAt).toISOString():null,nextCheckAt,intervalMs,format:'partial-application-export'};}
 };
}
