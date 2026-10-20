import { randomUUID } from 'node:crypto';
import { KV } from '../state/schema.js';
import type { StateKV } from '../state/kv.js';
import { withKeyedLock } from '../state/keyed-mutex.js';
import type { InboxRecord } from '../functions/capture.js';
import { captureEventScope } from './event-record.js';
import type { CaptureReviewHistory, CaptureRetryJob as Job, CaptureRetryJobItem as Item, CaptureRetryJobItemState as ItemState } from '../types.js';

type Alias = Omit<Job,'items'|'stopRequested'|'status'> & {aliasOf:string};
type Selection = { requestId: string; all?: boolean; eventId?: string; key?: string };
const active = (job: Job) => job.status === 'running' || job.status === 'stopping';
const terminal = (item: Item) => ['recovered','dead','skipped'].includes(item.status);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function createCaptureRetryJobs(kv: StateKV, retry: (key: string, force: boolean, requestId: string) => Promise<string>) {
  let working = false;
  let phase='idle',phaseStartedAt:string|null=null,lastErrorCode:string|null=null;
  const stage=(value:string)=>{phase=value;phaseStartedAt=new Date().toISOString();};
  const lock = <T>(fn: () => Promise<T>) => withKeyedLock('capture-retry-jobs', fn);
  const get = async (id: string) => { const job = await kv.get<Job & {aliasOf?:string}>(KV.captureJobs,id);if(job?.aliasOf){const parent=await kv.get<Job>(KV.captureJobs,job.aliasOf);return parent?structuredClone(parent):null;}return job ? structuredClone(job) : null; };
  async function latest() {
    const jobs = (await kv.list<Job>(KV.captureJobs)).filter(j=>j?.id&&Array.isArray(j.items));
    return jobs.filter(active).sort((a,b)=>a.createdAt.localeCompare(b.createdAt))[0] ?? jobs.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id))[0] ?? null;
  }
  async function save(job: Job | Alias) {
    job.updatedAt=new Date().toISOString();
    await kv.set(KV.captureJobs,job.id,structuredClone(job));
    if(kv.durability){const result=await kv.durability.waitForKeys(kv,[{scope:KV.captureJobs,key:job.id}]);if(!result.synced||result.mutationFailures!==0)throw Error('CAPTURE_JOB_STORAGE_UNVERIFIED');}
  }
  function view(job: Job | null) {
    if(!job)return null;
    const count=(status:ItemState)=>job.items.filter(x=>x.status===status).length;
    const current=job.items.find(x=>x.status==='working'||x.status==='waiting');
    return {worker:active(job)?{busy:working,phase,phaseStartedAt,lastErrorCode}:null,id:job.id,status:job.status,stopRequested:job.stopRequested,all:job.all,total:job.items.length,recovered:count('recovered'),failed:count('dead'),skipped:count('skipped'),remaining:job.items.filter(x=>!terminal(x)).length,
      current:current?{eventId:current.eventId,status:current.status}:null,lastErrorCode:job.items.find(x=>x.errorCode)?.errorCode??null,createdAt:job.createdAt,updatedAt:job.updatedAt};
  }
  return {
    async status(id?:string) { return view(id?await get(id):await latest()); },
    async start(input: Selection) {
      if(!uuid.test(input.requestId)||input.all!==true&&!input.eventId||input.all===true&&(input.eventId||input.key))throw Error('INVALID_CAPTURE_JOB');
      return lock(async()=>{
        const raw=await kv.get<Job & {aliasOf?:string}>(KV.captureJobs,input.requestId);const previous=raw?structuredClone(raw):null;
        if(previous){if(previous.all!==(input.all===true)||previous.key!==input.key||previous.eventId!==input.eventId)throw Error('CAPTURE_JOB_CONFLICT');await save(previous);return view(await get(input.requestId))!;}
        const running=await latest();if(running&&active(running)){
          const now=new Date().toISOString();await save({id:input.requestId,aliasOf:running.id,all:input.all===true,...(input.eventId?{eventId:input.eventId}:{}),...(input.key?{key:input.key}:{}),createdAt:now,updatedAt:now});return view(running)!;
        }
        const records=(await kv.list<InboxRecord>(KV.captureInbox)).filter(r=>r.status==='dead'&&(input.all||r.eventId===input.eventId&&(!input.key||r.key===input.key)));
        if(records.length>10000)throw Error('CAPTURE_JOB_TOO_LARGE');
        const now=new Date().toISOString();const job:Job={id:input.requestId,all:input.all===true,...(input.eventId?{eventId:input.eventId}:{}),...(input.key?{key:input.key}:{}),status:records.length?'running':'completed',stopRequested:false,createdAt:now,updatedAt:now,
          items:records.sort((a,b)=>a.acceptedAt.localeCompare(b.acceptedAt)||a.key.localeCompare(b.key)).map(r=>({key:r.key,eventId:r.eventId,requestId:randomUUID(),status:'queued'}))};
        await save(job);return view(job)!;
      });
    },
    async stop(id:string) {
      if(!uuid.test(id))throw Error('INVALID_CAPTURE_JOB');
      return lock(async()=>{const job=await get(id);if(!job)return null;if(active(job)){job.stopRequested=true;job.status=job.items.some(x=>x.status==='working'||x.status==='waiting')?'stopping':'stopped';await save(job);}return view(job);});
    },
    async tick() {
      if(working)return;working=true;stage('loading');
      try{
        const selected=await lock(async()=>{
          const saved=await latest();if(!saved||!active(saved))return null;
          const job=structuredClone(saved);const item=job.items.find(x=>!terminal(x));
          if(!item){job.status='completed';await save(job);return null;}
          if(job.stopRequested&&item.status==='queued'){job.status='stopped';await save(job);return null;}
          const inbox=await kv.get<InboxRecord>(KV.captureInbox,item.key);const history=await kv.get<CaptureReviewHistory>(KV.captureReview,item.key);
          const request=history?.requests[item.requestId];
          if(history?.status==='completed'){
            const observation=history.sessionId&&history.observationId?await kv.get<{id:string}>(KV.observations(history.sessionId),history.observationId):null;
            if(history.observationId&&observation?.id===history.observationId)return {job:job.id,key:item.key,outcome:'recovered'};
            if(!inbox)return {job:job.id,key:item.key,outcome:'dead',errorCode:'CAPTURE_OBSERVATION_NOT_STORED'};
          }
          if(!inbox)return {job:job.id,key:item.key,outcome:'skipped'};
          if(inbox.status==='dead'&&request?.outcome==='dead')return {job:job.id,key:item.key,outcome:'dead'};
          if(inbox.manualRequestId===item.requestId&&inbox.status==='retrying'){if(item.status!=='waiting'){item.status='waiting';await save(job);}return null;}
          item.status='working';await save(job);return {job:job.id,key:item.key,requestId:item.requestId};
        });
        lastErrorCode=null;if(!selected)return;stage('retry');
        let outcome=selected.outcome??await retry(selected.key,true,selected.requestId!);
        stage('verify');
        let errorCode='errorCode' in selected?selected.errorCode:undefined;
        if(outcome==='recovered'){
          const history=await kv.get<CaptureReviewHistory>(KV.captureReview,selected.key);
          const observation=history?.sessionId&&history.observationId?await kv.get<{id:string}>(KV.observations(history.sessionId),history.observationId):null;
          if(!history?.observationId||observation?.id!==history.observationId){outcome='dead';errorCode='CAPTURE_OBSERVATION_NOT_STORED';}
        }
        // Publish the result dependencies before the durable job checkpoint.
        if(['recovered','dead','gone','skipped'].includes(outcome)&&kv.durability){
          const history=await kv.get<CaptureReviewHistory>(KV.captureReview,selected.key);
          const keys=[{scope:KV.captureReview,key:selected.key},{scope:KV.captureInbox,key:selected.key},{scope:captureEventScope(selected.key),key:selected.key}];
          if(history?.sessionId&&history.observationId)keys.push({scope:KV.observations(history.sessionId),key:history.observationId});
          const result=await kv.durability.waitForKeys(kv,keys);if(!result.synced||result.mutationFailures!==0)throw Error('CAPTURE_JOB_RESULT_UNVERIFIED');
        }
        stage('checkpoint');
        await lock(async()=>{const job=await get(selected.job);if(!job)return;const item=job.items.find(x=>x.key===selected.key)!;if(errorCode)item.errorCode=errorCode;
          item.status=outcome==='recovered'?'recovered':outcome==='dead'?'dead':outcome==='gone'||outcome==='skipped'?'skipped':'waiting';
          if(job.items.every(terminal))job.status='completed';else if(job.stopRequested&&terminal(item))job.status='stopped';
          await save(job);
        });
      }catch(error){lastErrorCode=/timeout|timed out/i.test(error instanceof Error?error.message:'')?'CAPTURE_JOB_STORE_TIMEOUT':'CAPTURE_JOB_STORAGE_UNAVAILABLE';throw error;}finally{working=false;phase='idle';phaseStartedAt=null;}
    },
  };
}
