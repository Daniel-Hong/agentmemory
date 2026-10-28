import{afterEach,expect,it,vi}from'vitest';
import{mkdtemp,writeFile,rename,rm}from'node:fs/promises';import{join}from'node:path';import{tmpdir}from'node:os';
const publication=vi.hoisted(()=>({enabled:false,reads:0}));
vi.mock('../src/ops/namespace-reader.mjs',async original=>{
 const m=await original<any>();return{...m,readNamespaceEntries:async(path:string,options:any)=>{
  if(!publication.enabled||!options.onEntry)return m.readNamespaceEntries(path,options);
  publication.reads++;let replaced=false;
  return m.readNamespaceEntries(path,{...options,onEntry:async(k:string,v:unknown)=>{await options.onEntry(k,v);if(!replaced){replaced=true;await writeFile(path+'.next',JSON.stringify({published:{id:'published',title:'later generation'}}));await rename(path+'.next',path);}}});
 }};
});
import{StateKV}from'../src/state/kv.js';
const dirs:string[]=[];afterEach(async()=>{publication.enabled=false;publication.reads=0;vi.unstubAllEnvs();await Promise.all(dirs.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function fixture(){const dir=await mkdtemp(join(tmpdir(),'am-snapshot-kv-'));dirs.push(dir);vi.stubEnv('AGENTMEMORY_STATE_STORE_PATH',dir);const scope='mem:obs:synthetic';const disk={a:{id:'a',title:'old'},b:{id:'b',title:'original'}};const file=join(dir,encodeURIComponent(scope)+'.bin');await writeFile(file,JSON.stringify(disk));const current=new Map<string,unknown>(Object.entries(disk));const sdk={trigger:vi.fn(async({function_id,payload}:any)=>{if(function_id==='state::get')return current.get(payload.key)??null;throw Error('unexpected synthetic RPC');})};const kv=new StateKV(sdk as never);return{dir,file,scope,disk,current,kv,sdk};}
it('snapshot observation read finishes the opened generation when each read races with atomic publication',async()=>{const f=await fixture();publication.enabled=true;expect(await f.kv.list(f.scope,{observationConsistency:'opened-generation'})).toEqual(Object.values(f.disk));expect(publication.reads).toBe(1);expect(f.sdk.trigger).not.toHaveBeenCalled();});
it('ordinary observation lists still refuse repeated publication after the existing one retry',async()=>{const f=await fixture();publication.enabled=true;await expect(f.kv.list(f.scope)).rejects.toMatchObject({code:'state_namespace_changed'});expect(publication.reads).toBe(2);});
it('snapshot generation preserves changed/new/deleted pending SDK overlay without restoring deleted records',async()=>{const f=await fixture();const changed={id:'a',title:'updated source'},added={id:'c',title:'new source'};f.current.set('a',changed);f.current.delete('b');f.current.set('c',added);f.kv.observationReader!.record(f.scope,'a',changed);f.kv.observationReader!.record(f.scope,'b',null,true);f.kv.observationReader!.record(f.scope,'c',added);publication.enabled=true;const rows=await f.kv.list(f.scope,{observationConsistency:'opened-generation'});expect(rows).toEqual([changed,added]);expect(publication.reads).toBe(1);});
