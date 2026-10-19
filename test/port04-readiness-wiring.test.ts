import {expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {transpileModule,ScriptTarget,ModuleKind} from 'typescript';
import {createBackgroundLifecycle} from '../src/ops/background-lifecycle.mjs';
const source=readFileSync('src/index.ts','utf8');
function fixture({native='true',fallback=false,baseURL='http://fixture.invalid/v1'}={}){
 const begin=source.indexOf('  const metricsStore = new MetricsStore(kv);') + '  const metricsStore = new MetricsStore(kv);'.length;
 expect(begin).toBeGreaterThan(0);
 const body=source.slice(begin,source.indexOf('  const dedupMap',begin));
 const js=transpileModule(body,{compilerOptions:{target:ScriptTarget.ES2022,module:ModuleKind.ES2022}}).outputText;
 const readiness={start:vi.fn(),stop:vi.fn(),drain:vi.fn()},createOllamaReadiness=vi.fn(()=>readiness);
 const provider={},operationalState={},lifecycle=createBackgroundLifecycle(()=>{});
 const deps={config:{provider:{provider:'openai',model:'fixture',baseURL}},fallbackConfig:{providers:fallback?['other']:[]},getEnvVar:(key:string)=>key==='AGENTMEMORY_OLLAMA_NATIVE_CHAT'?native:undefined,lifecycle,operationalState,provider,createOllamaReadiness};
 new Function('deps',`const {${Object.keys(deps).join(',')}}=deps;${js}`)(deps);
 return {readiness,createOllamaReadiness,provider,operationalState,lifecycle};
}
it('wires one watcher to provider and lifecycle; shutdown stops and drains it',async()=>{
 const f=fixture();expect(f.createOllamaReadiness).toHaveBeenCalledWith({baseUrl:'http://fixture.invalid/v1',models:['fixture']});expect(f.provider).toHaveProperty('readiness',f.readiness);expect(f.operationalState).toHaveProperty('providerReadiness',f.readiness);expect(f.readiness.start).toHaveBeenCalledOnce();await f.lifecycle.shutdown(async()=>{});expect(f.readiness.stop).toHaveBeenCalledOnce();expect(f.readiness.drain).toHaveBeenCalled();
});
it.each([{native:'false'},{native:'false',fallback:true}])('does not attach a primary-only gate to %j',options=>{const f=fixture(options);expect(f.createOllamaReadiness).not.toHaveBeenCalled();});

it('rejects unconfigured native base URL before metadata probing',()=>{expect(()=>fixture({baseURL:''})).toThrow('ollama_native_base_url_required');});

it('rejects native plus fallback rather than changing fallback protocols',()=>{expect(()=>fixture({fallback:true})).toThrow('ollama_native_fallback_unsupported');});
