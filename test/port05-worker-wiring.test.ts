import {it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {transpileModule,ScriptTarget,ModuleKind} from 'typescript';
import {createBackgroundLifecycle} from '../src/ops/background-lifecycle.mjs';
import {KV} from '../src/state/schema.js';
const source=readFileSync('src/index.ts','utf8');
function fixture({embedding='openai',embeddingUrl='http://fixture.invalid/v1',chatUrl='http://fixture.invalid/v1',shuttingDown=false}={}){
 const start=source.indexOf('  if (vectorIndex && embeddingProvider) {');expect(start).toBeGreaterThan(0);
 const end=source.indexOf('  const auditMigration',start);expect(end).toBeGreaterThan(start);
 const code=transpileModule(source.slice(start,end),{compilerOptions:{target:ScriptTarget.ES2022,module:ModuleKind.ES2022}}).outputText;
 const readiness={},operationalState:any={providerReadiness:readiness};
 const worker={start:vi.fn(),stop:vi.fn(),drain:vi.fn()};
 const registerEmbeddingRecovery=vi.fn(()=>worker),setEmbeddingRecovery=vi.fn();
 const lifecycle=createBackgroundLifecycle(()=>{}),indexPersistence={saveVerified:vi.fn(async()=>{})};
 const deps={operationalState,lifecycle,indexPersistence,registerEmbeddingRecovery,setEmbeddingRecovery,KV,kv:{},logger:{},withKeyedLock:vi.fn(),embeddingProvider:embedding?{name:embedding}:null,vectorIndex:embedding?{}:null,config:{provider:{baseURL:chatUrl}},getEnvVar:(key:string)=>key==='OPENAI_EMBEDDING_BASE_URL'?embeddingUrl:undefined};
 new Function('deps',`const {${Object.keys(deps).join(',')}}=deps;${code}`)(deps);
 const arm=source.split('\n').find(line=>line.includes('if (!shuttingDown) operationalState.embeddingRecovery?.start()'));expect(arm).toBeTruthy();
 new Function('operationalState','shuttingDown',arm!)(operationalState,shuttingDown);
 return {...deps,readiness,worker};
}
it('installs only after index replay, starts at boot completion and drains before final flush',async()=>{
 const f=fixture();expect(source.indexOf('replayPendingLog')).toBeLessThan(source.indexOf('  if (vectorIndex && embeddingProvider) {'));
 expect(f.registerEmbeddingRecovery).toHaveBeenCalledWith(expect.objectContaining({schedule:false,readiness:f.readiness}));
 const options=f.registerEmbeddingRecovery.mock.calls[0][0] as any;const publication={id:'fixture',entry:null};await options.persistIndex(publication);expect(f.indexPersistence.saveVerified).toHaveBeenCalledWith(publication);
 expect(f.setEmbeddingRecovery).toHaveBeenCalledWith(f.worker);expect(f.worker.start).toHaveBeenCalledOnce();
 await f.lifecycle.shutdown(async()=>{expect(f.worker.stop).toHaveBeenCalledOnce();expect(f.worker.drain).toHaveBeenCalled();});
});
it.each([{embedding:'local'},{embeddingUrl:'http://other.invalid/v1'}])('does not gate an independent embedding provider on chat readiness %j',options=>{const f=fixture(options);expect(f.registerEmbeddingRecovery).toHaveBeenCalledWith(expect.objectContaining({readiness:undefined}));});
it('does not arm a new worker during shutdown',()=>{const f=fixture({shuttingDown:true});expect(f.worker.start).not.toHaveBeenCalled();});
it('keeps BM25-only boot without a recovery worker',()=>{const f=fixture({embedding:''});expect(f.registerEmbeddingRecovery).not.toHaveBeenCalled();expect(f.setEmbeddingRecovery).toHaveBeenCalledWith(null);});
