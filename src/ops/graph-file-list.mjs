import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {readNamespaceEntries} from './namespace-reader.mjs';

export function createGraphFileList({storePath}) {
  const pending=new Map(),uncertain=new Set();
  const accepts=scope=>scope==='mem:graph:nodes'||scope==='mem:graph:edges';
  function record(scope,key,value) {
    if(!accepts(scope)||value===undefined)return;
    if(!pending.has(scope))pending.set(scope,new Map());
    pending.get(scope).set(key,structuredClone(value));
  }
  function invalidate(scope){if(accepts(scope))uncertain.add(scope);}
  async function list(scope) {
    if(!accepts(scope))throw Error('invalid_graph_scope');
    if(uncertain.has(scope))throw Error('graph_mutation_uncertain');
    const rows=new Map();
    // shortcut: one full local scan per call; replace with native graph queries when iii provides them.
    for(let attempt=0;;attempt++) {
      rows.clear();
      try {await readNamespaceEntries(join(storePath,encodeURIComponent(scope)+'.bin'),{onEntry:(key,value)=>rows.set(key,value)});break;}
      catch(error){if(error.code==='ENOENT')break;if(error.code==='state_namespace_changed'&&attempt<1)continue;throw error;}
    }
    if(uncertain.has(scope))throw Error('graph_mutation_uncertain');
    const overlay=pending.get(scope);
    for(const [key,value] of overlay||[]) {
      if(value===null){if(!rows.has(key))overlay.delete(key);rows.delete(key);}
      else {if(isDeepStrictEqual(rows.get(key),value))overlay.delete(key);rows.set(key,value);}
    }
    if(overlay&&!overlay.size)pending.delete(scope);
    return [...rows.values()];
  }
  return {accepts,record,invalidate,list};
}
