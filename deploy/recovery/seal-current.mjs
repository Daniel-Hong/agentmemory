import {createHash} from 'node:crypto';
import {existsSync,readFileSync,openSync,writeFileSync,fsyncSync,closeSync,realpathSync} from 'node:fs';
import {dirname} from 'node:path';
import {createRequire} from 'node:module';
import {createEngineEpochEvidence,waitForEngineEpoch} from '../../src/ops/engine-epoch.mjs';
import {createStateBoundEvidence,pinStateClient} from '../../src/ops/state-epoch.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
function requireSafe(ok,code){if(!ok)throw Error(code);}
export function requirePausedHealth(h){
 const b=h?.backgroundControl,d=h?.storageDurability;
 requireSafe(b?.pausedRequested===true&&b.activeOperations===0&&Array.isArray(b.holds)&&b.holds.includes('deployment')&&d?.activeMutations===0&&Number.isSafeInteger(d.mutationFailures)&&d.mutationFailures>=0,'RECOVERY_NOT_QUIESCENT');
 return {background:{status:b.status,holds:[...b.holds],pausedRequested:true,activeOperations:0},storage:{mutationFailures:d.mutationFailures,activeMutations:0,lastVerification:d.lastVerification??null}};
}
export async function sealCurrentForRecovery({health,current,seal,identity,markerBytes,expectedMarkerSha256,persist,backgroundRecord}){
 requireSafe(hash(markerBytes)===expectedMarkerSha256,'RECOVERY_MARKER_CHANGED');
 const prior=JSON.parse(markerBytes);requireSafe(prior.version===4&&prior.clean===false&&prior.epoch?.state?.instanceId===identity.instanceId,'RECOVERY_V4_DIRTY_REQUIRED');
 const persistedBefore=await backgroundRecord();
 requireSafe(persistedBefore?.version===2&&persistedBefore.paused===true&&Array.isArray(persistedBefore.holds)&&persistedBefore.holds.includes('deployment'),'RECOVERY_PERSISTED_DEPLOYMENT_HOLD_REQUIRED');
 const before=requirePausedHealth(await health());requireSafe(current(),'RECOVERY_EPOCH_CHANGED');
 const receipt=await seal();
 requireSafe(current(),'RECOVERY_EPOCH_CHANGED_AFTER_SEAL');
 requireSafe(receipt?.version===1&&receipt.instanceId===identity.instanceId&&receipt.sealed===true&&receipt.synced===true&&receipt.storePath===identity.storePath,'RECOVERY_SEAL_UNVERIFIED');
 const persistedAfter=await backgroundRecord();requireSafe(JSON.stringify(persistedAfter)===JSON.stringify(persistedBefore),'RECOVERY_PERSISTED_HOLD_CHANGED');
 const after=requirePausedHealth(await health());
 requireSafe(after.storage.mutationFailures>=before.storage.mutationFailures&&before.background.holds.every(x=>after.background.holds.includes(x)),'RECOVERY_FAILURE_HISTORY_CHANGED');
 requireSafe(current(),'RECOVERY_EPOCH_CHANGED_BEFORE_RECEIPT');
 const proof={version:1,kind:'sealed-for-recovery',at:new Date().toISOString(),storageSealed:true,verifiedClean:false,semanticOutcomeUncertain:true,markerSha256:expectedMarkerSha256,priorEpoch:prior.epoch,before,after,persistedBackground:persistedAfter,stateSeal:receipt};
 await persist(proof);return proof;
}
function persistExclusive(path,value){const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);}const dir=openSync(dirname(path),'r');try{fsyncSync(dir);}finally{closeSync(dir);}}
async function main(path,inspect=false){
 const c=JSON.parse(readFileSync(path));if(!inspect)requireSafe(!existsSync(c.receipt),'RECOVERY_RECEIPT_EXISTS_INSPECT_ONLY');const require=createRequire(c.sdkPackageJson);const {registerWorker}=require('iii-sdk');
 const md=JSON.parse(readFileSync(c.metadata));requireSafe(md.kind==='compose'&&typeof c.namespace==='string'&&c.namespace===md.namespace&&new URL(c.engineUrl).href===new URL(md.engineUrl).href,'RECOVERY_COMPOSE_NAMESPACE_MISMATCH');
 const sdk=registerWorker(c.engineUrl,{namespace:c.namespace,workerName:'sealed-recovery-proof',enableMetricsReporting:false,otel:{enabled:false}});
 try{
  const e=createEngineEpochEvidence({engineUrl:c.engineUrl,engineStatePath:c.metadata,enginePidPath:c.enginePidFile,peer:()=>{const s=sdk.ws?._socket;return s?{localAddress:s.localAddress,localPort:s.localPort,remoteAddress:s.remoteAddress,remotePort:s.remotePort}:null;}});try{await waitForEngineEpoch(e);}catch(error){throw Error('RECOVERY_ENGINE_EPOCH_UNVERIFIED:'+(e.diagnostic?.()??error.message));}
  const identity=await sdk.trigger({function_id:'state::boot_identity',payload:{}});const prefix=`state::${identity.instanceId}::`;
  requireSafe(JSON.stringify(await sdk.trigger({function_id:prefix+'boot_identity',payload:{}}))===JSON.stringify(identity),'RECOVERY_ALIAS_CHANGED');
  const bound=createStateBoundEvidence({engineEvidence:e,identity,expectedExecutable:md.stateExecutable,storePath:c.store});const epoch=bound.capture();requireSafe(epoch,'RECOVERY_EPOCH_UNVERIFIED');
  const prior=JSON.parse(readFileSync(c.marker));requireSafe(JSON.stringify(epoch.engine)===JSON.stringify(prior.epoch?.engine)&&epoch.bootId===prior.epoch.bootId&&epoch.host===prior.epoch.host&&identity.pid===prior.epoch.state.pid&&identity.start===prior.epoch.state.start,'RECOVERY_PRIOR_EPOCH_MISMATCH');
  const client=pinStateClient(sdk,prefix,()=>bound.current(epoch),()=>bound.diagnostic());
  const url=new URL(c.healthUrl);requireSafe(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&!url.username&&!url.password&&url.pathname==='/agentmemory/health','RECOVERY_HEALTH_DESTINATION');
  // Only the explicit token file is read; no environment-file loading or hidden credentials.
  requireSafe(Boolean(c.secretFile)!==Boolean(c.secretEnvFile),'RECOVERY_EXPLICIT_SECRET_SOURCE_REQUIRED');
  const secret=c.secretFile?readFileSync(c.secretFile,'utf8').trim():require('dotenv').parse(readFileSync(c.secretEnvFile)).AGENTMEMORY_SECRET;requireSafe(typeof secret==='string'&&secret.length>0,'RECOVERY_SECRET_MISSING');
  const backgroundRecord=()=>client.trigger({function_id:'state::get',payload:{scope:'mem:background-control:v1',key:'manual-pause'}});
  const health=async()=>{const r=await fetch(url,{headers:{Authorization:'Bearer '+secret},signal:AbortSignal.timeout(10000)});requireSafe(r.ok,'RECOVERY_HEALTH_HTTP_'+r.status);return r.json();};
  if(inspect){const marker=readFileSync(c.marker,'utf8');requireSafe(hash(marker)===c.markerSha256,'RECOVERY_MARKER_CHANGED');requireSafe(prior.version===4&&prior.clean===false,'RECOVERY_V4_DIRTY_REQUIRED');const persistedBackground=await backgroundRecord();requireSafe(persistedBackground?.version===2&&persistedBackground.paused===true&&persistedBackground.holds?.includes('deployment'),'RECOVERY_PERSISTED_DEPLOYMENT_HOLD_REQUIRED');const status=requirePausedHealth(await health());requireSafe(bound.current(epoch),'RECOVERY_EPOCH_CHANGED');console.log(JSON.stringify({inspected:true,sealed:false,verifiedClean:false,namespace:c.namespace,priorEpoch:prior.epoch,status,persistedBackground}));return;}
  await sealCurrentForRecovery({health,backgroundRecord,current:()=>bound.current(epoch),seal:()=>client.trigger({function_id:'state::seal_flush',payload:{},timeoutMs:120000}),identity,markerBytes:readFileSync(c.marker,'utf8'),expectedMarkerSha256:c.markerSha256,persist:x=>persistExclusive(c.receipt,x)});
  console.log(JSON.stringify({sealedForRecovery:true,verifiedClean:false,receipt:c.receipt}));
 }finally{await sdk.shutdown();}
}
if(process.argv[1]&&realpathSync(process.argv[1])===realpathSync(new URL(import.meta.url))){
 if(!['--execute-reviewed-seal','--inspect'].includes(process.argv[2])||process.argv.length!==4)throw Error('EXPLICIT_RECOVERY_SEAL_REQUIRED');
 main(process.argv[3],process.argv[2]==='--inspect').catch(e=>{console.error(JSON.stringify({sealedForRecovery:false,error:e.message,inspectBeforeRetry:true}));process.exitCode=78;});
}
