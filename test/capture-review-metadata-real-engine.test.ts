import {afterEach,expect,it,vi} from 'vitest';
import {realpath} from 'node:fs/promises';
import {registerWorker} from 'iii-sdk';
import {StateKV} from '../src/state/kv.js';
import {KV} from '../src/state/schema.js';
import {registerCaptureFunctions} from '../src/functions/capture.js';
import {registerApiTriggers} from '../src/triggers/api.js';

// The external harness owns the isolated engine lifecycle. Never discover or
// fall back to a production URL, home, store, secret, or port.
const enabled=process.env.AM_METADATA_CONTRACT_EXPERIMENT==='1';
afterEach(()=>vi.unstubAllEnvs());
it.skipIf(!enabled)('roundtrips registered metadata queries through the real engine caller envelope',async()=>{
 const endpoint=new URL(process.env.AM_ISOLATED_ENGINE_URL??'');
 if(endpoint.protocol!=='ws:'||!['127.0.0.1','localhost'].includes(endpoint.hostname)||!endpoint.port||['49134','3111','3112','3113','4098','4131','4132','4133'].includes(endpoint.port))throw Error('isolated_endpoint_required');
 const store=await realpath(process.env.AM_ISOLATED_ENGINE_STORE??'');const home=await realpath(process.env.HOME??'');
 if(!store.startsWith('/tmp/')||!home.startsWith('/tmp/'))throw Error('temporary_home_and_store_required');
 // Fail before constructors can consume inherited operating path overrides.
 if(process.env.AGENTMEMORY_STATE_STORE_PATH!==store||!process.env.AGENTMEMORY_DATA_DIR?.startsWith('/tmp/'))throw Error('isolated_path_overrides_required');
 const dataDir=await realpath(process.env.AGENTMEMORY_DATA_DIR);
 if(!store.startsWith(dataDir+'/'))throw Error('isolated_store_must_be_inside_data_dir');
 // Vitest assigns a new temporary HOME; bind the collector home to that value.
 vi.stubEnv('AGENTMEMORY_HOME',home);
 const sdk=registerWorker(endpoint.href,{workerName:'synthetic-metadata-contract',invocationTimeoutMs:5000,enableMetricsReporting:false,otel:{enabled:false}});
 let controller:ReturnType<typeof registerCaptureFunctions>|undefined;
 try{
  await sdk.trigger({function_id:'state::get',payload:{scope:'synthetic-readiness',key:'absent'}});
  const kv=new StateKV(sdk);controller=registerCaptureFunctions(sdk,kv,{durableAfterMs:2000});registerApiTriggers(sdk,kv,'synthetic-only-secret');
  const invoke=()=>sdk.trigger<any,any>({function_id:'api::capture-review-metadata',payload:{query_params:{status:'dead',limit:'25'},headers:{authorization:'Bearer synthetic-only-secret'}}});
  const empty=await invoke();expect(empty.status_code).toBe(200);expect(empty.body.items).toHaveLength(0);
  for(let n=0;n<22;n++){
   const key='cap_'+n.toString(16).padStart(40,'0');
   await sdk.trigger({function_id:'state::set',payload:{scope:KV.captureReview,key,value:{key,eventId:'synthetic-private-event',sessionId:'synthetic-private-session',observationId:'synthetic-private-observation',status:'dead',acceptedAt:'2026-10-22T00:00:00Z',totalAttempts:6,failures:[{code:'CAPTURE_STORE_FAILED'}]}}});
   if(n===0){const one=await invoke();expect(one.status_code).toBe(200);expect(one.body.items).toHaveLength(1);}
  }
  const full=await invoke();expect(full.status_code).toBe(200);expect(full.body.items).toHaveLength(22);expect(full.body).toMatchObject({sourceRead:false,inboxRead:false,readOnly:true,nextOffset:null});
  expect(full.body.items.every((row:any)=>row.retryAuthorized===false&&row.diskVerified===false)).toBe(true);
  expect(JSON.stringify(full.body)).not.toMatch(/synthetic-private|_caller_worker_id|sessionId|observationId|digest|preview|payload/);
  const rejected:any=await sdk.trigger({function_id:'api::capture-review-metadata',payload:{query_params:{_caller_worker_id:'synthetic-private'},headers:{authorization:'Bearer synthetic-only-secret'}}});expect(rejected.status_code).toBe(400);
 }finally{controller?.stop();await sdk.shutdown();}
},20000);
