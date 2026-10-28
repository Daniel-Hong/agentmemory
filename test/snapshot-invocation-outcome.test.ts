import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm,readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createSnapshotRecovery} from '../src/ops/snapshot-recovery.mjs';
import {registerSnapshotFunction} from '../src/functions/snapshot.js';
import {registerApiTriggers} from '../src/triggers/api.js';
import {registerMcpEndpoints} from '../src/mcp/server.js';
import {operationalState} from '../src/ops/context.js';
import {mockKV,mockSdk} from './helpers/mocks.js';
import {KV} from '../src/state/schema.js';
vi.mock('../src/logger.js',()=>({logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}}));
vi.mock('node:child_process',async original=>({...await original<object>(),execFile:(...args:any[])=>{const cb=args.at(-1);const argv=args[1] as string[];cb(null,{stdout:argv[0]==='rev-parse'?'a'.repeat(40):'',stderr:''});}}));
const dirs:string[]=[];const controllers:any[]=[];const originalRecovery=operationalState.snapshotRecovery;
afterEach(async()=>{if(originalRecovery)operationalState.snapshotRecovery=originalRecovery;else delete operationalState.snapshotRecovery;await Promise.all(controllers.splice(0).map(x=>x.stop()));await Promise.all(dirs.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
function gate<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return{promise,resolve};}
async function dir(){const p=await mkdtemp(join(tmpdir(),'am-snapshot-outcome-'));dirs.push(p);return p;}
it('acknowledges a persisted admission while the actual export remains blocked',async()=>{
 const path=await dir(),sdk=mockSdk({looseTrigger:true}),kv=mockKV();const entered=gate<void>(),release=gate<void>();const list=kv.list;kv.list=async(scope:string)=>{if(scope===KV.sessions){entered.resolve();await release.promise;}return list(scope);};
 const recovery=registerSnapshotFunction(sdk as never,kv as never,path);controllers.push(recovery);let settled=false;const request=sdk.trigger({function_id:'mem::snapshot-request',payload:{}}).then(x=>{settled=true;return x;});
 try{await entered.promise;await new Promise(r=>setImmediate(r));expect(settled).toBe(true);const ack:any=await request;expect(ack).toMatchObject({accepted:true,completed:false});expect(ack.success).not.toBe(true);const metadata=JSON.parse(await readFile(join(path,'.snapshot-schedule.json'),'utf8'));expect(metadata.lastAttemptAt).toBe(ack.attemptAt);expect(recovery.snapshot()).toMatchObject({status:'running',attemptStatus:'running',lastAttemptAt:ack.attemptAt});}finally{release.resolve();await request;await recovery.drain();}
 expect(recovery.snapshot()).toMatchObject({status:'current',attemptStatus:'succeeded',lastErrorCode:null});
});
it('keeps a scheduler caller timeout separate from the real owner result',async()=>{
 const path=await dir(),release=gate<any>(),entered=gate<void>();let tick!:()=>void;let recovery:any;
 recovery=createSnapshotRecovery({dir:path,intervalMs:86400000,gitExec:async()=>'',setTimer:(fn:any)=>{tick=fn;return{unref(){}}as any;},clearTimer:()=>{},create:async()=>{void recovery.runCreate(()=>{entered.resolve();return release.promise;});await entered.promise;throw Object.assign(Error('synthetic caller timeout'),{code:'TIMEOUT'});}});controllers.push(recovery);
 await recovery.init();recovery.start();tick();await entered.promise;await new Promise(r=>setImmediate(r));
 try{expect(recovery.snapshot()).toMatchObject({status:'running',failures:0,lastErrorCode:null});}finally{release.resolve({success:false,errorCode:'SYNTHETIC_EXPORT_FAILURE'});await recovery.drain();}
 expect(recovery.snapshot()).toMatchObject({attemptStatus:'failed',failures:1,lastErrorCode:'SYNTHETIC_EXPORT_FAILURE'});
});
it('returns 202 admission and whitelisted input instead of waiting for completion at REST',async()=>{
 const sdk=mockSdk({looseTrigger:true});let received:any;sdk.registerFunction('mem::snapshot-request',async(value)=>{received=value;return{accepted:true,completed:false,attemptAt:'2026-01-01T00:00:00.000Z'};});registerApiTriggers(sdk as never,mockKV()as never,'synthetic-secret');
 const call=sdk.fns.get('api::snapshot-create')!;const result:any=await call({headers:{authorization:'Bearer synthetic-secret'},body:{message:'fixture',privateField:'must not forward'}});
 expect(result.status_code).toBe(202);expect(result.body).toMatchObject({accepted:true,completed:false,statusUrl:'/agentmemory/snapshot/status'});expect(received).toEqual({message:'fixture'});
 expect((await call({headers:{},body:{}})as any).status_code).toBe(401);
});
it('does not label an unconfirmed transport failure as disabled or completed',async()=>{
 const sdk=mockSdk({looseTrigger:true});sdk.registerFunction('mem::snapshot-request',async()=>{throw Error('PRIVATE_ERROR_CANARY');});registerApiTriggers(sdk as never,mockKV()as never,'synthetic-secret');
 const result:any=await sdk.fns.get('api::snapshot-create')!({headers:{authorization:'Bearer synthetic-secret'},body:{}});
 expect(result.status_code).toBe(503);expect(result.body).toMatchObject({completed:false,errorCode:'SNAPSHOT_REQUEST_UNCONFIRMED',retryable:false});expect(JSON.stringify(result)).not.toMatch(/PRIVATE_ERROR_CANARY|Snapshots not enabled/);
});
it('lets MCP request admission and read status without creating another snapshot',async()=>{
 const sdk=mockSdk({looseTrigger:true});let creates=0;sdk.registerFunction('mem::snapshot-request',async(value:any)=>{creates++;expect(value).toEqual({message:'fixture'});return{accepted:true,completed:false,attemptAt:'2026-01-01T00:00:00.000Z'};});sdk.registerFunction('mem::snapshot-status',async()=>({status:'running',attemptStatus:'running'}));registerMcpEndpoints(sdk as never,mockKV()as never,'synthetic-secret');
 const call=(args:any,name='memory_snapshot_create')=>sdk.fns.get('mcp::tools::call')!({headers:{authorization:'Bearer synthetic-secret'},body:{name,arguments:args}})as Promise<any>;
 const first=await call({message:'fixture'});expect(JSON.parse(first.body.content[0].text)).toMatchObject({accepted:true,completed:false});const status=await call({},'memory_snapshot_status');expect(JSON.parse(status.body.content[0].text)).toMatchObject({status:'running',attemptStatus:'running'});expect(creates).toBe(1);
});
it('does not overwrite a finished owner when its scheduler RPC error arrives late',async()=>{
 const path=await dir();let tick!:()=>void;let recovery:any;
 recovery=createSnapshotRecovery({dir:path,intervalMs:86400000,gitExec:async()=>'',setTimer:(fn:any)=>{tick=fn;return{unref(){}}as any;},clearTimer:()=>{},create:async()=>{await recovery.runCreate(async()=>({success:true,commitHash:'a'.repeat(40)}));throw Object.assign(Error('synthetic late caller timeout'),{code:'TIMEOUT'});}});controllers.push(recovery);
 await recovery.init();recovery.start();tick();await recovery.drain();
 expect(recovery.snapshot()).toMatchObject({attemptStatus:'succeeded',failures:0,lastErrorCode:null});
});
it('reports an interrupted retry as unknown without erasing the earlier failure history',async()=>{
 const path=await dir(),release=gate<any>();const config={dir:path,intervalMs:86400000,gitExec:async()=>'',create:async()=>{},isPaused:()=>false};const first=createSnapshotRecovery(config);controllers.push(first);
 await first.runCreate(async()=>({success:false,errorCode:'FIRST_FAILED'}));const ack:any=await first.requestCreate(()=>release.promise);
 const restarted=createSnapshotRecovery(config);controllers.push(restarted);
 try{await restarted.init();expect(restarted.snapshot()).toMatchObject({attemptStatus:'unknown',lastAttemptAt:ack.attemptAt,lastErrorCode:'FIRST_FAILED',failures:1});}finally{release.resolve({success:true,commitHash:'a'.repeat(40)});await first.drain();}
});
it('does not call an empty or malformed SDK response a completed creation',async()=>{
 const sdk=mockSdk({looseTrigger:true});registerApiTriggers(sdk as never,mockKV()as never,'synthetic-secret');const response:any=await sdk.fns.get('api::snapshot-create')!({headers:{authorization:'Bearer synthetic-secret'},body:{}});expect(response.status_code).toBe(503);expect(response.body).toMatchObject({completed:false,errorCode:'SNAPSHOT_REQUEST_UNCONFIRMED'});
});
it('waits an already active manual owner instead of dispatching a competing scheduler RPC',async()=>{
 const path=await dir(),release=gate<any>(),entered=gate<void>();let tick!:()=>void,clock=0,calls=0;let owner!:Promise<any>;let recovery:any;
 recovery=createSnapshotRecovery({dir:path,intervalMs:86400000,gitExec:async()=>'',now:()=>clock,setTimer:(fn:any)=>{tick=fn;return{unref(){}}as any;},clearTimer:()=>{},create:async()=>{calls++;await owner;throw Object.assign(Error('synthetic late timeout'),{code:'TIMEOUT'});}});controllers.push(recovery);
 owner=recovery.runCreate(()=>{entered.resolve();return release.promise;});await entered.promise;clock=61000;recovery.start();tick();await new Promise(r=>setImmediate(r));release.resolve({success:true,commitHash:'a'.repeat(40)});await owner;await recovery.drain();
 expect(calls).toBe(0);expect(recovery.snapshot()).toMatchObject({attemptStatus:'succeeded',failures:0,lastErrorCode:null});
});
it('keeps a real admission failure as a failure at MCP instead of a successful tool result',async()=>{
 const sdk=mockSdk({looseTrigger:true});sdk.registerFunction('mem::snapshot-request',async()=>({success:false,errorCode:'SYNTHETIC_ADMISSION_FAILED'}));registerMcpEndpoints(sdk as never,mockKV()as never,'synthetic-secret');const result:any=await sdk.fns.get('mcp::tools::call')!({headers:{authorization:'Bearer synthetic-secret'},body:{name:'memory_snapshot_create',arguments:{}}});expect(result.body.isError).toBe(true);
});

it('refuses admission when its metadata cannot be published and preserves the prior snapshot',async()=>{
 const path=await dir();const recovery=createSnapshotRecovery({dir:path,intervalMs:86400000,gitExec:async()=>'',create:async()=>{}});controllers.push(recovery);await recovery.init();await writeFile(join(path,'state.json'),'previous synthetic snapshot');await mkdir(join(path,'.snapshot-schedule.json'));let calls=0;
 const result:any=await recovery.requestCreate(async()=>{calls++;return{success:true,commitHash:'a'.repeat(40)};});expect(result.accepted).not.toBe(true);expect(result.success).toBe(false);expect(calls).toBe(0);expect(await readFile(join(path,'state.json'),'utf8')).toBe('previous synthetic snapshot');expect((await readdir(path)).filter(x=>x.endsWith('.tmp'))).toEqual([]);
});
it('admits one concurrent request, respects pause and waits for its real owner on drain',async()=>{
 const path=await dir(),release=gate<any>();let paused=false,calls=0;const recovery=createSnapshotRecovery({dir:path,intervalMs:86400000,gitExec:async()=>'',create:async()=>{},isPaused:()=>paused});controllers.push(recovery);
 const work=()=>{calls++;return release.promise;};const [a,b]:any[]=await Promise.all([recovery.requestCreate(work),recovery.requestCreate(work)]);
 try{expect(a).toMatchObject({accepted:true,completed:false});expect(b).toMatchObject({success:false,deferred:true,reason:'snapshot_in_progress'});expect(calls).toBe(1);paused=true;expect(await recovery.requestCreate(work)).toMatchObject({deferred:true,reason:'background_paused'});let drained=false;const drain=recovery.drain().then(()=>{drained=true;});await new Promise(r=>setImmediate(r));expect(drained).toBe(false);release.resolve({success:true,commitHash:'a'.repeat(40)});await drain;expect(recovery.snapshot()).toMatchObject({status:'paused',attemptStatus:'succeeded'});}finally{release.resolve({success:true,commitHash:'a'.repeat(40)});await recovery.drain();}
});
it('reads legacy metadata without rewriting it or inventing a completed-attempt proof',async()=>{
 const path=await dir();const legacy={version:1,lastSuccessAt:'2026-01-01T00:01:00.000Z',lastCommitHash:'a'.repeat(40),lastAttemptAt:'2026-01-01T00:00:00.000Z',nextAttemptAt:0,failures:0,lastErrorCode:null};const bytes=JSON.stringify(legacy);await writeFile(join(path,'.snapshot-schedule.json'),bytes);const recovery=createSnapshotRecovery({dir:path,intervalMs:86400000,gitExec:async()=>'',create:async()=>{}});controllers.push(recovery);await recovery.init();expect(recovery.snapshot()).toMatchObject({attemptStatus:'unknown',lastSuccessAt:legacy.lastSuccessAt,lastAttemptAt:legacy.lastAttemptAt});expect(await readFile(join(path,'.snapshot-schedule.json'),'utf8')).toBe(bytes);
});

it('keeps status lookup authenticated and read-only at REST',async()=>{
 const sdk=mockSdk();let creates=0;sdk.registerFunction('mem::snapshot-status',async()=>({status:'running',attemptStatus:'running'}));sdk.registerFunction('mem::snapshot-create',async()=>{creates++;});sdk.registerFunction('mem::snapshot-request',async()=>{creates++;});registerApiTriggers(sdk as never,mockKV()as never,'synthetic-secret');const call=sdk.fns.get('api::snapshot-status')!;expect((await call({headers:{}})as any).status_code).toBe(401);const response:any=await call({headers:{authorization:'Bearer synthetic-secret'}});expect(response.status_code).toBe(200);expect(response.body).toMatchObject({snapshotRecovery:{attemptStatus:'running'}});expect(response.headers).toMatchObject({'Cache-Control':'no-store'});expect(creates).toBe(0);
});
it('cannot fall back to creation when an older server lacks the read-only status function',async()=>{
 const sdk=mockSdk();let creates=0;sdk.registerFunction('mem::snapshot-create',async()=>{creates++;});registerMcpEndpoints(sdk as never,mockKV()as never,'synthetic-secret');const response:any=await sdk.fns.get('mcp::tools::call')!({headers:{authorization:'Bearer synthetic-secret'},body:{name:'memory_snapshot_status',arguments:{}}});expect(response.body.isError).toBe(true);expect(JSON.parse(response.body.content[0].text)).toMatchObject({errorCode:'SNAPSHOT_STATUS_UNAVAILABLE'});expect(creates).toBe(0);
});
