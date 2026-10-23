import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { transpileModule, ScriptTarget, ModuleKind } from 'typescript';
import { createShutdownIngress } from '../src/ops/shutdown-ingress.mjs';
import { createBackgroundLifecycle } from '../src/ops/background-lifecycle.mjs';
import { verifiedShutdown } from '../src/ops/verified-shutdown.js';
import { settleWithin, SHUTDOWN_FLUSH_TIMEOUT_MS } from '../src/shutdown.js';
import { mockSdk } from './helpers/mocks.js';
const dirs:string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});
function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
async function fixture({configured=true,indexFailed=false,bootFailed=false,writerSafe=false,mutationUncertain=false,sdkFails=false}={}) {
 const dir=await mkdtemp(join(tmpdir(),'am-worker-stop-'));dirs.push(dir);
 const events:string[]=[];const sdk={...mockSdk(),shutdown:async()=>{events.push('sdk');if(sdkFails)throw Error('fixture disconnect failure');}};
 const kv={recoveryMutationSafe:writerSafe,mutationOutcomeUncertain:mutationUncertain,durability:configured?{drain:async()=>{events.push('drain');},freeze:()=>{events.push('freeze');},wait:async()=>{events.push('disk');return {synced:true,mutationFailures:0};}}:null};
 const source=readFileSync('src/index.ts','utf8');
 const start=source.indexOf('  const ingress = createShutdownIngress();');
 const end=source.indexOf('  try {\n  if (persistentBackground)',start);
 const body=source.slice(start,end);
 const deps={writerLease:writerSafe?{}:undefined,markFileWriterClean:()=>events.push('writer-clean'),createBackgroundControl:()=>({settled:async()=>{},commitCleanShutdown:async()=>{events.push("restart-guard");}}),installBackgroundControl:()=>{},operationalState:{},createShutdownIngress,createBackgroundLifecycle,verifiedShutdown,closeLongSessionInferenceAdmission:()=>events.push('close-model'),checkAuth:()=>null,kv,sdk,secret:'fixture-secret',dirname,runtimeMetadataPath:(name:string)=>join(dir,name),readFileSync,settleWithin,SHUTDOWN_FLUSH_TIMEOUT_MS,
 clearWorkerPidfile:()=>events.push('clear-pid'),process:{on:vi.fn(),kill:()=>{},exit:(code:number)=>{events.push('exit:'+code);throw Error('exit:'+code);}}};
 const js=transpileModule(body,{compilerOptions:{target:ScriptTarget.ES2022,module:ModuleKind.ES2022}}).outputText;
 const load=new Function('deps',`const {${Object.keys(deps).join(',')}}=deps;let fatalShutdown;${js};return {shutdown,bootDone,resources,lifecycle,trackBoot,failBoot:()=>{bootFailed=true;}};`);
 const runtime=load(deps);
 runtime.resources.index={stop:()=>events.push('stop-index'),save:async()=>events.push('save-index'),status:()=>({pendingChanges:0,vector:{lastError:indexFailed?'disk failed':null}})};
 runtime.resources.capture={stop:()=>events.push('stop-capture')};
 if(bootFailed)runtime.failBoot();
 return {...runtime,dir,events,sdk};
}
it('waits for initialization and admitted work before freeze and clears PID only on verified storage',async()=>{
 const f=await fixture(),boot=gate();let drained=false;
 f.trackBoot(boot.promise.then(()=>{drained=true;}));
 const stopping=f.shutdown();expect(f.shutdown()).toBe(stopping);
 await Promise.resolve();expect(f.events).not.toContain('freeze');
 f.bootDone();await Promise.resolve();expect(f.events).not.toContain('freeze');
 boot.release();await expect(stopping).rejects.toThrow('exit:0');
 expect(drained).toBe(true);
 expect(f.events).toEqual(['close-model','stop-capture','stop-index','close-model','save-index','drain','disk','restart-guard','freeze','disk','sdk','clear-pid','exit:0']);
 expect(JSON.parse(await readFile(join(f.dir,'shutdown-receipt.json'),'utf8'))).toMatchObject({verified:true});
});
it.each([{configured:false,indexFailed:false,code:'STATE_DURABILITY_UNCONFIGURED'},{configured:true,indexFailed:true,code:'INDEX_SAVE_UNVERIFIED'}])('keeps PID and refuses success for $code',async({configured,indexFailed,code})=>{
 const f=await fixture({configured,indexFailed});f.bootDone();
 await expect(f.shutdown()).rejects.toThrow('exit:1');expect(f.events).not.toContain('clear-pid');expect(f.events).not.toContain('freeze');
 expect(JSON.parse(await readFile(join(f.dir,'shutdown-receipt.json'),'utf8'))).toMatchObject({verified:false,errorCode:code});
});
it('cannot report a successful worker exit after initialization failed',async()=>{
 const f=await fixture({bootFailed:true});f.bootDone();await expect(f.shutdown()).rejects.toThrow('exit:1');
});

it.each([{mutationUncertain:false,sdkFails:false,clean:true},{mutationUncertain:true,sdkFails:false,clean:false},{mutationUncertain:false,sdkFails:true,clean:false}])('preserves clean writer admission only after verified settled writes and disconnect: $clean',async(args)=>{
 const f=await fixture({writerSafe:true,...args});f.bootDone();await expect(f.shutdown()).rejects.toThrow('exit:0');expect(f.events.includes('writer-clean')).toBe(args.clean);if(args.clean)expect(f.events.indexOf('writer-clean')).toBeGreaterThan(f.events.indexOf('sdk'));
});
