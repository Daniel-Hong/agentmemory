import {readFile,stat} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {readNamespaceEntries} from './namespace-reader.mjs';
import {namespaceJson} from './state-durability.mjs';
import {parseListQuery,matchesText} from '../state/list-query.js';
import {observationBudgetEntry} from '../functions/observation-source-budget.js';

// Timestamp/id cursor contract backported from upstream PR #1433 (0c4c56f).
export const PAGE_BYTES=4*1024*1024;
const bytes=value=>Buffer.byteLength(JSON.stringify(value),'utf8');
const fail=(code,status=503)=>Object.assign(Error(code),{code,status});
const compare=(a,b)=>a.timestamp===b.timestamp?(a.id===b.id?0:a.id<b.id?1:-1):a.timestamp<b.timestamp?1:-1;
const cursorFor=o=>Buffer.from(JSON.stringify({key:o.timestamp,id:o.id})).toString('base64url');
function cursorPosition(cursor){
 if(!cursor)return null;
 try{if(typeof cursor!=='string'||cursor.length>4096)throw Error();const p=JSON.parse(Buffer.from(cursor,'base64url'));if(typeof p.key!=='string'||typeof p.id!=='string')throw Error();return {timestamp:p.key,id:p.id};}catch{throw fail('invalid_cursor',400);}
}
function metadata(key,o){
 if(!o||typeof o!=='object'||Array.isArray(o))throw fail('invalid_observation_record');
 const serialized=JSON.stringify(o);
 return {key,...observationBudgetEntry(o),id:typeof o.id==='string'?o.id:key,timestamp:o.timestamp??'',agentId:o.agentId,type:o.type||o.hookType||'other',importance:o.importance??0,searchFields:[o.title,o.subtitle,o.narrative,...(Array.isArray(o.facts)?o.facts:[]),...(Array.isArray(o.files)?o.files:[])].filter(value=>typeof value==='string'),tool:o.toolName||o.sourceRaw?.toolName||(o.origin?.channel==='tool'?o.origin.detail:null),files:Array.isArray(o.files)?o.files:[],firstPrompt:String(o.userPrompt||o.sourceRaw?.userPrompt||(o.type==='conversation'?o.narrative:'')||'').slice(0,600),bytes:Buffer.byteLength(serialized,'utf8'),fingerprint:createHash('sha256').update(serialized).digest('hex')};
}
export function sessionStats(rows){
 const tools=new Map(),types=new Map(),files=new Set();let firstPrompt='';
 for(const o of rows){types.set(o.type,(types.get(o.type)||0)+1);if(o.tool&&o.type!=='conversation')tools.set(o.tool,(tools.get(o.tool)||0)+1);for(const f of o.files)if(typeof f==='string')files.add(f);if(!firstPrompt&&o.firstPrompt)firstPrompt=o.firstPrompt;}
 const top=(map,n)=>Object.fromEntries([...map].sort((a,b)=>b[1]-a[1]||String(a[0]).localeCompare(String(b[0]))).slice(0,n));
 return {observationCount:rows.length,toolsUsed:tools.size,filesTouched:files.size,toolCounts:top(tools,10),typeCounts:top(types,30),files:[...files].slice(0,30),firstPrompt};
}
export function createObservationReader({storePath,kv}){
 if(!isAbsolute(storePath))throw fail('absolute_state_store_path_required');
 const cache=new Map(),pending=new Map(),removed=new Map(),mutations=new Map(),captureBudgets=new Map(),uncertainScopes=new Set();
 function invalidateCaptureSummary(scope){if(scope.startsWith('mem:obs:')){uncertainScopes.add(scope);captureBudgets.delete(scope);}}
 async function revision(scope){
  let file='absent';try{const value=await stat(join(storePath,encodeURIComponent(scope)+'.bin'),{bigint:true});file=[value.dev,value.ino,value.size,value.mtimeNs,value.ctimeNs].join(':');}catch(error){if(error.code!=='ENOENT')throw error;}
  return file+':'+(mutations.get(scope)??0);
 }
 function record(scope,key,value,deletedExisting=false){
  if(!scope.startsWith('mem:obs:'))return;
  mutations.set(scope,(mutations.get(scope)??0)+1);
  if(value===null&&(deletedExisting||cache.get(scope)?.rows.has(key)||pending.get(scope)?.get(key))){if(!removed.has(scope))removed.set(scope,new Set());removed.get(scope).add(key);}
  if(value!==null)removed.get(scope)?.delete(key);
  const info=value===null?null:metadata(key,value);
  if(!pending.has(scope))pending.set(scope,new Map());pending.get(scope).set(key,info);
  const budget=captureBudgets.get(scope);
  if(budget){if(value===null&&budget.ready)budget.rows.delete(key);else budget.rows.set(key,info===null?null:{id:info.id,summaryBytes:info.summaryBytes,sourceBytes:info.sourceBytes});}
 }
 async function captureSummary(scope,excludeId){
  if(uncertainScopes.has(scope))throw fail('observation_budget_mutation_uncertain');
  let budget=captureBudgets.get(scope);
  if(!budget){
   budget={rows:new Map(),ready:false};captureBudgets.set(scope,budget);
   // The file backend has one StateKV writer; record() maintains this metadata after the initial scan.
   budget.loading=(async()=>{
    try{
     const initial=new Map();
     for(let attempt=0;;attempt++){
      initial.clear();
      try{
       await readNamespaceEntries(join(storePath,encodeURIComponent(scope)+'.bin'),{onEntry:(key,value)=>{
        if(!value||typeof value!=='object'||Array.isArray(value))throw fail('invalid_observation_record');
        if(bytes(value)>15*1024*1024)throw fail('observation_exceeds_page_budget',413);
        initial.set(key,observationBudgetEntry(value));
       }});break;
      }catch(error){if(error.code==='ENOENT')break;if(error.code==='state_namespace_changed'&&attempt<1)continue;throw error;}
     }
     for(const [key,value] of pending.get(scope)||[]){if(value===null)initial.delete(key);else initial.set(key,{id:value.id,summaryBytes:value.summaryBytes,sourceBytes:value.sourceBytes});}
     for(const [key,value] of budget.rows){if(value===null)initial.delete(key);else initial.set(key,value);}
     budget.rows=initial;budget.ready=true;
    }catch(error){if(captureBudgets.get(scope)===budget)captureBudgets.delete(scope);throw error;}
   })();
  }
  await budget.loading;
  if(uncertainScopes.has(scope))throw fail('observation_budget_mutation_uncertain');
  const result={count:budget.rows.size,summaryCount:0,summaryBytes:0,sourceBytes:0};
  for(const row of budget.rows.values())if(excludeId===undefined||row.id!==excludeId){result.summaryCount++;result.summaryBytes+=row.summaryBytes;result.sourceBytes+=row.sourceBytes;}
  return result;
 }
 async function snapshot(scope){
  const path=join(storePath,encodeURIComponent(scope)+'.bin');let signature='absent';
  try{const s=await stat(path);signature=[s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');}catch(e){if(e.code!=='ENOENT')throw e;}
  if(cache.get(scope)?.signature!==signature){
   // shortcut: parses each file revision once; replace when iii offers native key/page queries.
   let rows=new Map();
   if(signature!=='absent')rows=new Map(Object.entries(namespaceJson(await readFile(path))).map(([key,value])=>[key,metadata(key,value)]));
   cache.set(scope,{signature,rows});
  }
  const rows=new Map(cache.get(scope).rows);
  const overlay=pending.get(scope);
  for(const [key,value] of overlay||[]){
   if(value===null){if(!rows.has(key))overlay.delete(key);rows.delete(key);}
   else {if(isDeepStrictEqual(rows.get(key),value))overlay.delete(key);rows.set(key,value);}
  }
  if(overlay&&!overlay.size)pending.delete(scope);
  return [...rows.values()];
 }
 async function read(rows){
  if(rows.some(o=>o.bytes>15*1024*1024))throw fail('observation_exceeds_page_budget',413);
  const result=[];
  for(let i=0;i<rows.length;i+=8){const batch=await Promise.all(rows.slice(i,i+8).map(o=>kv.get(o.scope,o.key)));result.push(...batch);}
  if(result.some(o=>!o))throw fail('observation_changed_retry');
  return result;
 }
 async function checkedSnapshot(scope){
  const rows=await snapshot(scope);
  const session=await kv.get('mem:sessions',scope.slice('mem:obs:'.length));
  // Existing eviction can leave session counts stale. Known successful deletions
  // explain that difference; unknown missing keys must still fail closed.
  if(session&&session.observationCount===rows.length)removed.delete(scope);
  else if(session&&session.observationCount!==rows.length+(removed.get(scope)?.size||0))throw fail('observation_index_not_ready_retry');
  return rows;
 }
 async function list(scope){
  const rows=new Map();
  // Internal callers need complete rows; stream the file rather than amplify it into one SDK request per row.
  for(let attempt=0;;attempt++){
   rows.clear();
   try{await readNamespaceEntries(join(storePath,encodeURIComponent(scope)+'.bin'),{onEntry:(key,value)=>{
    if(!value||typeof value!=='object'||Array.isArray(value))throw fail('invalid_observation_record');
    if(bytes(value)>15*1024*1024)throw fail('observation_exceeds_page_budget',413);
    rows.set(key,value);
   }});break;}catch(error){if(error.code==='ENOENT')break;if(error.code==='state_namespace_changed'&&attempt<1)continue;throw error;}
  }
  const overlay=pending.get(scope);
  for(const [key,value] of new Map(overlay??[])){
   const disk=rows.get(key);
   if((value===null&&!disk)||(disk&&isDeepStrictEqual(metadata(key,disk),value))){if(overlay.get(key)===value)overlay.delete(key);continue;}
   if(value?.bytes>15*1024*1024)throw fail('observation_exceeds_page_budget',413);
   const current=await kv.get(scope,key);
   if(current===null||current===undefined)rows.delete(key);else {
    if(typeof current!=='object'||Array.isArray(current))throw fail('invalid_observation_record');
    if(bytes(current)>15*1024*1024)throw fail('observation_exceeds_page_budget',413);
    rows.set(key,current);
   }
  }
  if(overlay&&!overlay.size)pending.delete(scope);
  return [...rows.values()];
 }
 async function response(scope,query,filterAgentId){
  if(Object.values(query).some(value=>typeof value!=="string"))throw fail("invalid_query",400);
  const limitText=query.limit;const explicit=limitText!==undefined||query.cursor!==undefined;
  if(limitText!==undefined&&(!/^\d+$/.test(limitText)||Number(limitText)<1||!Number.isSafeInteger(Number(limitText))))throw fail('invalid_limit',400);
  const position=cursorPosition(query.cursor);
  const listQuery=parseListQuery(query),minImportance=Number(query.minImportance);
  // Existing metadata count is authoritative; never silently omit unflushed keys.
  const all=await checkedSnapshot(scope);
  const rows=all.filter(o=>(!filterAgentId||o.agentId===filterAgentId)&&(!listQuery.type||o.type===listQuery.type)&&matchesText(listQuery.q,...o.searchFields)&&(!Number.isFinite(minImportance)||o.importance>=minImportance)).sort(compare);
  const stats=sessionStats(rows);
  if(query.stats==='true'){const body={observations:[],total:rows.length,stats};if(bytes(body)>PAGE_BYTES)throw fail('session_stats_exceeds_page_budget',413);return body;}
  let limit=limitText!==undefined?Math.min(Number(limitText),500):position?500:50;
  // Preserve complete small legacy responses, including sessions with >50 rows.
  if(!explicit&&rows.length<=500&&rows.reduce((n,o)=>n+o.bytes+1,0)<PAGE_BYTES-2048)limit=Math.max(1,rows.length);
  const start=position?rows.findIndex(o=>compare(o,position)>0):0;
  const remaining=start<0?[]:rows.slice(start);
  const selected=[];let size=2048;
  for(const o of remaining.slice(0,limit)){if(o.bytes+size>PAGE_BYTES){if(!selected.length)throw fail('observation_exceeds_page_budget',413);break;}selected.push({...o,scope});size+=o.bytes+1;}
  const observations=await read(selected);
  const hasMore=selected.length<remaining.length;
  const body={observations,total:rows.length,limit,nextCursor:hasMore?cursorFor(selected.at(-1)):null,hasMore};
  if(bytes(body)>PAGE_BYTES)throw fail('observation_changed_exceeds_page_budget',413);
  return body;
 }
 return {record,snapshot,list,response,revision,captureSummary,invalidateCaptureSummary};
}
