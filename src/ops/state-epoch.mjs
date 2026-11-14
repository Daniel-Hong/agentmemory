import {readOwnedTcpRows} from './proc-tcp-rows.mjs';
import {stateDispatchRejected} from './state-dispatch-error.mjs';
import {readFileSync,readlinkSync,readdirSync,realpathSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const fail=()=>{throw Error('STATE_WRITER_IDENTITY_UNVERIFIED');};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest=x=>createHash('sha256').update(x).digest('hex');
const signature=s=>[s.dev,s.ino,s.size,s.ctimeMs,s.mtimeMs].join(':');
export function createStateBoundEvidence({engineEvidence,identity,expectedExecutable,storePath,procRoot='/proc'}){
 let lastFailure=null;const reject=code=>{lastFailure=code;return false;};
 const binding=structuredClone(identity);
 if(binding?.version!==1||!Number.isSafeInteger(binding.pid)||binding.pid<1||!/^\d+$/.test(binding.start)||!uuid.test(binding.instanceId)||!uuid.test(binding.bootId)||binding.adapter!=='kv'||typeof binding.storePath!=='string')fail();
 const directory=realpathSync(storePath);
 if(realpathSync(binding.storePath)!==directory||!expectedExecutable||!/^([a-f0-9]{64})$/.test(expectedExecutable.sha256))fail();
 const exe=realpathSync(expectedExecutable.path),exeStat=signature(statSync(exe));
 if(digest(readFileSync(exe))!==expectedExecutable.sha256)fail();
 function processStart(pid){
  const raw=readFileSync(join(procRoot,String(pid),'stat'),'utf8'),at=raw.lastIndexOf(') ');
  if(at<0||Number(raw.slice(0,raw.indexOf(' ')))!==pid)fail();
  return raw.slice(at+2).trim().split(/\s+/)[19];
 }
 function owned(pid){const set=new Set();for(const fd of readdirSync(join(procRoot,String(pid),'fd'))){try{const m=/^socket:\[(\d+)\]$/.exec(readlinkSync(join(procRoot,String(pid),'fd',fd)));if(m)set.add(m[1]);}catch{}}return set;}
 function stateCurrent(epoch){
  if(binding.bootId!==epoch.bootId)return reject('STATE_BOOT_CHANGED');
  if(processStart(binding.pid)!==binding.start)return reject('STATE_PROCESS_START_CHANGED');
  if(realpathSync(binding.storePath)!==directory)return reject('STATE_STORE_PATH_CHANGED');
  const base=join(procRoot,String(binding.pid));
  if(realpathSync(join(base,'exe'))!==exe||signature(statSync(join(base,'exe')))!==exeStat||signature(statSync(exe))!==exeStat)return reject('STATE_EXECUTABLE_CHANGED');
  if(readlinkSync(join(base,'ns/net'))!==epoch.netNamespace||readlinkSync(join(base,'ns/pid'))!==epoch.pidNamespace)return reject('STATE_NAMESPACE_CHANGED');
  const uids=/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(readFileSync(join(base,'status'),'utf8'));
  if(!uids||uids.slice(1).some(x=>Number(x)!==epoch.workerUid))return reject('STATE_UID_CHANGED');
  const sockets=owned(binding.pid),engineSockets=owned(epoch.engine.pid),port=Number(new URL(epoch.endpoint).port);
  const entries=[],relevant=new Set([...sockets,...engineSockets]);
  for(const file of ['tcp','tcp6'])for(const row of readOwnedTcpRows(join(base,'net',file),relevant))if(row.state==='01')entries.push(row);
  const loopback=address=>/^(0100007F|0000000000000000FFFF00000100007F|00000000000000000000000001000000):/i.test(address);
  const connections=entries.filter(e=>sockets.has(e.inode)&&loopback(e.local)&&loopback(e.remote)&&parseInt(e.remote.split(':')[1],16)===port);
  if(connections.length<1)return reject('STATE_ENGINE_CONNECTION_MISSING');
  if(connections.length>16)return reject('STATE_ENGINE_CONNECTION_LIMIT');
  if(connections.some(connection=>entries.filter(e=>e.local===connection.remote&&e.remote===connection.local&&engineSockets.has(e.inode)).length!==1))return reject('STATE_ENGINE_SOCKET_OWNER_UNVERIFIED');
  return processStart(binding.pid)===binding.start||reject('STATE_PROCESS_CHANGED_DURING_CAPTURE');
 }
 const state={pid:binding.pid,start:binding.start,instanceId:binding.instanceId,store:digest(directory),executableSha256:expectedExecutable.sha256};
 function capture(){lastFailure=null;try{const epoch=engineEvidence.capture();if(!epoch){lastFailure=engineEvidence.diagnostic?.()??'ENGINE_EPOCH_UNVERIFIED';return null;}for(let attempt=0;attempt<3;attempt++){
   if(stateCurrent(epoch)){lastFailure=null;return {...epoch,state:{...state}};}
   if(!['STATE_ENGINE_SOCKET_OWNER_UNVERIFIED','STATE_ENGINE_CONNECTION_MISSING'].includes(lastFailure))return null;
   if(!engineEvidence.current(epoch)){lastFailure=engineEvidence.diagnostic?.()??'ENGINE_EPOCH_CHANGED';return null;}
  }return null;}catch(error){lastFailure=['ENOENT','ESRCH','EACCES','EPERM'].includes(error?.code)?'STATE_PROC_'+error.code:/^PROC_TCP_[A-Z_]+$/.test(error?.code??'')?error.code:'STATE_CAPTURE_FAILED';return null;}}
 const initial=capture();if(!initial)fail();
 return {...engineEvidence,capture,diagnostic:()=>lastFailure,current(expected){const now=capture();if(!now)return false;if(!expected?.state)return reject('STATE_EXPECTED_EPOCH_MISSING');if(!engineEvidence.current(expected))return reject(engineEvidence.diagnostic?.()??'ENGINE_EPOCH_CHANGED');if(JSON.stringify(now.state)!==JSON.stringify(expected.state))return reject('STATE_EPOCH_CHANGED');return true;}};
}
export function pinStateClient(sdk,prefix,current=()=>true,diagnostic=()=>'STATE_EPOCH_NOT_CURRENT'){
 if(!/^state::[a-f0-9-]{36}::$/.test(prefix))fail();
 return new Proxy(sdk,{get(target,key){
  if(key==='trigger')return async request=>{
   const stateCall=request.function_id.startsWith('state::');
   if(stateCall&&!current())throw stateDispatchRejected(diagnostic()??'STATE_EPOCH_NOT_CURRENT');
   const result=await target.trigger({...request,function_id:stateCall?prefix+request.function_id.slice(7):request.function_id});
   if(stateCall&&!current()){const reason=diagnostic()??'STATE_EPOCH_NOT_CURRENT';throw Object.assign(Error('STATE_WRITER_IDENTITY_CHANGED:after_dispatch:'+reason),{code:'STATE_WRITER_IDENTITY_CHANGED',phase:'after_dispatch',diagnostic:reason});}
   return result;
  };
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
}
