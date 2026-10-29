import {join} from 'node:path';
import {readNamespaceEntries} from './namespace-reader.mjs';

export function createSummaryCount({storePath,kv}) {
  const pending=new Map(),views=new Map(),identities=new Map();
  let keyBytes=0,unavailable=false,viewsUnavailable=false,idsUnavailable=false,viewBytes=0,idBytes=0;
  const inputFields=['sessionId','createdAt','title','narrative','concepts'];
  const fail=code=>Object.assign(Error(code),{code});
  const project=value=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(inputFields.filter(k=>Object.hasOwn(value,k)).map(k=>[k,value[k]])):value;
  const size=value=>{const text=JSON.stringify(value);if(text===undefined)throw fail('summary_projection_unknown');return Buffer.byteLength(text,'utf8');};
  const bulkRead=(work,options)=>typeof kv?.durability?.withBulkRead==='function'?kv.durability.withBulkRead(work,options):work();
  function invalidate(){unavailable=true;}
  function prepare(value){
    const result={idValid:false,viewValid:false};
    try{
      if(value==null||typeof value.toJSON==='function')throw fail('summary_projection_shape');
      const id=value.sessionId,bytes=id===undefined?0:size(id);
      if(bytes>4*1024*1024)throw fail('summary_identity_limit');
      result.id={value:id===undefined?undefined:JSON.parse(JSON.stringify(id)),bytes};result.idValid=true;
    }catch{}
    try{
      if(typeof value?.toJSON==='function')throw fail('summary_projection_unknown');
      const projected=project(value),bytes=size(projected);
      if(bytes>8*1024*1024)throw fail('summary_projection_limit');
      result.view={value:JSON.parse(JSON.stringify(projected)),bytes};result.viewValid=true;
    }catch{}
    return result;
  }
  function record(key,present,snapshot){
    if(unavailable)return;
    if(!pending.has(key)){
      const size=Buffer.byteLength(key,'utf8');
      if(pending.size>=16384||keyBytes+size>4*1024*1024){invalidate();return;}
      keyBytes+=size;
    }
    pending.set(key,present);
    if(!idsUnavailable){
      try{
        if(present&&!snapshot?.idValid)throw fail('summary_projection_shape');
        const id=present?snapshot.id:{value:undefined,bytes:0},total=idBytes-(identities.get(key)?.bytes??0)+id.bytes;
        if(total>4*1024*1024)throw fail('summary_identity_limit');
        identities.set(key,id);idBytes=total;
      }catch{idsUnavailable=true;identities.clear();idBytes=0;}
    }
    if(viewsUnavailable)return;
    try{
      if(present&&!snapshot?.viewValid)throw fail('summary_projection_unknown');
      const view=present?snapshot.view:{value:null,bytes:0},total=viewBytes-(views.get(key)?.bytes??0)+view.bytes;
      if(total>8*1024*1024)throw fail('summary_projection_limit');
      views.set(key,view);viewBytes=total;
    }catch{viewsUnavailable=true;views.clear();viewBytes=0;}
  }
  async function count(){
    if(unavailable)throw Error('summary_count_overlay_limit_or_unknown');
    const keys=new Set();
    for(let attempt=0;;attempt++){
      keys.clear();
      try{await readNamespaceEntries(join(storePath,encodeURIComponent('mem:summaries')+'.bin'),{withReadChunk:bulkRead,onEntry:key=>{keys.add(key);}});break;}
      catch(error){if(error.code==='ENOENT')break;if(error.code==='state_namespace_changed'&&attempt===0)continue;throw error;}
    }
    if(unavailable)throw Error('summary_count_overlay_limit_or_unknown');
    for(const [key,present] of pending){
      if(present)keys.add(key);else keys.delete(key);
    }
    return keys.size;
  }
  async function scan(identityOnly=false){
    if(unavailable||(identityOnly?idsUnavailable:viewsUnavailable))throw fail('summary_projection_unavailable');
    const rows=new Map();let bytes=0;
    const identity=value=>{if(value===null||value===undefined)throw fail('summary_projection_shape');return value.sessionId;};
    const insert=(key,value)=>{
      const projected=identityOnly?identity(value):project(value);
      const rowBytes=Buffer.byteLength(key,'utf8')+(projected===undefined?0:size(projected));
      const total=bytes-(rows.get(key)?.bytes??0)+rowBytes;
      if((!rows.has(key)&&rows.size>=16384)||total>8*1024*1024)throw fail('summary_projection_limit');
      rows.set(key,{value:projected,bytes:rowBytes});bytes=total;
    };
    for(let attempt=0;;attempt++){
      rows.clear();bytes=0;
      try{await readNamespaceEntries(join(storePath,encodeURIComponent('mem:summaries')+'.bin'),{withReadChunk:bulkRead,onEntry:(key,value)=>{if(!pending.has(key))insert(key,value);else{if(rows.size>=16384)throw fail('summary_projection_limit');rows.set(key,{value:undefined,bytes:0});}}});break;}
      catch(error){if(error.code==='ENOENT')break;if(error.code==='state_namespace_changed'&&attempt===0)continue;throw error;}
    }
    if(unavailable||(identityOnly?idsUnavailable:viewsUnavailable))throw fail('summary_projection_unavailable');
    for(const [key,present]of pending){
      if(present){
        const source=identityOnly?identities:views;if(!source.has(key))throw fail('summary_projection_unknown');
        insert(key,identityOnly?{sessionId:source.get(key).value}:source.get(key).value);
      }
      else{bytes-=rows.get(key)?.bytes??0;rows.delete(key);}
    }
    return rows;
  }
  async function inputs(){
    const rows=await scan();
    const dates=new Map();
    const values=[...rows].map(([key,row],order)=>{
      const value=row.value,date=Date.parse(value?.createdAt);
      if(!Number.isFinite(date))throw fail('summary_projection_date_invalid');
      const group=dates.get(date)??{count:0,pending:false};group.count++;group.pending||=pending.has(key);dates.set(date,group);
      return {key,value,date,order};
    }).sort((a,b)=>b.date-a.date||a.order-b.order).slice(0,20);
    for(const row of values){const group=dates.get(row.date);if(group.count>1&&group.pending)throw fail('summary_projection_order_uncertain');}
    const recent=values.map(row=>row.value);
    if(size(recent)>4*1024*1024)throw fail('summary_input_limit');
    return {total:rows.size,recent:structuredClone(recent)};
  }
  async function sessionIds(){return new Set(structuredClone([...(await scan(true)).values()].map(row=>row.value)));}
  return {prepare,record,count,inputs,sessionIds,invalidate};
}
