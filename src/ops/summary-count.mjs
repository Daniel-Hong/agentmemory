import {join} from 'node:path';
import {readNamespaceEntries} from './namespace-reader.mjs';

export function createSummaryCount({storePath,kv}) {
  const pending=new Map();
  let keyBytes=0,unavailable=false;
  const bulkRead=(work,options)=>typeof kv?.durability?.withBulkRead==='function'?kv.durability.withBulkRead(work,options):work();
  function invalidate(){unavailable=true;}
  function record(key,present){
    if(unavailable)return;
    if(!pending.has(key)){
      const size=Buffer.byteLength(key,'utf8');
      if(pending.size>=16384||keyBytes+size>4*1024*1024){invalidate();return;}
      keyBytes+=size;
    }
    pending.set(key,present);
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
  return {record,count,invalidate};
}
