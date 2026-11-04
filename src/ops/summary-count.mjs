import {join} from 'node:path';
import {stat} from 'node:fs/promises';
import {readNamespaceEntries} from './namespace-reader.mjs';

export function createSummaryCount({storePath,kv}) {
  const pending=new Map(),views=new Map(),identities=new Map(),metadataViews=new Map(),pendingWireBytes=new Map();
  const path=join(storePath,encodeURIComponent('mem:summaries')+'.bin');
  let countCache=null,countLoading=null,wireCache=null;
  let keyBytes=0,unavailable=false,viewsUnavailable=false,idsUnavailable=false,viewBytes=0,idBytes=0;
  let metadataUnavailable=false,metadataBytes=0,version=0;
  const inputFields=['sessionId','createdAt','title','narrative','concepts'];
  const metadataFields=['sessionId','project','createdAt','title'];
  const fail=code=>Object.assign(Error(code),{code});
  const project=value=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(inputFields.filter(k=>Object.hasOwn(value,k)).map(k=>[k,value[k]])):value;
  const projectMetadata=value=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(metadataFields.filter(k=>Object.hasOwn(value,k)).map(k=>[k,value[k]])):value;
  const size=value=>{const text=JSON.stringify(value);if(text===undefined)throw fail('summary_projection_unknown');return Buffer.byteLength(text,'utf8');};
  const bulkRead=(work,options)=>typeof kv?.durability?.withBulkRead==='function'?kv.durability.withBulkRead(work,options):work();
  function invalidate(){version++;unavailable=true;countCache=null;}
  function prepare(value,{wire=true}={}){
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
    try{
      if(typeof value?.toJSON==='function')throw fail('summary_projection_unknown');
      const projected=projectMetadata(value),bytes=size(projected);
      if(bytes>8*1024*1024)throw fail('summary_projection_limit');
      result.metadata={value:JSON.parse(JSON.stringify(projected)),bytes};result.metadataValid=true;
    }catch{}
    if(wire)try{
      if(typeof value?.toJSON==='function')throw fail('summary_projection_unknown');
      result.wireBytes=size(value);
    }catch{}
    return result;
  }
  function record(key,present,snapshot,acknowledgedValue){
    version++;
    if(unavailable)return;
    if(!pending.has(key)){
      const size=Buffer.byteLength(key,'utf8');
      if(pending.size>=16384||keyBytes+size>4*1024*1024){invalidate();return;}
      keyBytes+=size;
    }
    pending.set(key,present);
    let wireBytes=snapshot?.wireBytes;
    if(present&&arguments.length>=4){try{wireBytes=size(acknowledgedValue);}catch{wireBytes=null;}}
    pendingWireBytes.set(key,present&&Number.isSafeInteger(wireBytes)?wireBytes:present?null:0);
    if(!idsUnavailable){
      try{
        if(present&&!snapshot?.idValid)throw fail('summary_projection_shape');
        const id=present?snapshot.id:{value:undefined,bytes:0},total=idBytes-(identities.get(key)?.bytes??0)+id.bytes;
        if(total>4*1024*1024)throw fail('summary_identity_limit');
        identities.set(key,id);idBytes=total;
      }catch{idsUnavailable=true;identities.clear();idBytes=0;}
    }
    if(!metadataUnavailable){
      try{
        if(present&&!snapshot?.metadataValid)throw fail('summary_projection_unknown');
        const view=present?snapshot.metadata:{value:null,bytes:0},total=metadataBytes-(metadataViews.get(key)?.bytes??0)+view.bytes;
        if(total>8*1024*1024)throw fail('summary_projection_limit');
        metadataViews.set(key,view);metadataBytes=total;
      }catch{metadataUnavailable=true;metadataViews.clear();metadataBytes=0;}
    }
    if(viewsUnavailable)return;
    try{
      if(present&&!snapshot?.viewValid)throw fail('summary_projection_unknown');
      const view=present?snapshot.view:{value:null,bytes:0},total=viewBytes-(views.get(key)?.bytes??0)+view.bytes;
      if(total>8*1024*1024)throw fail('summary_projection_limit');
      views.set(key,view);viewBytes=total;
    }catch{viewsUnavailable=true;views.clear();viewBytes=0;}
  }
  async function countFileRevision(){
    try{const s=await stat(path,{bigint:true});return[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');}
    catch(error){if(error.code==='ENOENT')return'absent';throw error;}
  }
  async function readCountKeys(){
    const keys=new Set();let bytes=0,signature='absent';
    try{
      const result=await readNamespaceEntries(path,{withReadChunk:bulkRead,onEntry:key=>{keys.add(key);bytes+=Buffer.byteLength(key,'utf8');}});
      signature=result.signature;
    }catch(error){if(error.code!=='ENOENT')throw error;}
    if(signature!==await countFileRevision())throw fail('state_namespace_changed');
    const result={keys,bytes,signature};
    if(!unavailable&&keys.size<=16384&&bytes<=4*1024*1024)countCache=result;
    return result;
  }
  async function countKeys(){
    for(let attempt=0;;attempt++){
      const revision=await countFileRevision();
      if(countCache?.signature===revision)return countCache.keys;
      countCache=null;
      if(!countLoading){
        const reading=readCountKeys();countLoading=reading;
        const clear=()=>{if(countLoading===reading)countLoading=null;};reading.then(clear,clear);
      }
      let result;
      try{result=await countLoading;}
      catch(error){if(error.code==='state_namespace_changed'&&attempt===0)continue;throw error;}
      if(result.signature!==await countFileRevision()){
        if(attempt===0)continue;throw fail('state_namespace_changed');
      }
      return result.keys;
    }
  }
  async function count(){
    if(unavailable)throw Error('summary_count_overlay_limit_or_unknown');
    const keys=new Set(await countKeys());
    if(unavailable)throw Error('summary_count_overlay_limit_or_unknown');
    for(const [key,present] of pending){
      if(present)keys.add(key);else keys.delete(key);
    }
    return keys.size;
  }
  async function scan(identityOnly=false,metadataOnly=false){
    if(unavailable||(identityOnly?idsUnavailable:metadataOnly?metadataUnavailable:viewsUnavailable))throw fail('summary_projection_unavailable');
    const rows=new Map();let bytes=0;
    const identity=value=>{if(value===null||value===undefined)throw fail('summary_projection_shape');return value.sessionId;};
    const insert=(key,value)=>{
      const projected=identityOnly?identity(value):metadataOnly?projectMetadata(value):project(value);
      const rowBytes=Buffer.byteLength(key,'utf8')+(projected===undefined?0:size(projected));
      const total=bytes-(rows.get(key)?.bytes??0)+rowBytes;
      if((!rows.has(key)&&rows.size>=16384)||total>8*1024*1024)throw fail('summary_projection_limit');
      rows.set(key,{value:projected,bytes:rowBytes});bytes=total;
    };
    for(let attempt=0;;attempt++){
      rows.clear();bytes=0;
      try{await readNamespaceEntries(join(storePath,encodeURIComponent('mem:summaries')+'.bin'),{withReadChunk:bulkRead,...metadataOnly?{maxEntryBytes:64*1024*1024}:{},onEntry:(key,value)=>{if(!pending.has(key))insert(key,value);else{if(rows.size>=16384)throw fail('summary_projection_limit');rows.set(key,{value:undefined,bytes:0});}}});break;}
      catch(error){if(error.code==='ENOENT')break;if(error.code==='state_namespace_changed'&&attempt===0)continue;throw error;}
    }
    if(unavailable||(identityOnly?idsUnavailable:metadataOnly?metadataUnavailable:viewsUnavailable))throw fail('summary_projection_unavailable');
    for(const [key,present]of pending){
      if(present){
        const source=identityOnly?identities:metadataOnly?metadataViews:views;if(!source.has(key))throw fail('summary_projection_unknown');
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
  // Only byte counts are retained, never completed summary bodies. Callers hold
  // the same namespace gate as summary mutations across this check and the RPC.
  async function sdkListBytes(maxBytes=Infinity){
    if(unavailable)throw fail('summary_projection_unavailable');
    if(maxBytes!==Infinity&&(!Number.isSafeInteger(maxBytes)||maxBytes<1))throw fail('summary_wire_limit_invalid');
    const before=version,signature=await countFileRevision();
    let sizes=wireCache?.signature===signature?new Map(wireCache.sizes):new Map(),keyBytes=0;
    let lowerBytes=0,lowerRows=0,partialKey=null,partialBytes=0;
    const check=bytes=>{if(bytes>maxBytes)throw Object.assign(fail('SUMMARY_COLLECTION_TOO_LARGE'),{bytes,limitBytes:maxBytes,status:413});};
    for(const [key,present]of pending)if(present){const bytes=pendingWireBytes.get(key);if(!Number.isSafeInteger(bytes))throw fail('summary_wire_size_unknown');lowerBytes+=bytes;lowerRows++;}
    check(2+lowerBytes+Math.max(0,lowerRows-1));
    if(wireCache?.signature!==signature){
      try{
        await readNamespaceEntries(path,{withReadChunk:bulkRead,measureValueBytes:true,maxEntryBytes:64*1024*1024,onValueBytes:(key,bytes)=>{
          if(pending.has(key))return;
          if(partialKey!==key){partialKey=key;partialBytes=0;lowerRows++;}
          lowerBytes+=bytes-partialBytes;partialBytes=bytes;
          check(2+lowerBytes+Math.max(0,lowerRows-1));
        },onEntry:(key,value,bytes)=>{
          keyBytes+=Buffer.byteLength(key,'utf8');
          if(sizes.size>=16384||keyBytes>4*1024*1024)throw fail('summary_projection_limit');
          sizes.set(key,bytes);
        }});
      }catch(error){if(error.code!=='ENOENT')throw error;}
      if(signature!==await countFileRevision())throw fail('state_namespace_changed');
      wireCache={signature,sizes:new Map(sizes)};
    }
    for(const [key,present] of pending){
      if(!present)sizes.delete(key);
      else{const bytes=pendingWireBytes.get(key);if(!Number.isSafeInteger(bytes))throw fail('summary_wire_size_unknown');sizes.set(key,bytes);}
    }
    if(before!==version||unavailable||signature!==await countFileRevision())throw fail('state_namespace_changed');
    const bytes=2+[...sizes.values()].reduce((sum,bytes)=>sum+bytes,0)+Math.max(0,sizes.size-1);check(bytes);return bytes;
  }
  async function metadata(){
    const before=version,signature=await countFileRevision(),rows=await scan(false,true),result=[];
    for(const [key,row] of rows){
      const value=row.value;
      if(!value||typeof value!=='object'||Array.isArray(value)||value.sessionId!==key)throw fail('summary_identity_invalid');
      result.push(value);
    }
    if(before!==version||signature!==await countFileRevision())throw fail('state_namespace_changed');
    return structuredClone(result);
  }
  async function recent(projectName,limit=5){
    if(typeof projectName!=='string'||!Number.isSafeInteger(limit)||limit<1||limit>20)throw fail('summary_selection_invalid');
    const before=version,signature=await countFileRevision(),rows=(await metadata()).filter(row=>row.project===projectName);
    const dates=new Map();
    for(const row of rows){
      const date=Date.parse(row.createdAt);if(!Number.isFinite(date))throw fail('summary_projection_date_invalid');
      const group=dates.get(date)??{count:0,pending:false};group.count++;group.pending||=pending.has(row.sessionId);dates.set(date,group);
    }
    const selected=rows.sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)).slice(0,limit),result=[];
    for(const row of selected){
      const group=dates.get(Date.parse(row.createdAt));if(group.count>1&&group.pending)throw fail('summary_projection_order_uncertain');
      const value=await kv.get('mem:summaries',row.sessionId);
      if(!value||value.sessionId!==row.sessionId||value.project!==row.project||value.createdAt!==row.createdAt)throw fail('state_namespace_changed');
      result.push(value);
    }
    if(before!==version||signature!==await countFileRevision())throw fail('state_namespace_changed');
    return result;
  }
  return {prepare,record,count,inputs,sessionIds,metadata,recent,sdkListBytes,invalidate};
}
