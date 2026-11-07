import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {readNamespaceEntries} from './namespace-reader.mjs';

export function createGraphFileList({storePath}) {
  const pending=new Map(),uncertain=new Set();
  // Capture originals and review history can exceed one SDK frame.
  const captureScope=scope=>scope==='mem:capture:inbox'||scope==='mem:capture:review';
  const accepts=scope=>captureScope(scope)||/^mem:graph:(?:nodes|edges)(?::generation:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/.test(scope);
  function record(scope,key,value) {
    if(!accepts(scope)||value===undefined)return;
    if(!pending.has(scope))pending.set(scope,new Map());
    pending.get(scope).set(key,structuredClone(value));
  }
  function invalidate(scope){if(accepts(scope))uncertain.add(scope);}
  async function list(scope,{project}={}) {
    if(!accepts(scope))throw Error('invalid_graph_scope');
    if(uncertain.has(scope))throw Error('graph_mutation_uncertain');
    const rows=new Map(),matched=new Map();
    // Projection discards each disk row's payload before retaining the result.
    // Pending SDK acknowledgements retain full values until a matching disk checkpoint.
    for(let attempt=0;;attempt++) {
      rows.clear();matched.clear();
      try {
        await readNamespaceEntries(join(storePath,encodeURIComponent(scope)+'.bin'),{onEntry:(key,value)=>{
          const acknowledged=pending.get(scope)?.get(key);
          if(acknowledged!==undefined&&isDeepStrictEqual(value,acknowledged))matched.set(key,acknowledged);
          rows.set(key,project?project(value,key):value);
        }});
        break;
      }
      catch(error){if(error.code==='ENOENT')break;if(error.code==='state_namespace_changed'&&attempt<1)continue;throw error;}
    }
    if(uncertain.has(scope))throw Error('graph_mutation_uncertain');
    const overlay=pending.get(scope);
    for(const [key,value] of overlay||[]) {
      // Absence cannot identify the deletion's checkpoint generation. Capture
      // tombstones stay until a newer acknowledgement for that key or restart.
      if(value===null){if(!captureScope(scope)&&!rows.has(key))overlay.delete(key);rows.delete(key);}
      else {
        if(matched.get(key)===value)overlay.delete(key);
        rows.set(key,project?project(structuredClone(value),key):captureScope(scope)?structuredClone(value):value);
      }
    }
    if(overlay&&!overlay.size)pending.delete(scope);
    return [...rows.values()];
  }
  return {accepts,record,invalidate,list};
}
