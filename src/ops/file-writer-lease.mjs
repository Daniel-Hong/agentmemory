import {openSync,closeSync,realpathSync,fstatSync,lstatSync,constants,readFileSync,writeSync,ftruncateSync,fsyncSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const owners=new WeakMap();
const failure=code=>Object.assign(Error(code),{code});
export function acquireFileWriterLease(storePath,options={}){
 if(process.platform!=='linux')throw failure('FILE_WRITER_UNSUPPORTED');
 const directory=realpathSync(storePath),path=join(directory,'.agentmemory-writer.lock');
 const fd=openSync(path,constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW,0o600);
 try{
  if(!fstatSync(fd).isFile())throw failure('FILE_WRITER_UNSUPPORTED');
  // flock(2) belongs to the shared open-file description, including this parent FD.
  const result=spawnSync('/usr/bin/flock',['--exclusive','--nonblock','3'],{stdio:['ignore','ignore','ignore',fd],timeout:3000});
  if(result.error||result.status!==0)throw failure(result.status===1?'FILE_WRITER_BUSY':'FILE_WRITER_UNSUPPORTED');
  const bootId=readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
  const validBoot=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id);
  let localEngine=false;try{const url=new URL(options.engineUrl);localEngine=['ws:','wss:'].includes(url.protocol)&&['127.0.0.1','localhost','[::1]'].includes(url.hostname);}catch{}
  let previousClean=false;try{const stat=fstatSync(fd);if(stat.size<=256){const prior=JSON.parse(readFileSync(fd,'utf8'));previousClean=localEngine&&validBoot(bootId)&&prior.version===2&&validBoot(prior.bootId)&&(prior.bootId!==bootId||prior.clean===true);}}catch{}
  ftruncateSync(fd,0);writeSync(fd,JSON.stringify({version:2,bootId,clean:false}),0,'utf8');fsyncSync(fd);
  const lease={close(){const entry=owners.get(lease);if(entry){owners.delete(lease);closeSync(entry.fd);}}};
  owners.set(lease,{fd,directory,path,previousClean,bootId});return lease;
 }catch(error){closeSync(fd);throw error;}
}
export function ownsFileWriterLease(lease,storePath){
 const entry=lease&&owners.get(lease);if(!entry)return false;
 try{const open=fstatSync(entry.fd),live=lstatSync(entry.path);return entry.directory===realpathSync(storePath)&&live.isFile()&&open.dev===live.dev&&open.ino===live.ino;}catch{return false;}
}

export function fileWriterRecoveryAdmitted(lease){const entry=owners.get(lease);return !!entry?.previousClean&&ownsFileWriterLease(lease,entry.directory);}
export function markFileWriterClean(lease){
 const entry=owners.get(lease);if(!entry||!ownsFileWriterLease(lease,entry.directory))throw failure('FILE_WRITER_LOST');
 if(!entry.previousClean)throw failure('WRITER_EPOCH_UNVERIFIED');
 ftruncateSync(entry.fd,0);writeSync(entry.fd,JSON.stringify({version:2,bootId:entry.bootId,clean:true}),0,'utf8');fsyncSync(entry.fd);
}
