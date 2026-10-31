import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {readNamespaceEntries} from './namespace-reader.mjs';
import {graphProjection,fingerprint} from './enrichment-projection.mjs';
const fail=code=>Object.assign(Error(code),{code});
export const observationWorkHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function describeObservationWork(key,value,options){
 if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.id!=='string'||value.id!==key)throw fail('observation_work_identity_invalid');
 const json=JSON.stringify(value);
 if(Buffer.byteLength(json)>15*1024*1024)throw fail('observation_exceeds_page_budget');
 const row={id:value.id,key,timestamp:value.timestamp??'',_workHash:createHash('sha256').update(json).digest('hex')};
 if(options.kind==='summary'){
  row.type=value.type==='decision'?'decision':'';row.importance=value.importance>=8?8:0;
  if((value.sourceRaw?.hookType??value.hookType)==='prompt_submit')row.sourceRaw={hookType:'prompt_submit'};
 }else{
  row._workTitle=!!value.title;row.llmCompressionRevision=value.llmCompressionRevision==='enrichment-v2'?'enrichment-v2':undefined;
  if(value.title&&(!options.compressEnabled||value.llmCompressionRevision==='enrichment-v2')){
   const projection=graphProjection(value,options.inputChars);
   row._workGraphFingerprint=fingerprint(projection);row._workGraphChars=JSON.stringify(projection).length;
  }
 }
 const detached=JSON.parse(JSON.stringify(row));
 if(detached.sourceRaw)Object.freeze(detached.sourceRaw);
 return Object.freeze(detached);
}
export function createObservationWorkReader({storePath,kv,bulkRead,fileRevision,pending,mutationRevision,pendingMutations,context=()=>true,cacheBytes=8*1024*1024}){
 const cache=new Map();let retained=0,epoch;
 function clear(){cache.clear();retained=0;}
 function checkedContext(expected){const current=context();if(!current){clear();throw fail('observation_work_context_unverified');}if(expected!==undefined&&current!==expected)throw fail('observation_work_source_changed');return current;}
 function drop(key){const entry=cache.get(key);if(entry){retained-=entry.bytes;cache.delete(key);}}
 return async function work(scope,options){
  const signal=options?.signal;signal?.throwIfAborted();
  options={kind:options?.kind,...options?.kind==='enrichment'?{inputChars:options.inputChars,compressEnabled:options.compressEnabled}:{}};
  if(!scope.startsWith('mem:obs:')||!['summary','enrichment'].includes(options?.kind))throw fail('observation_work_options_invalid');
  if(options.kind==='enrichment'&&(!Number.isSafeInteger(options.inputChars)||options.inputChars<1))throw fail('observation_work_options_invalid');
  const token=checkedContext();if(epoch!==token){clear();epoch=token;}
  const initialMutation=mutationRevision(scope);
  if(pendingMutations(scope))throw fail('observation_work_source_changed');
  const file=await fileRevision(scope),key=scope+'\0'+JSON.stringify(options);
  checkedContext(token);
  let entry=cache.get(key);
  if(entry?.file!==file){
   drop(key);let rows=new Map(),signature='absent',size=0;
   for(let attempt=0;;attempt++){
    rows=new Map();size=0;
    try{
     const result=await readNamespaceEntries(join(storePath,encodeURIComponent(scope)+'.bin'),{signal,withReadChunk:bulkRead,onEntry:(key,value)=>{
      const row=describeObservationWork(key,value,options);rows.set(key,row);size+=Buffer.byteLength(JSON.stringify(row));
     }});signature=result.signature;break;
    }catch(error){if(error.code==='ENOENT')break;if(error.code==='state_namespace_changed'&&attempt<1)continue;throw error;}
   }
   signal?.throwIfAborted();checkedContext(token);
   if(signature!==await fileRevision(scope))throw fail('observation_work_source_changed');
   entry={file:signature,rows,bytes:size};
   if(size<=cacheBytes){
    drop(key);
    while(cache.size&&(cache.size>=8||retained+size>16*1024*1024))drop(cache.keys().next().value);
    cache.set(key,entry);retained+=size;
   }
  }else{cache.delete(key);cache.set(key,entry);}
  const rows=new Map(entry.rows),overlay=pending.get(scope);
  for(const [key,info] of new Map(overlay??[])){
   if(info===null){if(!entry.rows.has(key)&&overlay.get(key)===info)overlay.delete(key);rows.delete(key);continue;}
   if(rows.get(key)?._workHash===info.fingerprint){if(overlay.get(key)===info)overlay.delete(key);continue;}
   const value=await kv.get(scope,key);checkedContext(token);
   if(value==null)rows.delete(key);else rows.set(key,describeObservationWork(key,value,options));
  }
  if(overlay&&!overlay.size&&pending.get(scope)===overlay)pending.delete(scope);
  const finalFile=await fileRevision(scope);
  signal?.throwIfAborted();checkedContext(token);
  if(initialMutation!==mutationRevision(scope)||pendingMutations(scope)||entry.file!==finalFile)throw fail('observation_work_source_changed');
  const load=async row=>{
   signal?.throwIfAborted();checkedContext(token);if(rows.get(row.key)!==row)throw fail('observation_work_source_changed');
   if(pendingMutations(scope))throw fail('observation_work_source_changed');
   const value=await kv.get(scope,row.key);signal?.throwIfAborted();checkedContext(token);
   if(pendingMutations(scope))throw fail('observation_work_source_changed');
   if(value==null||observationWorkHash(value)!==row._workHash)throw fail('observation_work_source_changed');
   return value;
  };
  const validate=()=>{signal?.throwIfAborted();checkedContext(token);};
  return {rows:[...rows.values()],load,validate,describe:value=>{validate();return describeObservationWork(value.id,value,options);}};
 };
}
