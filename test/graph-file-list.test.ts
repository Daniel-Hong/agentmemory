import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateKV } from '../src/state/kv.js';
const dirs:string[]=[];
afterEach(async()=>{vi.unstubAllEnvs();await Promise.all(dirs.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function fixture(){const dir=await mkdtemp(join(tmpdir(),'am-graph-list-'));dirs.push(dir);vi.stubEnv('AGENTMEMORY_STATE_STORE_PATH',dir);return dir;}
it('reads oversized graph locally without an SDK list frame and overlays acknowledged writes/deletes',async()=>{
 const dir=await fixture(),scope='mem:graph:edges',file=join(dir,encodeURIComponent(scope)+'.bin');
 await writeFile(file,JSON.stringify({old:{id:'old',weight:0.1},removed:{id:'removed'}}));
 const sdk={trigger:vi.fn(async({function_id,payload}:any)=>{if(function_id==='state::list')throw Error('oversized SDK frame');if(function_id==='state::set')return payload.value;if(function_id==='state::delete')return {id:payload.key};})};
 const kv=new StateKV(sdk as never);
 expect(await kv.list(scope)).toEqual([{id:'old',weight:0.1},{id:'removed'}]);
 await kv.set(scope,'old',{id:'old',weight:0.9});await kv.set(scope,'new',{id:'new'});await kv.delete(scope,'removed');
 expect(await kv.list(scope)).toEqual([{id:'old',weight:0.9},{id:'new'}]);
 await writeFile(file,JSON.stringify({old:{id:'old',weight:0.9},new:{id:'new'}}));
 expect(await kv.list(scope)).toEqual([{id:'old',weight:0.9},{id:'new'}]);
 expect(sdk.trigger.mock.calls.some(([r])=>r.function_id==='state::list')).toBe(false);
});
it('keeps Redis graph listing on its native SDK',async()=>{await fixture();const sdk={trigger:vi.fn(async()=>[{id:'redis'}])};expect(await new StateKV(sdk as never,{backend:'redis'}).list('mem:graph:nodes')).toEqual([{id:'redis'}]);expect(sdk.trigger).toHaveBeenCalledWith({function_id:'state::list',payload:{scope:'mem:graph:nodes'}});});
it('refuses corrupt graph files rather than silently returning partial graph state',async()=>{const dir=await fixture();await writeFile(join(dir,encodeURIComponent('mem:graph:nodes')+'.bin'),'{"x":bad}');const kv=new StateKV({trigger:async()=>[]} as never);await expect(kv.list('mem:graph:nodes')).rejects.toThrow(/state_namespace/);});
it('blocks potentially stale file reads after an SDK mutation failure',async()=>{const dir=await fixture();await writeFile(join(dir,encodeURIComponent('mem:graph:nodes')+'.bin'),'{"old":{"id":"old"}}');const kv=new StateKV({trigger:async()=>{throw Error('uncertain write');}} as never);await expect(kv.set('mem:graph:nodes','new',{id:'new'})).rejects.toThrow('uncertain write');await expect(kv.list('mem:graph:nodes')).rejects.toThrow('graph_mutation_uncertain');});
