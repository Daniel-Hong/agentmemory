import {constants} from 'node:fs';
import {open,mkdir,lstat,realpath,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {timingSafeEqual} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const fault=(code,status=503)=>Object.assign(Error(code),{code,status});
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const candidateId=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value);
async function json(path,limit=131072){
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const info=await handle.stat();if(!info.isFile()||info.size>limit)throw fault('update_record_invalid');const data=await handle.readFile('utf8');if(Buffer.byteLength(data)>limit)throw fault('update_record_invalid');return JSON.parse(data);}finally{await handle.close();}
}
const jobFields=['jobId','candidateId','status','phase','createdAt','updatedAt','errorCode','verificationComplete'];
function publicJob(value){if(!value||!uuid(value.jobId)||!candidateId(value.candidateId)||!['queued','running','applied_pending_acceptance','failed','interrupted'].includes(value.status))throw fault('update_record_invalid');const result=Object.fromEntries(jobFields.filter(k=>value[k]!==undefined).map(k=>[k,value[k]]));if(Array.isArray(value.events))result.events=value.events.slice(-12).map(e=>Object.fromEntries(['status','phase','at','errorCode'].filter(k=>typeof e[k]==='string'&&e[k].length<=80).map(k=>[k,e[k]])));return result;}
export function createDashboardUpdates({publicRoot='/var/lib/agentmemory-updates/public',requestRoot,version,dispatch=async id=>{await exec('/usr/bin/sudo',['-n','/usr/local/libexec/agentmemory-update-request',id],{timeout:15000,maxBuffer:8192});}}){
 const inflight=new Map();
 async function job(id){
  if(!uuid(id))throw fault('invalid_job_id',400);
  let result;try{result=publicJob(await json(join(publicRoot,'jobs',id+'.json')));}catch(error){if(error.code==='ENOENT')throw fault('update_job_not_found',404);throw error;}
  if(result.status==='failed'){
   try{
    const state=await json(join(publicRoot,'release-kit-state',result.candidateId+'.json'),4096);
    const at=Date.parse(state.at),created=Date.parse(result.createdAt);
    if(state.phase==='failed'&&Number.isFinite(at)&&Number.isFinite(created)&&at>=created&&['not_needed','restored','manual_required','restore_failed'].includes(state.recoveryStatus)){
     const errors=['INSTALL_PATH_NOT_WRITABLE','USER_TRANSITION_REFUSED','DEPENDENCY_REUSE_NOT_COMPATIBLE','BACKUP_READBACK_FAILED','PACKAGE_HASH_MISMATCH','SHUTDOWN_NOT_VERIFIED','COLD_DATA_CHANGED','USER_PHASE_FAILED','ROOT_ASSET_CHANGED','PROTECTED_FILE_CHANGED','UPDATE_FAILED'];
     result.failure={errorCode:errors.includes(state.errorCode)?state.errorCode:'UPDATE_FAILED',failedPhase:typeof state.failedPhase==='string'&&/^[a-z_]{1,60}$/.test(state.failedPhase)?state.failedPhase:'unknown',recoveryStatus:state.recoveryStatus};
    }
   }catch{/* Older kits have no structured failure receipt; keep the original job. */}
  }
  return result;
 }
 async function list(){
  let catalog;try{catalog=await json(join(publicRoot,'catalog.json'),65536);}catch(error){if(error.code==='ENOENT')return{available:false,reason:'administrator_setup_required',currentVersion:version,candidates:[],jobs:[]};throw error;}
  if(!Array.isArray(catalog.candidates)||catalog.candidates.length>100)throw fault('update_catalog_invalid');
  const candidates=catalog.candidates.map(c=>{
   if(!candidateId(c.id)||c.approved!==true||(typeof c.version!=='string'||c.version.length>100)||!/^[0-9a-f]{40}$/.test(c.sourceCommit)||!/^[0-9a-f]{64}$/.test(c.packageSha256)||typeof c.changeSummary!=='string'||Buffer.byteLength(c.changeSummary)>8192||!Array.isArray(c.tests)||c.tests.length>50||c.tests.some(t=>typeof t!=='string'||Buffer.byteLength(t)>1000))throw fault('update_catalog_invalid');
   return {id:c.id,version:c.version,sourceCommit:c.sourceCommit,packageSha256:c.packageSha256,changeSummary:c.changeSummary,tests:c.tests,approved:true};
  });
  let names=[];try{names=await readdir(join(publicRoot,'jobs'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const files=await Promise.all(names.filter(n=>uuid(n.replace(/\.json$/,''))&&n.endsWith('.json')).map(async n=>{const info=await lstat(join(publicRoot,'jobs',n));return info.isFile()?{id:n.slice(0,-5),updated:info.mtimeMs}:null;}));
  const recent=files.filter(Boolean).sort((a,b)=>b.updated-a.updated).slice(0,10);
  const jobs=await Promise.all(recent.map(file=>job(file.id)));
  jobs.sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
  return {available:true,currentVersion:version,candidates,jobs};
 }
 async function startOnce(body){
  if(!body||Array.isArray(body)||Object.keys(body).sort().join(',')!=='candidateId,requestId'||!uuid(body.requestId)||!candidateId(body.candidateId))throw fault('invalid_update_request',400);
  const id=body.requestId,path=join(requestRoot,id+'.json');
  let existing;try{existing=await json(path,4096);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(existing&&(existing.jobId!==id||existing.candidateId!==body.candidateId))throw fault('update_request_conflict',409);
  try{const saved=await job(id);if(saved.candidateId!==body.candidateId)throw fault('update_request_conflict',409);if(saved.status!=='queued')return saved;}catch(error){if(error.status!==404)throw error;}
  const catalog=await list();if(!catalog.available)throw fault('administrator_setup_required');if(!catalog.candidates.some(c=>c.id===body.candidateId))throw fault('unapproved_candidate',400);
  let names=[];try{names=await readdir(join(publicRoot,'jobs'));}catch(error){if(error.code!=='ENOENT')throw error;}
  for(const name of names){
   if(!name.endsWith('.json')||!uuid(name.slice(0,-5)))continue;
   const previous=await json(join(publicRoot,'jobs',name));
   if(previous.candidateId===body.candidateId&&['failed','interrupted'].includes(previous.status))throw fault('candidate_previously_failed',409);
  }
  await mkdir(requestRoot,{recursive:true,mode:0o700});const info=await lstat(requestRoot);
  if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid?.()||info.mode&0o077||await realpath(requestRoot)!==resolve(requestRoot))throw fault('update_request_path_unsafe');
  if(!existing){
   const handle=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   try{await handle.writeFile(JSON.stringify({jobId:id,candidateId:body.candidateId})+'\n');await handle.sync();}finally{await handle.close();}
   const dir=await open(requestRoot,'r');try{await dir.sync();}finally{await dir.close();}
  }
  try{await dispatch(id);}catch{throw fault('update_dispatch_unavailable');}
  return job(id);
 }
 async function start(body){const id=body?.requestId;if(inflight.has(id)){const pending=inflight.get(id);if(pending.candidateId!==body.candidateId)throw fault('update_request_conflict',409);return pending.promise;}const promise=startOnce(body);inflight.set(id,{candidateId:body?.candidateId,promise});try{return await promise;}finally{inflight.delete(id);}}
 return {list,job,start};
}
export function registerDashboardUpdateApi(sdk,secret,updates){
 for(const [method,path,name,handler] of [
  ['GET','/updates','list',()=>updates.list()],
  ['POST','/updates/jobs','create',req=>updates.start(req.body)],
  ['GET','/updates/jobs/:id','job',req=>updates.job(req.path_params?.id||req.params?.id)],
 ]){
  const function_id='api::updates-'+name;
  sdk.registerFunction(function_id,async req=>{
   try{
    if(!secret)throw fault('authentication_required');const a=Buffer.from(req.headers?.authorization||req.headers?.Authorization||''),b=Buffer.from('Bearer '+secret);if(a.length!==b.length||!timingSafeEqual(a,b))throw fault('unauthorized',401);
    if(method==='POST'&&(req.headers?.['x-agentmemory-update']!=='1'||!/^application\/json(?:;|$)/i.test(req.headers?.['content-type']||'')||['cross-site','same-site'].includes(req.headers?.['sec-fetch-site'])))throw fault('update_marker_required',403);
    if(Buffer.byteLength(JSON.stringify(req.body??null))>4096)throw fault('update_body_too_large',413);
    const value=await handler(req),encoded=JSON.stringify(value);if(encoded.includes(secret)||Buffer.byteLength(encoded)>131072)throw fault('update_response_refused');return{status_code:method==='POST'?202:200,body:value};
   }catch(error){return{status_code:error.status||503,body:{error:error.status?error.code:'updates_unavailable'}};}
  });
  sdk.registerTrigger({type:'http',function_id,config:{api_path:'/agentmemory'+path,http_method:method,middleware_function_ids:['middleware::api-auth']}});
 }
}
