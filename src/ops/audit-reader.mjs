import {stat} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {readNamespaceEntries} from './namespace-reader.mjs';
export const AUDIT_PAGE_BYTES=4*1024*1024;
const fail=(code,status=503)=>Object.assign(Error(code),{code,status});
const bytes=value=>Buffer.byteLength(JSON.stringify(value),'utf8');
export function projectAuditMetadata(value){
 return {id:String(value.id??''),timestamp:String(value.timestamp??''),operation:value.operation,functionId:String(value.functionId||''),targetIds:Array.isArray(value.targetIds)?value.targetIds.slice(0,10).map(v=>String(v||'').slice(0,300)):[],targetCount:Array.isArray(value.targetIds)?value.targetIds.length:0};
}
function metadata(key,value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw fail('invalid_audit_record');
 return {key,id:typeof value.id==='string'?value.id:key,timestamp:typeof value.timestamp==='string'?value.timestamp:'',operation:value.operation,functionId:String(value.functionId||''),targetIds:Array.isArray(value.targetIds)?value.targetIds.map(v=>String(v||'')):[],targetCount:Array.isArray(value.targetIds)?value.targetIds.length:0,bytes:bytes(value)};
}
export function createAuditReader({storePath,kv}){
 if(!isAbsolute(storePath))throw fail('absolute_state_store_path_required');
 const states=new Map();
 function state(scope){if(!states.has(scope))states.set(scope,{pending:new Map(),cache:{signature:null,rows:new Map()},loading:null});return states.get(scope);}
 function record(scope,key,value){if((scope==='mem:audit'||/^mem:audit:\d{4}-\d{2}$/.test(scope))&&value!==undefined)state(scope).pending.set(key,value===null?null:metadata(key,value));}
 async function snapshot(scope){
  const current=state(scope),{pending}=current,path=join(storePath,encodeURIComponent(scope)+'.bin');
  if(current.loading)return current.loading;
  current.loading=(async()=>{
   let cache=current.cache;
   let signature='absent';try{const s=await stat(path);signature=[s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');}catch(e){if(e.code!=='ENOENT')throw e;}
   if(cache.signature!==signature){
    const rows=new Map();
    if(signature!=='absent')await readNamespaceEntries(path,{onEntry:(key,value)=>{rows.set(key,metadata(key,value));}});
    cache={signature,rows};current.cache=cache;
   }
   const rows=new Map(cache.rows);
   for(const [key,value] of pending){
    if(value===null){if(!rows.has(key))pending.delete(key);rows.delete(key);}
    else {if(isDeepStrictEqual(rows.get(key),value))pending.delete(key);rows.set(key,value);}
   }
   return rows;
  })();try{return await current.loading;}finally{current.loading=null;}
 }
 async function query(filter={}, {scopes=['mem:audit']}={}){
  const limit=filter.limit===undefined?100:filter.limit;
  if(!Number.isSafeInteger(limit)||limit<1||limit>500)throw fail('invalid_audit_limit',400);
  const from=filter.dateFrom?Date.parse(filter.dateFrom):-Infinity,to=filter.dateTo?Date.parse(filter.dateTo):Infinity;
  if(Number.isNaN(from)||Number.isNaN(to))throw fail('invalid_audit_date',400);
  const needle=filter.query?.trim().toLowerCase(),seen=new Set(),all=[];
  for(const scope of scopes)for(const row of (await snapshot(scope)).values()){if(seen.has(row.id))continue;seen.add(row.id);all.push({...row,scope});}
  const rows=all.filter(m=>(!filter.operation||m.operation===filter.operation)&&(!filter.dateFrom||Date.parse(m.timestamp)>=from)&&(!filter.dateTo||Date.parse(m.timestamp)<=to)&&(!needle||[m.functionId,...m.targetIds].some(v=>v.toLowerCase().includes(needle)))).sort((a,b)=>Date.parse(b.timestamp)-Date.parse(a.timestamp)||b.key.localeCompare(a.key)).slice(0,limit);
  if(filter.metadata===true){const result=rows.map(projectAuditMetadata);if(bytes(result)>AUDIT_PAGE_BYTES)throw fail('audit_page_exceeds_budget',413);return result;}
  if(rows.reduce((n,m)=>n+m.bytes+1,2)>AUDIT_PAGE_BYTES)throw fail('audit_page_exceeds_budget',413);
  const result=[];for(let i=0;i<rows.length;i+=8)result.push(...await Promise.all(rows.slice(i,i+8).map(m=>kv.get(m.scope,m.key))));
  if(result.some(value=>!value))throw fail('audit_changed_retry');
  if(bytes(result)>AUDIT_PAGE_BYTES)throw fail('audit_page_exceeds_budget',413);return result;
 }
 return {record,query};
}
