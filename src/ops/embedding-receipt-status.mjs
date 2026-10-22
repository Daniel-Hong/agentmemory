import {createHash} from 'node:crypto';
import {EMBEDDING_RETRY_NAMESPACE as RETRY,EMBEDDING_COMMITTED_NAMESPACE as COMMITTED} from './embedding-recovery.mjs';

const boundedId=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,256}$/.test(value);
const fingerprint=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const timestamp=value=>{
  if(typeof value!=='string'&&typeof value!=='number')return null;
  const time=typeof value==='number'?value:Date.parse(value);
  return Number.isFinite(time)&&time>=0&&time<=8640000000000000?new Date(time).toISOString():null;
};
const unavailable=()=>{throw Error('embedding_receipt_unavailable');};
function marker(row,id,committed=false){
  if(row==null)return null;
  if(row.id!==id||typeof row.sessionId!=='string'||row.sessionId.length>256||!['memory','observation','synthetic'].includes(row.kind))unavailable();
  if(committed&&!fingerprint(row.fingerprint))unavailable();
  if(row.generation!==undefined&&(typeof row.generation!=='string'||row.generation.length>256))unavailable();
  return {id:row.id,sessionId:row.sessionId,kind:row.kind,generation:row.generation??null,
    fingerprint:fingerprint(row.fingerprint)?row.fingerprint:null,phase:['queued','embedded'].includes(row.phase)?row.phase:'unknown',
    attempts:count(row.attempts),retryAt:count(row.retryAt),committedAt:timestamp(row.committedAt)};
}
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function base(id){return {id,status:'unavailable',retryPhase:null,attempts:null,retryAt:null,committedAt:null,
  diskVerified:false,completionConfirmed:false,durablePublicationObserved:false,verifiedAt:null,evidenceScope:'metadata_only'};}

export function createEmbeddingReceiptStatus({kv,KV,index,observedPublication,timeoutMs=5000}={}){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>5000)throw Error('embedding_receipt_timeout_invalid');
  let outstanding=0;
  async function inspect(id,read,withinBudget){
    const result=base(id);
    try{
      const guard=kv?.observationReader;
      if(typeof kv?.get!=='function'||typeof guard?.tracksMutations!=='function'||typeof guard?.mutationRevision!=='function'||typeof guard?.pendingMutations!=='function'||
        typeof index?.has!=='function'||typeof KV?.observations!=='function'||typeof KV?.memories!=='string'||typeof KV?.vectorPendingLog!=='string')return result;
      const revisions=new Map();
      function watch(scope){
        if(revisions.has(scope))return;
        if(guard.tracksMutations(scope)!==true)unavailable();
        const revision=guard.mutationRevision(scope),pending=guard.pendingMutations(scope);
        if(!Number.isSafeInteger(revision)||revision<0||pending!==0)unavailable();
        revisions.set(scope,revision);
      }
      function stable(){
        if(!withinBudget())unavailable();
        for(const [scope,revision] of revisions)if(guard.tracksMutations(scope)!==true||guard.pendingMutations(scope)!==0||guard.mutationRevision(scope)!==revision)unavailable();
      }
      watch(RETRY);watch(COMMITTED);watch(KV.vectorPendingLog);
      const queued=marker(await read(RETRY,id),id),committed=marker(await read(COMMITTED,id),id,true);
      let status='not_found',projection=null;
      if(queued)status='pending';
      else if(committed){
        const scope=committed.kind==='memory'?KV.memories:KV.observations(committed.sessionId);watch(scope);
        const row=await read(scope,id);
        if(row==null||committed.kind==='memory'&&row.isLatest===false)status='canonical_missing';
        else{
          if(row.id!==id||committed.kind!=='memory'&&row.sessionId!==committed.sessionId)unavailable();
          const title=String(row.title??'').slice(0,16000),body=String((committed.kind==='memory'?row.content:row.narrative)??'').slice(0,16000);
          projection=createHash('sha256').update((title+' '+body).slice(0,16000)).digest('hex');
          if(projection!==committed.fingerprint)status='projection_mismatch';
          else{
            const pending=await read(KV.vectorPendingLog,id),clear=await read(KV.vectorPendingLog,'~clear');
            status=pending!=null||clear!=null?'index_pending':'committed_metadata';
          }
        }
      }
      const latestQueued=marker(await read(RETRY,id),id),latestCommitted=marker(await read(COMMITTED,id),id,true);
      if(!same(queued,latestQueued)||!same(committed,latestCommitted))unavailable();
      stable();
      if(status==='committed_metadata'&&index.has(id)!==true)status='index_missing';
      let proof=null;
      if(status==='committed_metadata'&&typeof observedPublication==='function')proof=observedPublication(id);
      const verifiedAt=proof&&timestamp(proof.verifiedAt);
      if(status==='committed_metadata'&&proof&&fingerprint(proof.fingerprint)&&proof.fingerprint===projection&&verifiedAt&&
        committed.committedAt&&Date.parse(verifiedAt)>=Date.parse(committed.committedAt)){
        status='publication_verified_observed';
        result.durablePublicationObserved=true;result.verifiedAt=verifiedAt;result.evidenceScope='this_process_observation';
      }
      stable();
      return {...result,status,retryPhase:queued?.phase??null,attempts:queued?.attempts??null,retryAt:queued?.retryAt??null,committedAt:committed?.committedAt??null};
    }catch{return base(id);}
  }
  return async function query(input){
    const ids=input?.ids;
    if(!Array.isArray(ids)||ids.length<1||ids.length>32||!ids.every(boundedId)||new Set(ids).size!==ids.length)
      throw Object.assign(Error('embedding_receipt_query_invalid'),{code:'EMBEDDING_RECEIPT_QUERY_INVALID'});
    const selected=[...ids],deadline=performance.now()+timeoutMs;
    let stopped=false;
    const withinBudget=()=>!stopped&&performance.now()<deadline;
    async function read(scope,id){
      if(!withinBudget()||outstanding>=4){stopped=true;unavailable();}
      outstanding++;
      const pending=Promise.resolve().then(()=>{if(!withinBudget())unavailable();return kv.get(scope,id);});
      pending.then(()=>{outstanding--;},()=>{outstanding--;});
      let timer;
      try{
        const value=await Promise.race([pending,new Promise((_,reject)=>{
          timer=setTimeout(()=>{stopped=true;reject(Error('embedding_receipt_unavailable'));},Math.max(0,deadline-performance.now()));
        })]);
        if(!withinBudget())unavailable();
        return value;
      }finally{clearTimeout(timer);}
    }
    const items=[];
    for(const id of selected)items.push(withinBudget()?await inspect(id,read,withinBudget):base(id));
    return {version:1,evidence:'metadata_only',items};
  };
}
