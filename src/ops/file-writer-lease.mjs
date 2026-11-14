import {nativeMigrationForMarker} from './native-lease-migration.mjs';
import {createHash} from 'node:crypto';
import {openSync,closeSync,realpathSync,fstatSync,lstatSync,constants,readFileSync,writeSync,ftruncateSync,fsyncSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const owners=new WeakMap();
const failure=code=>Object.assign(Error(code),{code});
const sameProcess=(a,b)=>!!a&&!!b&&a.pid===b.pid&&a.start===b.start;
const validState=s=>s&&Number.isSafeInteger(s.pid)&&s.pid>0&&/^\d+$/.test(s.start)&&/^[a-f0-9-]{36}$/.test(s.instanceId)&&/^[a-f0-9]{64}$/.test(s.store)&&/^[a-f0-9]{64}$/.test(s.executableSha256);
const validEpoch=e=>e&&/^[a-f0-9]{64}$/.test(e.host)&&/^[a-f0-9-]{36}$/.test(e.bootId)&&typeof e.endpoint==='string'&&typeof e.pidNamespace==='string'&&typeof e.netNamespace==='string'&&Number.isSafeInteger(e.workerUid)&&e.workerUid>=0&&(!e.state||validState(e.state))&&[e.worker,e.engine].every(p=>Number.isSafeInteger(p?.pid)&&p.pid>0&&/^\d+$/.test(p.start));
function writeMarker(entry,clean){ftruncateSync(entry.fd,0);writeSync(entry.fd,JSON.stringify({version:entry.epoch?.state?4:3,store:entry.store,epoch:entry.epoch,clean,blockedUntilBoot:entry.blockedUntilBoot,unverifiedWriter:entry.unverifiedWriter,uncertaintyBootId:entry.uncertaintyBootId,...(entry.migration?{migration:entry.migration}:{})}),0,'utf8');fsyncSync(entry.fd);entry.markerOwned=true;}
export function acquireFileWriterLease(storePath,options={}){
 if(process.platform!=='linux')throw failure('FILE_WRITER_UNSUPPORTED');
 if(options.requireVerifiedEpoch&&!validEpoch(options.evidence?.capture()))throw failure('ENGINE_EPOCH_UNVERIFIED');
 const directory=realpathSync(storePath),store=createHash('sha256').update(directory).digest('hex'),path=join(directory,'.agentmemory-writer.lock');
 const fd=openSync(path,constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW,0o600);
 try{
  if(!fstatSync(fd).isFile())throw failure('FILE_WRITER_UNSUPPORTED');
  const result=spawnSync('/usr/bin/flock',['--exclusive','--nonblock','3'],{stdio:['ignore','ignore','ignore',fd],timeout:3000});
  if(result.error||result.status!==0)throw failure(result.status===1?'FILE_WRITER_BUSY':'FILE_WRITER_UNSUPPORTED');
  let prior=null,original='',unsupported=false;const size=fstatSync(fd).size;
  if(size){try{if(size>4096)throw Error();original=readFileSync(fd,'utf8');prior=JSON.parse(original);unsupported=prior?.version!==(prior?.epoch?.state?4:3)||typeof prior.clean!=='boolean'||prior.blockedUntilBoot!==undefined&&typeof prior.blockedUntilBoot!=='boolean'||!/^[a-f0-9]{64}$/.test(prior.store??'')||!validEpoch(prior.epoch)||!!prior.epoch?.state&&prior.epoch.state.store!==prior.store;}catch{unsupported=true;}}
  const epoch=options.evidence?.capture()??null;if(options.requireVerifiedEpoch&&!validEpoch(epoch))throw failure('ENGINE_EPOCH_UNVERIFIED');const migration=epoch?.state&&prior?.version===3?nativeMigrationForMarker(directory,original,epoch,options.evidence):prior?.migration??null;if(options.requireVerifiedEpoch&&prior?.version===4&&!epoch?.state)throw failure('WRITER_NATIVE_DOWNGRADE_UNSUPPORTED');let admitted=false,reason='WRITER_EPOCH_UNVERIFIED',blockedUntilBoot=false,unverifiedWriter=false,uncertaintyBootId=null;
  if(!validEpoch(epoch))reason='NATIVE_ENGINE_UNVERIFIED';
  else if(unsupported||(prior&&Boolean(prior.epoch?.state)!==Boolean(epoch?.state)&&!(prior.version===3&&!!epoch.state&&migration?.kind==='verified-native-v3')))reason='WRITER_PRIOR_UNSUPPORTED';
  else if(epoch.state&&epoch.state.store!==store)reason='WRITER_PRIOR_FOREIGN';
  else if(prior&&(prior.store!==store||prior.epoch.host!==epoch.host||prior.epoch.endpoint!==epoch.endpoint||prior.epoch.pidNamespace!==epoch.pidNamespace||prior.epoch.netNamespace!==epoch.netNamespace||prior.epoch.workerUid!==epoch.workerUid))reason='WRITER_PRIOR_FOREIGN';
  else if(prior){
   const old=prior.epoch;
   if(prior.unverifiedWriter===true&&(!/^[a-f0-9-]{36}$/.test(prior.uncertaintyBootId??'')||prior.uncertaintyBootId===epoch.bootId)){blockedUntilBoot=true;unverifiedWriter=true;uncertaintyBootId=prior.uncertaintyBootId??null;reason='WRITER_NATIVE_PROBE_UNCERTAIN';}
   else if(old.bootId!==epoch.bootId||prior.unverifiedWriter===true)admitted=true;
   else {
    const workerGone=options.evidence.gone(old.worker),stateChanged=!!old.state&&(!sameProcess(old.state,epoch.state)||old.state.instanceId!==epoch.state?.instanceId),stateGone=!stateChanged||options.evidence.gone(old.state),engineChanged=!sameProcess(old.engine,epoch.engine)||stateChanged,engineGone=engineChanged&&stateGone&&(sameProcess(old.engine,epoch.engine)||options.evidence.gone(old.engine));
    const externalWriterUnclean=!!old.state&&prior.clean!==true&&!options.evidence.gone(old.state);
    blockedUntilBoot=prior.blockedUntilBoot===true||!workerGone||engineChanged&&!engineGone||externalWriterUnclean;
    admitted=!blockedUntilBoot&&workerGone&&(prior.clean===true&&!engineChanged||engineChanged&&engineGone);
    if(blockedUntilBoot)reason='WRITER_ENGINE_OVERLAP';
   }
  }
  const entry={fd,directory,path,store,epoch,migration,evidence:options.evidence,admitted,reason,blockedUntilBoot,unverifiedWriter,uncertaintyBootId};
  // Foreign/unsupported evidence is retained; a local restart cannot erase it.
  if(!size||validEpoch(epoch)&&!unsupported&&reason!=='WRITER_PRIOR_UNSUPPORTED'&&reason!=='WRITER_PRIOR_FOREIGN'){
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
export function fileWriterReadCurrent(lease){const e=owners.get(lease);return !!e&&validEpoch(e.epoch)&&ownsFileWriterLease(lease,e.directory)&&e.evidence.current(e.epoch);}
export function fileWriterRecoveryAdmitted(lease){const e=owners.get(lease);return !!e?.admitted&&ownsFileWriterLease(lease,e.directory)&&e.evidence.current(e.epoch);}
export function fileWriterRecoveryReason(lease){const e=owners.get(lease);return !e?'FILE_WRITER_UNSUPPORTED':fileWriterRecoveryAdmitted(lease)?null:e.admitted?'NATIVE_ENGINE_CHANGED':e.reason;}
export function markFileWriterClean(lease){const e=owners.get(lease);if(!e||!ownsFileWriterLease(lease,e.directory))throw failure('FILE_WRITER_LOST');if(!fileWriterRecoveryAdmitted(lease))throw failure('WRITER_EPOCH_UNVERIFIED');writeMarker(e,true);}

export function markFileWriterSealedClean(lease,receipt){
 const e=owners.get(lease);
 if(!e?.markerOwned||!e.epoch?.state||e.blockedUntilBoot||e.unverifiedWriter||!ownsFileWriterLease(lease,e.directory)||!e.evidence.current(e.epoch)||receipt?.version!==1||receipt.sealed!==true||receipt.synced!==true||receipt.instanceId!==e.epoch.state.instanceId||typeof receipt.storePath!=='string'||realpathSync(receipt.storePath)!==e.directory)throw failure('STATE_SEAL_UNVERIFIED');
 writeMarker(e,true);
}
