import {readFileSync,readlinkSync,realpathSync,openSync,closeSync,writeFileSync,fsyncSync,mkdirSync,unlinkSync,constants,existsSync} from 'node:fs';
import {join,dirname,isAbsolute,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {parse} from 'yaml';
import {isDeepStrictEqual} from 'node:util';
const hash=x=>createHash('sha256').update(x).digest('hex');
const fail=code=>{throw Object.assign(Error(code),{code});};
const same=(a,b)=>a?.pid===b?.pid&&a?.start===b?.start;
function identity(pid,procRoot){const raw=readFileSync(join(procRoot,String(pid),'stat'),'utf8');const at=raw.lastIndexOf(') ');if(at<0||Number(raw.split(' ')[0])!==pid)fail('MIGRATION_PROCESS_INVALID');return {pid,start:raw.slice(at+2).trim().split(/\s+/)[19]};}
function gone(process,procRoot,pidAlive){try{return !same(identity(process.pid,procRoot),process);}catch(error){return error.code==='ENOENT'&&!pidAlive(process.pid);}}
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
function durableExclusive(path,bytes){
 const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
}
function syncDir(path){const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function lock(path){const fd=openSync(path,constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW,0o600);const r=spawnSync('/usr/bin/flock',['--exclusive','--nonblock','3'],{stdio:['ignore','ignore','ignore',fd],timeout:3000});if(r.error||r.status!==0){closeSync(fd);fail('MIGRATION_STORE_BUSY');}return fd;}
// This exact reviewed native build resolves name-only iii-state via
// ./config/iii-state.yaml value.adapter before constructing its adapter.
const PERSISTED_NATIVE_SHA='a44eba0ca91a2805ea43355e30aec482a688eab33ac84801aec65f6636142654';
export function resolveNativeStoreConfig({workers,store,exeSha256,procRoot,pid}){
 const state=Array.isArray(workers)?workers.filter(x=>x?.name==='iii-state'):[];
 if(state.length!==1)fail('MIGRATION_STORE_CONFIG_MISMATCH');
 let adapter=state[0]?.config?.adapter,persistence;
 if(!adapter){
  if(exeSha256!==PERSISTED_NATIVE_SHA||Object.keys(state[0]).join(',')!=='name'||workers.some(x=>x?.name==='configuration'))fail('MIGRATION_STORE_CONFIG_MISMATCH');
  const cwd=realpathSync(join(procRoot,String(pid),'cwd')),path=realpathSync(join(cwd,'config','iii-state.yaml')),bytes=readFileSync(path),entry=parse(bytes.toString());
  if(entry?.id!=='iii-state'||!entry.value||Object.keys(entry.value).some(k=>k!=='adapter')||bytes.includes(Buffer.from('${')))fail('MIGRATION_PERSISTED_CONFIG_UNSUPPORTED');
  adapter=entry.value.adapter;
  persistence={path,sha256:hash(bytes),cwd};
 }
 if(adapter?.name!=='kv'||adapter?.config?.store_method!=='file_based'||typeof adapter.config.file_path!=='string'||realpathSync(persistence?resolve(persistence.cwd,adapter.config.file_path):adapter.config.file_path)!==store)fail('MIGRATION_STORE_CONFIG_MISMATCH');
 return persistence;
}
export function prepareNativeMigration({storePath,runtimeDir,expectedExecutable,engineEvidence,procRoot='/proc'}){
 const store=realpathSync(storePath),markerPath=join(store,'.agentmemory-writer.lock'),original=readFileSync(markerPath,'utf8'),marker=JSON.parse(original);
 const metadata=JSON.parse(readFileSync(join(runtimeDir,'engine-state.json'),'utf8'));
 if(marker.version!==3||marker.epoch?.state||marker.store!==hash(store)||marker.unverifiedWriter||marker.blockedUntilBoot)fail('MIGRATION_LEGACY_EVIDENCE_UNSUPPORTED');
 if(metadata.kind!=='native'||(metadata.compatVersion!==undefined&&metadata.compatVersion!=='0.22.1')||!metadata.binPath||!isAbsolute(metadata.configPath))fail('MIGRATION_NOT_VERIFIED_NATIVE');
 const observed=engineEvidence.capture();
 if(!observed||!same(observed.engine,marker.epoch.engine)||observed.host!==marker.epoch.host||observed.bootId!==marker.epoch.bootId||observed.endpoint!==marker.epoch.endpoint||(metadata.processStart!==undefined&&metadata.processStart!==marker.epoch.engine.start))fail('MIGRATION_NATIVE_EPOCH_MISMATCH');
 const pid=marker.epoch.engine.pid,exe=realpathSync(expectedExecutable),processExe=realpathSync(join(procRoot,String(pid),'exe'));
 if(realpathSync(metadata.binPath)!==exe||processExe!==exe)fail('MIGRATION_EXECUTABLE_MISMATCH');
 const argv=readFileSync(join(procRoot,String(pid),'cmdline'),'utf8').split('\0').filter(Boolean),at=argv.indexOf('--config');
 if(at<0||argv[at+1]!==metadata.configPath)fail('MIGRATION_CONFIG_MISMATCH');
 const configBytes=readFileSync(metadata.configPath),config=parse(configBytes.toString()),workers=config?.workers;
 const executableSha256=hash(readFileSync(exe));
 const persistence=resolveNativeStoreConfig({workers,store,exeSha256:executableSha256,procRoot,pid});
 if(persistence&&(hash(readFileSync(persistence.path))!==persistence.sha256||realpathSync(join(procRoot,String(pid),'cwd'))!==persistence.cwd))fail('MIGRATION_CAPTURE_CHANGED');
 if(!same(identity(marker.epoch.worker.pid,procRoot),marker.epoch.worker)||!same(identity(pid,procRoot),marker.epoch.engine)||readFileSync(markerPath,'utf8')!==original||!engineEvidence.current(observed))fail('MIGRATION_CAPTURE_CHANGED');
 return {version:1,kind:'verified-native-v3',store,sourceMarker:original,sourceSha256:hash(original),epoch:marker.epoch,native:{executable:exe,executableSha256,...(persistence?{persistence}:{}),configPath:metadata.configPath,configSha256:hash(configBytes),argvSha256:hash(JSON.stringify(argv))}};
}
export function saveNativeMigrationProof(proof,path){durableExclusive(path,JSON.stringify(proof)+'\n');syncDir(dirname(path));}
// A normal stopped native writer may publish only its clean bit after prepare.
// Preserve both byte strings; never rewrite the original proof or live marker.
function cleanShutdownTransition(original,current){
 try{
  const before=JSON.parse(original),after=JSON.parse(current);
  return before.version===3&&!before.epoch?.state&&before.clean===false&&after.clean===true&&
   !before.unverifiedWriter&&!before.blockedUntilBoot&&!before.uncertaintyBootId&&
   isDeepStrictEqual({...before,clean:true},after);
 }catch{return false;}
}
export function finalizeNativeMigration({storePath,proof,procRoot='/proc',pidAlive=alive,publish=durableExclusive}){
 const store=realpathSync(storePath);
 if(proof?.version!==1||proof.kind!=='verified-native-v3'||proof.store!==store||proof.sourceSha256!==hash(proof.sourceMarker)||JSON.stringify(JSON.parse(proof.sourceMarker).epoch)!==JSON.stringify(proof.epoch))fail('MIGRATION_PROOF_INVALID');
 if(proof.native.persistence&&hash(readFileSync(proof.native.persistence.path))!==proof.native.persistence.sha256)fail('MIGRATION_PERSISTED_CONFIG_CHANGED');
 if(hash(readFileSync(proof.native.executable))!==proof.native.executableSha256||hash(readFileSync(proof.native.configPath))!==proof.native.configSha256)fail('MIGRATION_ARTIFACT_CHANGED');
 const appLock=lock(join(store,'.agentmemory-writer.lock'));let stateLock;
 try{
  stateLock=lock(join(store,'.agentmemory-state.lock'));
  const finalMarker=readFileSync(join(store,'.agentmemory-writer.lock'),'utf8');
  const reconciled=finalMarker!==proof.sourceMarker;
  if(reconciled&&!cleanShutdownTransition(proof.sourceMarker,finalMarker))fail('MIGRATION_MARKER_CHANGED');
  if(!gone(proof.epoch.worker,procRoot,pidAlive)||!gone(proof.epoch.engine,procRoot,pidAlive))fail('MIGRATION_PRIOR_PROCESS_ALIVE');
  const dir=join(store,'.agentmemory-migrations');mkdirSync(dir,{recursive:true,mode:0o700});
  const sourceSha256=hash(finalMarker),path=join(dir,sourceSha256+'.json'),seal=path+'.complete';
  if(existsSync(path)||existsSync(seal))fail('MIGRATION_RECEIPT_EXISTS');
  const receipt={version:1,kind:'native-v3-to-state-v4',proof,sourceSha256,...(reconciled?{finalMarker,transition:'native-clean-shutdown'}:{}),finalizedAt:new Date().toISOString()};
  const bytes=JSON.stringify(receipt)+'\n';
  publish(path,bytes);syncDir(dir);
  try{publish(seal,hash(bytes)+'\n');syncDir(dir);}catch(error){try{unlinkSync(seal);}catch{}throw error;}
  return {path,sourceSha256,preparedSourceSha256:proof.sourceSha256,reconciledCleanShutdown:reconciled};
 }finally{if(stateLock!==undefined)closeSync(stateLock);closeSync(appLock);}
}
export function nativeMigrationForMarker(store,original,epoch,evidence){
 try{
  const sourceSha256=hash(original),path=join(store,'.agentmemory-migrations',sourceSha256+'.json'),bytes=readFileSync(path,'utf8');
  if(readFileSync(path+'.complete','utf8').trim()!==hash(bytes))return null;
  const receipt=JSON.parse(bytes),proof=receipt.proof,prior=JSON.parse(original);
  if(receipt.version!==1||receipt.kind!=='native-v3-to-state-v4'||receipt.sourceSha256!==sourceSha256||proof?.version!==1||proof.kind!=='verified-native-v3'||proof.sourceSha256!==hash(proof.sourceMarker)||proof.store!==realpathSync(store)||prior.version!==3||prior.epoch?.state||prior.unverifiedWriter||prior.blockedUntilBoot||JSON.stringify(proof.epoch)!==JSON.stringify(prior.epoch))return null;
  const exact=proof.sourceMarker===original&&proof.sourceSha256===sourceSha256;
  const reconciled=receipt.transition==='native-clean-shutdown'&&receipt.finalMarker===original&&cleanShutdownTransition(proof.sourceMarker,original);
  if(!exact&&!reconciled)return null;
  if(proof.epoch.host!==epoch.host||prior.store!==epoch.state?.store||!evidence.gone(proof.epoch.worker)||!evidence.gone(proof.epoch.engine))return null;
  return {version:1,sourceSha256,receiptSha256:hash(bytes),kind:'verified-native-v3'};
 }catch{return null;}
}
