import {readFileSync,writeFileSync,renameSync,mkdirSync,realpathSync,readdirSync,readlinkSync,statSync} from 'node:fs';
import {join,dirname} from 'node:path';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';import {spawn} from 'node:child_process';import {parse,stringify} from 'yaml';
export function verifyArtifact(directory,pin){
 const root=realpathSync(directory),m=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'));
 for(const key of ['artifactVersion','upstreamCommit','patchSha256','engineVersion'])if(m[key]!==pin[key])throw Error('STATE_ARTIFACT_PROVENANCE_MISMATCH');
 if(m.schemaVersion!==1||m.binary!=='state'||m.profile!=='release'||m.target!==(process.arch==='x64'?'x86_64-unknown-linux-gnu':process.arch==='arm64'?'aarch64-unknown-linux-gnu':'unsupported'))throw Error('STATE_ARTIFACT_PLATFORM_MISMATCH');
 const path=realpathSync(join(root,'state'));if(!statSync(path).isFile()||!(statSync(path).mode&0o111))throw Error('STATE_ARTIFACT_BINARY_INVALID');
 const sha256=createHash('sha256').update(readFileSync(path)).digest('hex');if(sha256!==m.binarySha256)throw Error('STATE_ARTIFACT_HASH_MISMATCH');return{path,sha256};
}
export function selectEnginePid(rootPid,exe,port,proc='/proc'){
 const queue=[rootPid],seen=new Set(),matches=[];
 while(queue.length){const pid=queue.shift();if(seen.has(pid))continue;seen.add(pid);if(seen.size>32)throw Error('COMPOSE_PROCESS_TREE_TOO_LARGE');
  try{queue.push(...readFileSync(join(proc,`${pid}/task/${pid}/children`),'utf8').trim().split(/\s+/).filter(Boolean).map(Number));}catch{}
  try{if(realpathSync(join(proc,`${pid}/exe`))!==exe)continue;const sockets=new Set(readdirSync(join(proc,`${pid}/fd`)).flatMap(fd=>{try{const m=/^socket:\[(\d+)\]$/.exec(readlinkSync(join(proc,`${pid}/fd/${fd}`)));return m?[m[1]]:[];}catch{return[];}}));
   let listening=false;for(const name of ['tcp','tcp6'])for(const line of readFileSync(join(proc,`${pid}/net/${name}`),'utf8').split('\n')){const v=line.trim().split(/\s+/);if(v[3]==='0A'&&parseInt(v[1]?.split(':')[1],16)===port&&sockets.has(v[9]))listening=true;}
   if(listening)matches.push(pid);
  }catch{}
 }
 if(matches.length>1)throw Error('COMPOSE_ENGINE_AMBIGUOUS');return matches[0]??null;
}
const atomic=(path,value)=>{const temp=path+'.tmp';writeFileSync(temp,JSON.stringify(value)+'\n',{mode:0o600});renameSync(temp,path);};
export async function runBootstrap({file,runtimeDir,artifactDir,pinPath,engineBin='/usr/local/bin/iii'}){
 const stateExecutable=verifyArtifact(artifactDir,JSON.parse(readFileSync(pinPath,'utf8'))),exe=realpathSync(engineBin);
 const config=parse(readFileSync(file,'utf8'));const url=new URL(config.engine.url);if(url.hostname!=='127.0.0.1'||url.protocol!=='ws:')throw Error('COMPOSE_ENGINE_ENDPOINT_INVALID');
 mkdirSync(runtimeDir,{recursive:true,mode:0o700});const project=join(runtimeDir,'state-project');mkdirSync(project,{recursive:true,mode:0o700});
 writeFileSync(join(project,'iii.worker.yaml'),stringify({iii:'v1',name:'state',language:'rust',scripts:{start:stateExecutable.path}}),{mode:0o600});
 config.containers.state.worker='path://'+project;delete config.containers.state.version;
 config.containers.state.scripts={run:"'"+stateExecutable.path.replaceAll("'","'\\''")+"'"};
 config.containers.agentmemory.environment={...config.containers.agentmemory.environment,AGENTMEMORY_RUNTIME_DIR:runtimeDir};
 writeFileSync(file,stringify(config),{mode:0o600});
 const metadata={kind:'compose',engineUrl:url.href.replace(/\/$/,''),namespace:config.namespace,file,stateExecutable};const statePath=join(runtimeDir,'engine-state.json');atomic(statePath,metadata);
 const child=spawn(exe,['compose','--namespace',config.namespace,'--up','--file',file],{stdio:'inherit',env:process.env});
 const forward=signal=>{if(child.exitCode===null)child.kill(signal);};process.once('SIGTERM',forward);process.once('SIGINT',forward);
 let done=false;const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>{done=true;resolve(code??(signal?1:0));});});
 let timer;const deadline=Date.now()+120000;
 try{while(!done){const pid=selectEnginePid(child.pid,exe,Number(url.port));if(pid&&pid!==metadata.enginePid){metadata.enginePid=pid;atomic(statePath,metadata);}if(!metadata.enginePid&&Date.now()>deadline)throw Error('COMPOSE_ENGINE_METADATA_TIMEOUT');await Promise.race([exited,new Promise(r=>timer=setTimeout(r,100))]);clearTimeout(timer);}return await exited;}
 catch(error){forward('SIGTERM');await exited;throw error;}
 finally{process.removeListener('SIGTERM',forward);process.removeListener('SIGINT',forward);clearTimeout(timer);}
}
if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
 runBootstrap({file:process.env.WORKER_COMPOSE_FILE,runtimeDir:process.env.AGENTMEMORY_RUNTIME_DIR??join(process.env.AGENTMEMORY_DATA_DIR,'runtime'),artifactDir:process.env.AGENTMEMORY_STATE_WORKER_ARTIFACT??'/opt/agentmemory-state',pinPath:'/opt/agentmemory/deploy-runtime/state-pin.json'}).then(code=>{process.exitCode=code;}).catch(error=>{console.error(error.message);process.exitCode=1;});
}
