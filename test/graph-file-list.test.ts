import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateKV } from '../src/state/kv.js';
import { createGraphFileList } from '../src/ops/graph-file-list.mjs';
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
it('keeps Redis graph listing on its native SDK',async()=>{await fixture();const sdk={trigger:vi.fn(async({function_id}:any)=>function_id==='state::get'?null:[{id:'redis'}])};expect(await new StateKV(sdk as never,{backend:'redis'}).list('mem:graph:nodes')).toEqual([{id:'redis'}]);expect(sdk.trigger).toHaveBeenCalledWith({function_id:'state::list',payload:{scope:'mem:graph:nodes'}});});
it('refuses corrupt graph files rather than silently returning partial graph state',async()=>{const dir=await fixture();await writeFile(join(dir,encodeURIComponent('mem:graph:nodes')+'.bin'),'{"x":bad}');const kv=new StateKV({trigger:async()=>null} as never);await expect(kv.list('mem:graph:nodes')).rejects.toThrow(/state_namespace/);});
it('blocks potentially stale file reads after an SDK mutation failure',async()=>{const dir=await fixture();await writeFile(join(dir,encodeURIComponent('mem:graph:nodes')+'.bin'),'{"old":{"id":"old"}}');const kv=new StateKV({trigger:async({function_id}:any)=>{if(function_id==='state::get')return null;throw Error('uncertain write');}} as never);await expect(kv.set('mem:graph:nodes','new',{id:'new'})).rejects.toThrow('uncertain write');await expect(kv.list('mem:graph:nodes')).rejects.toThrow('graph_mutation_uncertain');});

it.each(['nodes', 'edges'])('keeps generation %s reads local and applies overlays and invalidation to that generation', async kind => {
 const dir = await fixture(), generation = '12345678-abcd-1234-abcd-123456789abc';
 const logical = `mem:graph:${kind}`, scope = `${logical}:generation:${generation}`;
 await writeFile(join(dir, encodeURIComponent(logical) + '.bin'), JSON.stringify({legacy: {id: 'legacy'}}));
 await writeFile(join(dir, encodeURIComponent(scope) + '.bin'), JSON.stringify({old: {id: 'old'}, removed: {id: 'removed'}}));
 const sdk = {trigger: vi.fn(async ({function_id, payload}: any) => {
  if (function_id === 'state::get') return payload.scope === 'mem:graph:control' && payload.key === 'generation' ? generation : null;
  throw Error('graph listing must not request an SDK frame');
 })};
 const kv = new StateKV(sdk as never), reader = kv.graphFileList!;
 expect(await kv.list(logical)).toEqual([{id: 'old'}, {id: 'removed'}]);
 reader.record(scope, 'old', {id: 'updated'});
 reader.record(scope, 'removed', null);
 reader.record(scope, 'new', {id: 'new'});
 reader.record(logical, 'legacy-new', {id: 'legacy-new'});
 expect(await kv.list(logical)).toEqual([{id: 'updated'}, {id: 'new'}]);
 reader.invalidate(scope);
 await expect(kv.list(logical)).rejects.toThrow('graph_mutation_uncertain');
 expect(await reader.list(logical)).toEqual([{id: 'legacy'}, {id: 'legacy-new'}]);
 expect(sdk.trigger.mock.calls.some(([request]) => request.function_id === 'state::list')).toBe(false);
});
it.each([
 'mem:graph:nodes:generation:',
 'mem:graph:edges:generation:12345678-abcd-1234-abcd-123456789ab',
 'mem:graph:nodes:generation:12345678-ABCD-1234-abcd-123456789abc',
 'mem:graph:edges:generation:12345678-abcd-1234-abcd-123456789abc:extra',
 'mem:graph:snapshot:generation:12345678-abcd-1234-abcd-123456789abc',
 'mem:graph:nodes:other:12345678-abcd-1234-abcd-123456789abc',
])('rejects malformed or unsupported graph scope %s', async scope => {
 const reader = createGraphFileList({storePath: await fixture()});
 expect(reader.accepts(scope)).toBe(false);
 reader.record(scope, 'ignored', {id: 'ignored'});
 reader.invalidate(scope);
 await expect(reader.list(scope)).rejects.toThrow('invalid_graph_scope');
 expect(await reader.list('mem:graph:nodes')).toEqual([]);
});
