import {afterEach,expect,it,vi} from 'vitest';
import {mockKV,mockSdk} from './helpers/mocks.js';
import {registerApiTriggers} from '../src/triggers/api.js';
import {operationalState} from '../src/ops/context.js';
import {KV} from '../src/state/schema.js';
afterEach(()=>{vi.restoreAllMocks();delete operationalState.embeddingRecovery;});
async function fixture(){
 const kv=mockKV(),sdk=mockSdk({looseTrigger:true});
 const cached={status:'healthy',memory:{heapUsed:100,heapTotal:200,heapLimit:400,rss:300},uptimeSeconds:1,cpu:{percent:2}};
 await kv.set(KV.health,'latest',cached);
 const get=vi.spyOn(kv,'get'),set=vi.spyOn(kv,'set'),list=vi.spyOn(kv,'list'),trigger=vi.spyOn(sdk,'trigger');
 const metrics={getAll:vi.fn(async()=>[])};registerApiTriggers(sdk as never,kv as never,'synthetic-secret',metrics as never);
 return{kv,sdk,cached,get,set,list,trigger,metrics,call:()=>sdk.fns.get('api::health')!({})as Promise<any>};
}
it('registered health returns one live sample while preserving cached health and existing lookup counts',async()=>{
 const f=await fixture(),live={heapUsed:1024,heapTotal:2048,rss:4096,external:128,arrayBuffers:64};
 const read=vi.spyOn(process,'memoryUsage').mockReturnValue(live);const before=Date.now();const response=await f.call();const after=Date.now();
 expect(response.status_code).toBe(200);expect(response.body.health).toEqual(f.cached);expect(response.body.health.memory.heapUsed).toBe(100);
 const sample=response.body.resourceSample;expect(sample).toMatchObject({version:1,pid:process.pid,memory:live});expect(sample.memory.heapLimit).toBeGreaterThan(0);
 expect(sample.startedAtMs).toBeGreaterThanOrEqual(before);expect(sample.finishedAtMs).toBeLessThanOrEqual(after);expect(sample.finishedAtMs).toBeGreaterThanOrEqual(sample.startedAtMs);expect(sample.uptimeEndSeconds).toBeGreaterThanOrEqual(sample.uptimeStartSeconds);
 expect(read).toHaveBeenCalledTimes(1);expect(f.get.mock.calls).toEqual([[KV.health,'latest']]);expect(f.set).not.toHaveBeenCalled();expect(f.list).not.toHaveBeenCalled();expect(f.trigger).not.toHaveBeenCalled();expect(f.metrics.getAll).toHaveBeenCalledTimes(1);
 expect(f.sdk.registerTrigger).toHaveBeenCalledWith({type:'http',function_id:'api::health',config:{api_path:'/agentmemory/health',http_method:'GET',middleware_function_ids:['middleware::api-auth']}});
});
it('samples after asynchronous operational reads, not before their delay',async()=>{
 const f=await fixture();let release!:()=>void;const wait=new Promise<void>(r=>release=r);operationalState.embeddingRecovery={snapshot:async()=>{await wait;return{status:'current'};}}as never;
 let clock=1000,uptime=1;vi.spyOn(Date,'now').mockImplementation(()=>clock);vi.spyOn(process,'uptime').mockImplementation(()=>uptime);const read=vi.spyOn(process,'memoryUsage').mockReturnValue({heapUsed:1,heapTotal:2,rss:3,external:0,arrayBuffers:0});
 const promise=f.call();await Promise.resolve();await Promise.resolve();expect(read).not.toHaveBeenCalled();clock=3000;uptime=3;release();const response=await promise;
 expect(response.body.resourceSample).toMatchObject({startedAtMs:3000,finishedAtMs:3000,uptimeStartSeconds:3,uptimeEndSeconds:3});expect(read).toHaveBeenCalledTimes(1);
});
it('same cached health can accompany independently sampled changing live memory',async()=>{
 const f=await fixture();let used=1000;vi.spyOn(process,'memoryUsage').mockImplementation(()=>({heapUsed:used,heapTotal:3000,rss:4000,external:0,arrayBuffers:0}));
 const first=await f.call();used=2000;const second=await f.call();expect(first.body.resourceSample).toBeDefined();expect(first.body.resourceSample.memory.heapUsed).toBe(1000);expect(second.body.resourceSample.memory.heapUsed).toBe(2000);expect(first.body.health).toEqual(second.body.health);
});
it('a local sampling error is unavailable without breaking health or exposing the exception',async()=>{
 const f=await fixture();vi.spyOn(process,'memoryUsage').mockImplementation(()=>{throw Error('synthetic-private');});const r=await f.call();expect(r.status_code).toBe(200);expect(r.body.health).toEqual(f.cached);expect(r.body.resourceSample).toBeNull();expect(JSON.stringify(r)).not.toContain('synthetic-private');
});

import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
it('serialized registered API response crosses the real Python observer boundary and stale or old-server replies refuse',async()=>{
 const f=await fixture();operationalState.memoryPressure={snapshot:()=>({level:'normal'})}as never;operationalState.storageDurability={snapshot:()=>({completion:'sdk',mutationFailures:0})};
 try{
  const response=await f.call();const wire=JSON.parse(JSON.stringify(response.body));wire.privateField='synthetic-private-body';
  const script=fileURLToPath(new URL('../scripts/personal-release/live-memory-observer.py',import.meta.url));
  const input={response:wire,receivedAtMs:Date.now(),hostAvailableBytes:16*1024**3,expectedPid:process.pid};
  const run=(value:unknown)=>{const p=spawnSync('/usr/bin/python3',['-I','-B',script,'--check'],{input:JSON.stringify(value),encoding:'utf8',timeout:5000,maxBuffer:131072});expect(p.error).toBeUndefined();expect(p.stderr).toBe('');return{code:p.status,result:JSON.parse(p.stdout),stdout:p.stdout};};
  const live=run(input);expect(live.code).toBe(0);expect(live.result).toMatchObject({unsafe:false,freshness:'fresh',sample:{pid:process.pid,memory:{heapUsed:wire.resourceSample.memory.heapUsed}}});expect(live.stdout).not.toContain('synthetic-private-body');
  const stale=run({...input,receivedAtMs:wire.resourceSample.finishedAtMs+15001});expect(stale.code).toBe(2);expect(stale.result.refusalReason).toBe('stale_sample');
  const changed=run({...input,expectedPid:process.pid+1});expect(changed.code).toBe(2);expect(changed.result.refusalReason).toBe('unexpected_pid');
  const old=structuredClone(input);delete old.response.resourceSample;expect(run(old).result.refusalReason).toBe('missing_resource_sample');
 }finally{delete operationalState.memoryPressure;delete operationalState.storageDurability;}
});
it('incoherent local capture clocks do not publish a misleading live sample',async()=>{
 const f=await fixture();vi.spyOn(Date,'now').mockReturnValueOnce(2000).mockReturnValueOnce(1999);expect((await f.call()).body.resourceSample).toBeNull();
});
