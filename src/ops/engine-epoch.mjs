import {readFileSync,readlinkSync,readdirSync} from 'node:fs';
import {join,basename} from 'node:path';
import {createHash} from 'node:crypto';
const bootPattern=/^[a-f0-9-]{36}$/;
export function createEngineEpochEvidence({engineUrl,enginePidPath,peer,procRoot='/proc',machineIdPath='/etc/machine-id',workerPid=process.pid,workerUid=process.getuid?.()??null,pidAlive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e?.code!=='ESRCH';}}}){
 function identity(pid){
  if(!Number.isSafeInteger(pid)||pid<1)throw Error('PROCESS_ID_UNSUPPORTED');
  const raw=readFileSync(join(procRoot,String(pid),'stat'),'utf8'),at=raw.lastIndexOf(') '),fields=raw.slice(at+2).trim().split(/\s+/);
  if(at<0||!/^\d+$/.test(fields[19]??'')||Number(raw.slice(0,raw.indexOf(' ')))!==pid)throw Error('PROCESS_ID_UNSUPPORTED');
  return {pid,start:fields[19]};
 }
 const same=(a,b)=>!!a&&!!b&&a.pid===b.pid&&a.start===b.start;
 const addresses=address=>address==='127.0.0.1'||address==='::ffff:127.0.0.1'?['0100007F','0000000000000000FFFF00000100007F']:address==='::1'?['00000000000000000000000001000000']:[];
 function capture(){try{
  const url=new URL(engineUrl);if(!['ws:','wss:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password) return null;
  const socket=peer?.();if(!socket||!addresses(socket.remoteAddress).length||!addresses(socket.localAddress).length||socket.remotePort!==Number(url.port||(url.protocol==='wss:'?443:80))||!Number.isSafeInteger(socket.localPort)||socket.localPort<1)return null;
  const worker=identity(workerPid),pid=Number(readFileSync(enginePidPath,'utf8').trim()),engine=identity(pid);
  const exe=readlinkSync(join(procRoot,String(pid),'exe'));if(basename(exe.replace(/ \(deleted\)$/,''))!=='iii')return null;
  if(readlinkSync(join(procRoot,String(pid),'ns/net'))!==readlinkSync(join(procRoot,String(workerPid),'ns/net')))return null;
  const fds=readdirSync(join(procRoot,String(pid),'fd'));if(fds.length>4096)return null;
  const owned=new Set();for(const fd of fds){try{const link=readlinkSync(join(procRoot,String(pid),'fd',fd)),m=/^socket:\[(\d+)\]$/.exec(link);if(m)owned.add(m[1]);}catch{}}
  const entries=[];for(const file of ['tcp','tcp6']){
   const raw=readFileSync(join(procRoot,String(pid),'net',file),'utf8');if(raw.length>1024*1024)return null;
   for(const line of raw.split('\n')){const v=line.trim().split(/\s+/),local=v[1]?.split(':'),remote=v[2]?.split(':');if(local?.length===2&&remote?.length===2)entries.push({local:local[0].toUpperCase(),port:parseInt(local[1],16),remote:remote[0].toUpperCase(),remotePort:parseInt(remote[1],16),state:v[3],inode:v[9]});}
  }
  const localAddresses=addresses(socket.remoteAddress),remoteAddresses=addresses(socket.localAddress);
  const connections=entries.filter(e=>e.state==='01'&&e.port===socket.remotePort&&e.remotePort===socket.localPort&&localAddresses.includes(e.local)&&remoteAddresses.includes(e.remote));
  const listeners=entries.filter(e=>e.state==='0A'&&e.port===socket.remotePort&&(localAddresses.includes(e.local)||/^0{8}$|^0{32}$/.test(e.local)));
  if(connections.length!==1||listeners.length!==1||!owned.has(connections[0].inode)||!owned.has(listeners[0].inode))return null;
  const latest=peer?.();if(!latest||['remoteAddress','remotePort','localAddress','localPort'].some(k=>latest[k]!==socket[k])||!same(engine,identity(pid))||!same(worker,identity(workerPid)))return null;
  const bootId=readFileSync(join(procRoot,'sys/kernel/random/boot_id'),'utf8').trim(),machine=readFileSync(machineIdPath,'utf8').trim();if(!bootPattern.test(bootId)||!machine)return null;
  const pidNamespace=readlinkSync(join(procRoot,String(workerPid),'ns/pid')),netNamespace=readlinkSync(join(procRoot,String(workerPid),'ns/net'));if(!Number.isSafeInteger(workerUid)||workerUid<0)return null;return {host:createHash('sha256').update(machine).digest('hex'),bootId,endpoint:url.origin,pidNamespace,netNamespace,workerUid,worker,engine};
 }catch{return null;}}
 return {bootIdentity(){try{const value=readFileSync(join(procRoot,'sys/kernel/random/boot_id'),'utf8').trim();return bootPattern.test(value)?value:null;}catch{return null;}},capture,current(expected){const value=capture();return !!value&&!!expected&&value.host===expected.host&&value.bootId===expected.bootId&&value.endpoint===expected.endpoint&&value.pidNamespace===expected.pidNamespace&&value.netNamespace===expected.netNamespace&&value.workerUid===expected.workerUid&&same(value.engine,expected.engine)&&same(value.worker,expected.worker);},gone(previous){try{if(!previous||!/^\d+$/.test(previous.start))return false;return !same(previous,identity(previous.pid));}catch(error){return (error?.code==='ENOENT'||error?.code==='ESRCH')&&!pidAlive(previous?.pid);}}};
}
