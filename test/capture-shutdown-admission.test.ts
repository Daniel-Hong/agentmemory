import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {mockKV,mockSdk} from './helpers/mocks.js';
import {KV} from '../src/state/schema.js';
import {registerCaptureFunctions,captureKey, type InboxRecord} from '../src/functions/capture.js';
import {createShutdownIngress} from '../src/ops/shutdown-ingress.mjs';
import {appendSpool,drainSpool,spoolPaths} from '../src/capture/spool.js';
vi.mock('../src/logger.js',()=>({logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}}));
const dirs:string[]=[];
afterEach(()=>{vi.unstubAllEnvs();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const payload=(id:string)=>({sessionId:'synthetic-stop',project:'synthetic',hookType:'post_tool_use',cwd:'/synthetic',timestamp:'2026-10-16T00:00:00Z',data:{tool_output:'synthetic-raw-'+id}});
function gate(){let release!:()=>void;const promise=new Promise<void>(r=>{release=r;});return{promise,release};}
function setup(spool=false){
 const home=mkdtempSync(join(tmpdir(),'am-stop-admission-'));dirs.push(home);vi.stubEnv('HOME',home);vi.stubEnv('AGENTMEMORY_HOME',home);vi.stubEnv('AGENTMEMORY_CAPTURE_SPOOL_DIR',join(home,'spool'));vi.stubEnv('AGENTMEMORY_CAPTURE_SPOOL','true');
 const kv=mockKV(),sdk=mockSdk(),ingress=createShutdownIngress();ingress.install(sdk,()=>null);
 const started=gate(),finish=gate(),calls:string[]=[];
 sdk.registerFunction('mem::observe',async(input:any)=>{calls.push(input.eventId);started.release();await finish.promise;return{observationId:input.observationId};});
 const controller=registerCaptureFunctions(sdk as never,kv as never,spool?{restPort:45678,durableAfterMs:60000}:{});
 sdk.registerFunction('mem::synthetic-sweep',()=>controller.sweep());
 sdk.registerFunction('mem::synthetic-spool',()=>controller.drainLocalSpool());
 return{home,kv,sdk,ingress,controller,started,finish,calls};
}
async function seed(f:ReturnType<typeof setup>){
 const rows:InboxRecord[]=[];
 for(let i=0;i<3;i++){
  const eventId='synthetic-stop-event-'+i,key=captureKey('synthetic','synthetic-stop',eventId);
  const rec={key,eventId,eventSource:'client' as const,sessionId:'synthetic-stop',project:'synthetic',hookType:'post_tool_use',observationId:'synthetic-observation-'+i,status:'pending' as const,attempts:0,acceptedAt:'2026-10-16T00:00:00Z',updatedAt:'2026-10-16T00:00:00Z',payload:payload(String(i))};
  rows.push(structuredClone(rec));await f.kv.set(KV.captureInbox,key,rec);
 }
 return rows;
}
it('ends an inherited admitted sweep after its current record without admitting another retry',async()=>{
 const f=setup(),rows=await seed(f);
 const work=f.sdk.trigger({function_id:'mem::synthetic-sweep',payload:{}});await f.started.promise;
 f.ingress.close();f.controller.stop();
 await expect(f.sdk.trigger({function_id:'mem::capture',payload:{payload:payload('late'),eventId:'synthetic-stop-late'}})).rejects.toMatchObject({code:'WORKER_DRAINING'});
 f.finish.release();
 expect(await work).toMatchObject({processed:1,recovered:1});
 expect(f.calls).toEqual([rows[0].eventId]);
 expect(await f.kv.list(KV.captureInbox)).toEqual(rows.slice(1));
 expect(await f.controller.sweep()).toEqual({processed:0,recovered:0,deadLettered:0});
});
it('drain waits for a directly started sweep and stop remains terminal',async()=>{
 const f=setup();await seed(f);const work=f.controller.sweep();await f.started.promise;f.controller.stop();
 let drained=false;const done=f.controller.drain().then(()=>{drained=true;});await Promise.resolve();await Promise.resolve();expect(drained).toBe(false);
 f.finish.release();await Promise.all([work,done]);f.controller.start();
 expect(await f.controller.sweep()).toEqual({processed:0,recovered:0,deadLettered:0});expect(f.calls).toHaveLength(1);
});
it('stops a directly started boot spool after the acknowledged record and drains that active promise',async()=>{
 const f=setup(true),dir=join(f.home,'spool'),url='http://127.0.0.1:45678';
 for(let i=0;i<3;i++)expect(appendSpool(url,'synthetic-stop-spool-'+i,payload(String(i)),'synthetic',{dir}).spooled).toBe(true);
 const work=f.controller.drainLocalSpool();await f.started.promise;f.ingress.close();f.controller.stop();
 let drained=false;const done=f.controller.drain().then(()=>{drained=true;});await Promise.resolve();await Promise.resolve();expect(drained).toBe(false);
 f.finish.release();await Promise.all([work,done]);
 expect(f.calls).toEqual(['synthetic-stop-spool-0']);
 const remaining=readFileSync(spoolPaths(url,dir).file,'utf8').trim().split('\n').map(line=>JSON.parse(line));
 expect(remaining.map(r=>r.eventId)).toEqual(['synthetic-stop-spool-1','synthetic-stop-spool-2']);
 expect(remaining.every(r=>r.attempts===0)).toBe(true);
 expect(await f.controller.drainLocalSpool()).toEqual([]);
});
it('spool stop keeps unseen records unchanged before expiry, dedup or retry accounting',async()=>{
 const home=mkdtempSync(join(tmpdir(),'am-spool-stop-'));dirs.push(home);const url='http://127.0.0.1:45679';
 for(let i=0;i<2;i++)appendSpool(url,'synthetic-graceful-'+i,payload(String(i)),'synthetic',{dir:home});
 const paths=spoolPaths(url,home);
 const lines=readFileSync(paths.file,'utf8').trim().split('\n').map(line=>JSON.parse(line));
 lines[1].spooledAt='2000-01-01T00:00:00Z';writeFileSync(paths.file,lines.map(line=>JSON.stringify(line)).join('\n')+'\n');
 const before=readFileSync(paths.file,'utf8');let stopped=false;
 const send=vi.fn(async()=>{stopped=true;return 'delivered' as const;});
 const result=await drainSpool(url,send,{dir:home,shouldStop:()=>stopped});
 expect(result).toMatchObject({delivered:1,remaining:1,expired:0,duplicates:0});expect(send).toHaveBeenCalledTimes(1);
 expect(readFileSync(paths.file,'utf8').trim()).toBe(before.trim().split('\n')[1]);
});

it('a forced retry waiting on the current record lock cannot reopen admission after stop',async()=>{
 const f=setup(),rows=await seed(f);const work=f.controller.sweep();await f.started.promise;
 const retry=f.sdk.trigger({function_id:'mem::capture-retry',payload:{all:true}});await Promise.resolve();await Promise.resolve();
 f.ingress.close();f.controller.stop();f.finish.release();await Promise.all([work,retry]);
 expect(f.calls).toEqual([rows[0].eventId]);expect(await f.kv.list(KV.captureInbox)).toEqual(rows.slice(1));
});
