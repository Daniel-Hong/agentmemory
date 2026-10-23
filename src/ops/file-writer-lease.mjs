import {createHash} from 'node:crypto';
import {openSync,closeSync,realpathSync,fstatSync,lstatSync,constants,readFileSync,writeSync,ftruncateSync,fsyncSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const owners=new WeakMap();
const failure=code=>Object.assign(Error(code),{code});
const sameProcess=(a,b)=>!!a&&!!b&&a.pid===b.pid&&a.start===b.start;
const validEpoch=e=>e&&/^[a-f0-9]{64}$/.test(e.host)&&/^[a-f0-9-]{36}$/.test(e.bootId)&&typeof e.endpoint==='string'&&typeof e.pidNamespace==='string'&&typeof e.netNamespace==='string'&&Number.isSafeInteger(e.workerUid)&&e.workerUid>=0&&[e.worker,e.engine].every(p=>Number.isSafeInteger(p?.pid)&&p.pid>0&&/^\d+$/.test(p.start));
function writeMarker(entry,clean){ftruncateSync(entry.fd,0);writeSync(entry.fd,JSON.stringify({version:3,store:entry.store,epoch:entry.epoch,clean,blockedUntilBoot:entry.blockedUntilBoot,unverifiedWriter:entry.unverifiedWriter,uncertaintyBootId:entry.uncertaintyBootId}),0,'utf8');fsyncSync(entry.fd);}
export function acquireFileWriterLease(storePath,options={}){
 if(process.platform!=='linux')throw failure('FILE_WRITER_UNSUPPORTED');
 const directory=realpathSync(storePath),store=createHash('sha256').update(directory).digest('hex'),path=join(directory,'.agentmemory-writer.lock');
 const fd=openSync(path,constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW,0o600);
 try{
  if(!fstatSync(fd).isFile())throw failure('FILE_WRITER_UNSUPPORTED');
  const result=spawnSync('/usr/bin/flock',['--exclusive','--nonblock','3'],{stdio:['ignore','ignore','ignore',fd],timeout:3000});
  if(result.error||result.status!==0)throw failure(result.status===1?'FILE_WRITER_BUSY':'FILE_WRITER_UNSUPPORTED');
  let prior=null,unsupported=false;const size=fstatSync(fd).size;
  if(size){try{if(size>4096)throw Error();prior=JSON.parse(readFileSync(fd,'utf8'));unsupported=prior?.version!==3||typeof prior.clean!=='boolean'||prior.blockedUntilBoot!==undefined&&typeof prior.blockedUntilBoot!=='boolean'||!/^[a-f0-9]{64}$/.test(prior.store??'')||!validEpoch(prior.epoch);}catch{unsupported=true;}}
  const epoch=options.evidence?.capture()??null;let admitted=false,reason='WRITER_EPOCH_UNVERIFIED',blockedUntilBoot=false,unverifiedWriter=false,uncertaintyBootId=null;
  if(!validEpoch(epoch))reason='NATIVE_ENGINE_UNVERIFIED';
  else if(unsupported)reason='WRITER_PRIOR_UNSUPPORTED';
  else if(prior&&(prior.store!==store||prior.epoch.host!==epoch.host||prior.epoch.endpoint!==epoch.endpoint||prior.epoch.pidNamespace!==epoch.pidNamespace||prior.epoch.netNamespace!==epoch.netNamespace||prior.epoch.workerUid!==epoch.workerUid))reason='WRITER_PRIOR_FOREIGN';
  else if(prior){
   const old=prior.epoch;
   if(prior.unverifiedWriter===true&&(!/^[a-f0-9-]{36}$/.test(prior.uncertaintyBootId??'')||prior.uncertaintyBootId===epoch.bootId)){blockedUntilBoot=true;unverifiedWriter=true;uncertaintyBootId=prior.uncertaintyBootId??null;reason='WRITER_NATIVE_PROBE_UNCERTAIN';}
   else if(old.bootId!==epoch.bootId||prior.unverifiedWriter===true)admitted=true;
   else {
    const workerGone=options.evidence.gone(old.worker),engineChanged=!sameProcess(old.engine,epoch.engine),engineGone=engineChanged&&options.evidence.gone(old.engine);
    blockedUntilBoot=prior.blockedUntilBoot===true||!workerGone||engineChanged&&!engineGone;
    admitted=!blockedUntilBoot&&workerGone&&(prior.clean===true&&!engineChanged||engineChanged&&engineGone);
    if(blockedUntilBoot)reason='WRITER_ENGINE_OVERLAP';
   }
  }
  const entry={fd,directory,path,store,epoch,evidence:options.evidence,admitted,reason,blockedUntilBoot,unverifiedWriter,uncertaintyBootId};
  // Foreign/unsupported evidence is retained; a local restart cannot erase it.
  if(!size||validEpoch(epoch)&&!unsupported&&reason!=='WRITER_PRIOR_FOREIGN'){
   if(validEpoch(epoch))writeMarker(entry,false);
   else {writeSync(fd,JSON.stringify({version:3,unsupported:true}),0,'utf8');fsyncSync(fd);}
  }
  if(!validEpoch(epoch)&&prior&&!unsupported){
   // Preserve prior identity and clean evidence, but record every unverified writer.
   ftruncateSync(fd,0);writeSync(fd,JSON.stringify({...prior,blockedUntilBoot:true,unverifiedWriter:true,uncertaintyBootId:options.evidence?.bootIdentity?.()??null}),0,'utf8');fsyncSync(fd);
  }
  const lease={close(){const e=owners.get(lease);if(e){owners.delete(lease);closeSync(e.fd);}}};owners.set(lease,entry);return lease;
 }catch(error){closeSync(fd);throw error;}
}
export function ownsFileWriterLease(lease,storePath){
 const e=lease&&owners.get(lease);if(!e)return false;
 try{const open=fstatSync(e.fd),live=lstatSync(e.path);return e.directory===realpathSync(storePath)&&live.isFile()&&open.dev===live.dev&&open.ino===live.ino;}catch{return false;}
}
export function fileWriterRecoveryAdmitted(lease){const e=owners.get(lease);return !!e?.admitted&&ownsFileWriterLease(lease,e.directory)&&e.evidence.current(e.epoch);}
export function fileWriterRecoveryReason(lease){const e=owners.get(lease);return !e?'FILE_WRITER_UNSUPPORTED':fileWriterRecoveryAdmitted(lease)?null:e.admitted?'NATIVE_ENGINE_CHANGED':e.reason;}
export function markFileWriterClean(lease){const e=owners.get(lease);if(!e||!ownsFileWriterLease(lease,e.directory))throw failure('FILE_WRITER_LOST');if(!fileWriterRecoveryAdmitted(lease))throw failure('WRITER_EPOCH_UNVERIFIED');writeMarker(e,true);}
