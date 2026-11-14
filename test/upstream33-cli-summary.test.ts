import {afterEach, expect, it, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {getSummaryTimeoutMs,getSummaryTriggerTimeoutMs} from '../src/functions/summary-state.js';
import {registerSummarizeFunction} from '../src/functions/summarize.js';
import {KV} from '../src/state/schema.js';
afterEach(()=>{vi.unstubAllEnvs();vi.useRealTimers();});
it('validates the official configurable summary deadline and trigger headroom',()=>{
 for(const bad of ['nope','600s','1e6','0.5','0','2592000000']){vi.stubEnv('AGENTMEMORY_SUMMARY_TIMEOUT_MS',bad);expect(getSummaryTimeoutMs()).toBe(120000);}
 vi.stubEnv('AGENTMEMORY_SUMMARY_TIMEOUT_MS','600000');expect(getSummaryTimeoutMs()).toBe(600000);expect(getSummaryTriggerTimeoutMs()).toBe(660000);
});
it.each([['120000',false],['600000',true]])('small XML path honors %s ms deadline',async(timeout,success)=>{
 vi.stubEnv('AGENTMEMORY_SUMMARY_TIMEOUT_MS',timeout);vi.useFakeTimers();
 const handlers=new Map<string,any>();const rows=new Map<string,any>();const obs={id:'o',sessionId:'s',title:'edit',narrative:'synthetic',timestamp:'2026-01-01',compressedAt:'2026-01-01',facts:[],concepts:[],files:[],importance:5};
 rows.set(`${KV.sessions}:s`,{id:'s',status:'completed',project:'fixture',startedAt:'2026-01-01',observationCount:1});
 const kv={get:async(s:string,k:string)=>rows.get(`${s}:${k}`)??null,list:async(s:string)=>s===KV.observations('s')?[obs]:[],set:async(s:string,k:string,v:any)=>rows.set(`${s}:${k}`,v),update:async()=>{},delete:async()=>{}};
 const provider={name:'fixture',compress:vi.fn(),summarize:async()=>{await new Promise(r=>setTimeout(r,150000));return '<summary><title>synthetic</title><narrative>Synthetic coding work completed safely.</narrative><decisions></decisions><files></files><concepts></concepts></summary>';}};
 const worker=registerSummarizeFunction({registerFunction:(id:string,fn:any)=>handlers.set(id,fn),trigger:async()=>({})} as never,kv as never,provider as never,undefined,{schedule:false});
 try{const pending=handlers.get('mem::summarize')({sessionId:'s'});await vi.advanceTimersByTimeAsync(160000);expect(await pending).toMatchObject({success});}finally{await worker.stop();}
});
function stopFixture(overrides:Record<string,unknown>={}){
 const source=readFileSync(new URL('../src/cli.ts',import.meta.url),'utf8');const block=source.slice(source.indexOf('async function stopComposeRuntime('),source.indexOf('async function runStop()'));
 const deps:any={platform:()=> 'linux',composeChildPids:()=>[],nativeProcessStart:()=> '1',pidAlive:()=>true,composePidMatches:()=>true,composeCall:vi.fn(async()=>{}),composeDownTimeoutMs:()=>1000,terminateComposeChildren:vi.fn(async()=>true),signalAndWait:vi.fn(async()=>true),clearEnginePidfile:vi.fn(),clearWorkerPidfile:vi.fn(),clearEngineState:vi.fn(),p:{log:{warn:vi.fn()}},...overrides};
 const fn=new Function(...Object.keys(deps),ts.transpileModule(block,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText+';return stopComposeRuntime;')(...Object.values(deps));return{fn,deps};
}
it('Compose demo uses verified shared stop while native cleanup stays separate',()=>{
 const s=readFileSync(new URL('../src/cli.ts',import.meta.url),'utf8');const demo=s.slice(s.indexOf('async function startServerForDemo'),s.indexOf('async function runDemo()'));expect(demo).toContain('IS_WINDOWS && spawnedComposeDaemon');expect(demo).toContain('state.composePid !== spawnedComposeDaemon.pid');expect(demo).toContain('await stopComposeRuntime(state, true)');expect(demo).toContain('await cleanupFailedStartup()');
});
it('Compose stop refuses mismatched owner without clearing or signaling',async()=>{const{fn,deps}=stopFixture({composePidMatches:()=>false});await expect(fn({composePid:42},true)).rejects.toThrow(/does not match/);expect(deps.composeCall).not.toHaveBeenCalled();expect(deps.signalAndWait).not.toHaveBeenCalled();expect(deps.clearEngineState).not.toHaveBeenCalled();});
it('Compose stop preserves metadata on failed worker stop',async()=>{const{fn,deps}=stopFixture({terminateComposeChildren:async()=>false});await expect(fn({composePid:42},true)).rejects.toThrow(/did not stop/);expect(deps.clearEngineState).not.toHaveBeenCalled();});
it('Compose stop clears metadata only after workers and owner stop',async()=>{const{fn,deps}=stopFixture();await fn({composePid:42},true);expect(deps.composeCall).toHaveBeenCalledOnce();expect(deps.signalAndWait).toHaveBeenCalledWith(42,'SIGTERM',20000,true);expect(deps.clearEngineState).toHaveBeenCalledOnce();});
it('lets Compose stop its engine before any child cleanup',async()=>{
 const order:string[]=[];const{fn}=stopFixture({composeCall:async()=>{order.push('down');},signalAndWait:async()=>{order.push('daemon');return true;},terminateComposeChildren:async()=>{order.push('children');return true;}});
 await fn({composePid:42},true);expect(order).toEqual(['down','daemon','children']);
});
it('keeps metadata and skips child cleanup when daemon refuses graceful stop',async()=>{
 const{fn,deps}=stopFixture({signalAndWait:async()=>false});await expect(fn({composePid:42},true)).rejects.toThrow(/daemon.*did not stop/);expect(deps.terminateComposeChildren).not.toHaveBeenCalled();expect(deps.clearEngineState).not.toHaveBeenCalled();
});
it('captured Linux child cleanup refuses reused PID and never escalates',async()=>{
 const source=readFileSync(new URL('../src/cli.ts',import.meta.url),'utf8');const block=source.slice(source.indexOf('async function terminateComposeChildren('),source.indexOf('async function startIiiBin('));const signal=vi.fn(async()=>true);
 const load=(start:string)=>new Function('pidAlive','nativeProcessStart','signalAndWait',ts.transpileModule(block,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText+';return terminateComposeChildren;')(()=>true,()=>start,signal);
 expect(await load('new')({},[{pid:12,start:'old'}])).toBe(false);expect(signal).not.toHaveBeenCalled();expect(await load('same')({},[{pid:12,start:'same'}])).toBe(true);expect(signal).toHaveBeenCalledWith(12,'SIGTERM',5000,true);
});
