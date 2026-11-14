import {readOwnedTcpRows} from './proc-tcp-rows.mjs';
import {readFileSync,readlinkSync,readdirSync} from 'node:fs';
import {join,basename} from 'node:path';
import {createHash} from 'node:crypto';
const bootPattern=/^[a-f0-9-]{36}$/;
// Metadata supplies only a candidate PID. capture() still verifies process and socket ownership.
export function readEnginePid({enginePidPath,engineStatePath,engineUrl}){
 let state,metadataExists=false;
 if(engineStatePath){
  try{state=JSON.parse(readFileSync(engineStatePath,'utf8'));metadataExists=true;}
  catch(error){if(error?.code!=='ENOENT')throw error;}
 }
 if(metadataExists&&(!state||Array.isArray(state)||!['compose','native'].includes(state.kind)))throw Error('ENGINE_METADATA_UNSUPPORTED');
 let pid;
 if(state?.kind==='compose'){
  if(new URL(state.engineUrl).href!==new URL(engineUrl).href)throw Error('ENGINE_ENDPOINT_MISMATCH');
  pid=state.enginePid;
 }else{pid=Number(readFileSync(enginePidPath,'utf8').trim());}
 if(!Number.isSafeInteger(pid)||pid<1)throw Error('ENGINE_PID_UNAVAILABLE');
 return pid;
}
export function createEngineEpochEvidence({engineUrl,enginePidPath,engineStatePath,peer,procRoot='/proc',machineIdPath='/etc/machine-id',workerPid=process.pid,workerUid=process.getuid?.()??null,pidAlive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e?.code!=='ESRCH';}}}){
 let lastFailure=null;const reject=code=>{lastFailure=code;return null;};
 function identity(pid){
  if(!Number.isSafeInteger(pid)||pid<1)throw Error('PROCESS_ID_UNSUPPORTED');
  const raw=readFileSync(join(procRoot,String(pid),'stat'),'utf8'),at=raw.lastIndexOf(') '),fields=raw.slice(at+2).trim().split(/\s+/);
  if(at<0||!/^\d+$/.test(fields[19]??'')||Number(raw.slice(0,raw.indexOf(' ')))!==pid)throw Error('PROCESS_ID_UNSUPPORTED');
  return {pid,start:fields[19]};
 }
 const same=(a,b)=>!!a&&!!b&&a.pid===b.pid&&a.start===b.start;
 const addresses=address=>address==='127.0.0.1'||address==='::ffff:127.0.0.1'?['0100007F','0000000000000000FFFF00000100007F']:address==='::1'?['00000000000000000000000001000000']:[];
 function capture(){lastFailure=null;try{
  const url=new URL(engineUrl);if(!['ws:','wss:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password) return reject('ENGINE_ENDPOINT_UNSUPPORTED');
  const socket=peer?.();if(!socket||!addresses(socket.remoteAddress).length||!addresses(socket.localAddress).length||socket.remotePort!==Number(url.port||(url.protocol==='wss:'?443:80))||!Number.isSafeInteger(socket.localPort)||socket.localPort<1)return reject('ENGINE_SDK_SOCKET_UNAVAILABLE');
  const worker=identity(workerPid),pid=readEnginePid({enginePidPath,engineStatePath,engineUrl}),engine=identity(pid);
  const exe=readlinkSync(join(procRoot,String(pid),'exe'));if(basename(exe.replace(/ \(deleted\)$/,''))!=='iii')return reject('ENGINE_EXECUTABLE_UNVERIFIED');
  if(readlinkSync(join(procRoot,String(pid),'ns/net'))!==readlinkSync(join(procRoot,String(workerPid),'ns/net')))return reject('ENGINE_NETWORK_NAMESPACE_CHANGED');
  const fds=readdirSync(join(procRoot,String(pid),'fd'));if(fds.length>4096)return reject('ENGINE_FD_LIMIT');
  const owned=new Set();for(const fd of fds){try{const link=readlinkSync(join(procRoot,String(pid),'fd',fd)),m=/^socket:\[(\d+)\]$/.exec(link);if(m)owned.add(m[1]);}catch{}}
  const entries=[];for(const file of ['tcp','tcp6']){
   for(const row of readOwnedTcpRows(join(procRoot,String(pid),'net',file),owned,row=>parseInt(row.local?.split(':')[1],16)===socket.remotePort&&(row.state==='0A'||parseInt(row.remote?.split(':')[1],16)===socket.localPort))){
    const local=row.local.split(':'),remote=row.remote.split(':');
    entries.push({local:local[0],port:parseInt(local[1],16),remote:remote[0],remotePort:parseInt(remote[1],16),state:row.state,inode:row.inode});
   }
  }
  const localAddresses=addresses(socket.remoteAddress),remoteAddresses=addresses(socket.localAddress);
  const connections=entries.filter(e=>e.state==='01'&&e.port===socket.remotePort&&e.remotePort===socket.localPort&&localAddresses.includes(e.local)&&remoteAddresses.includes(e.remote));
  const listeners=entries.filter(e=>e.state==='0A'&&e.port===socket.remotePort&&(localAddresses.includes(e.local)||/^0{8}$|^0{32}$/.test(e.local)));
  if(connections.length!==1)return reject('ENGINE_PEER_CONNECTION_UNVERIFIED');
  if(listeners.length!==1)return reject('ENGINE_LISTENER_UNVERIFIED');
  if(!owned.has(connections[0].inode)||!owned.has(listeners[0].inode))return reject('ENGINE_SOCKET_OWNER_UNVERIFIED');
  const latest=peer?.();if(!latest||['remoteAddress','remotePort','localAddress','localPort'].some(k=>latest[k]!==socket[k])||!same(engine,identity(pid))||!same(worker,identity(workerPid)))return reject('ENGINE_PEER_OR_PROCESS_CHANGED');
  const bootId=readFileSync(join(procRoot,'sys/kernel/random/boot_id'),'utf8').trim(),machine=readFileSync(machineIdPath,'utf8').trim();if(!bootPattern.test(bootId)||!machine)return reject('ENGINE_BOOT_ID_UNVERIFIED');
  const pidNamespace=readlinkSync(join(procRoot,String(workerPid),'ns/pid')),netNamespace=readlinkSync(join(procRoot,String(workerPid),'ns/net'));if(!Number.isSafeInteger(workerUid)||workerUid<0)return reject('ENGINE_WORKER_UID_UNVERIFIED');return {host:createHash('sha256').update(machine).digest('hex'),bootId,endpoint:url.origin,pidNamespace,netNamespace,workerUid,worker,engine};
 }catch(error){return reject(['ENOENT','ESRCH','EACCES','EPERM'].includes(error?.code)?'ENGINE_PROC_'+error.code:/^(ENGINE_|PROCESS_|PROC_TCP_)[A-Z_]+$/.test(error?.message??'')?error.message:'ENGINE_CAPTURE_FAILED');}}
 return {diagnostic:()=>lastFailure,bootIdentity(){try{const value=readFileSync(join(procRoot,'sys/kernel/random/boot_id'),'utf8').trim();return bootPattern.test(value)?value:null;}catch{return null;}},capture,current(expected){const value=capture();return !!value&&!!expected&&value.host===expected.host&&value.bootId===expected.bootId&&value.endpoint===expected.endpoint&&value.pidNamespace===expected.pidNamespace&&value.netNamespace===expected.netNamespace&&value.workerUid===expected.workerUid&&same(value.engine,expected.engine)&&same(value.worker,expected.worker);},gone(previous){try{if(!previous||!/^\d+$/.test(previous.start))return false;return !same(previous,identity(previous.pid));}catch(error){return (error?.code==='ENOENT'||error?.code==='ESRCH')&&!pidAlive(previous?.pid);}}};
}

// Never acquire/write a lease marker until delayed CLI metadata is verifiable.
export async function waitForEngineEpoch(evidence,{timeoutMs=30000,pollMs=25}={}){
 const deadline=Date.now()+timeoutMs;
 do{
  const epoch=evidence.capture();
  if(epoch)return epoch;
  if(Date.now()>=deadline)throw Object.assign(Error('ENGINE_EPOCH_UNVERIFIED'),{code:'ENGINE_EPOCH_UNVERIFIED'});
  await new Promise(resolve=>setTimeout(resolve,Math.min(pollMs,Math.max(1,deadline-Date.now()))));
 }while(true);
}
