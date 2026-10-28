import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {mockKV,mockSdk} from './helpers/mocks.js';
import {registerCaptureFunctions} from '../src/functions/capture.js';
import {registerObserveFunction} from '../src/functions/observe.js';
import {registerApiTriggers} from '../src/triggers/api.js';
import {DedupMap} from '../src/functions/dedup.js';
import {createStateDurabilityFence} from '../src/ops/state-durability.mjs';
import {createCapture} from '../src/capture/client.js';
import {KV} from '../src/state/schema.js';
import {spoolSummary} from '../src/capture/spool.js';
vi.mock('../src/logger.js',()=>({logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}}));
const clean:(()=>void)[]=[];afterEach(()=>{for(const fn of clean.splice(0))fn();vi.unstubAllEnvs();});
const url='http://127.0.0.1:63000';
const body={eventId:'synthetic_e2e_001',hookType:'post_tool_use',sessionId:'synthetic',project:'synthetic',cwd:'/synthetic',timestamp:'2026-10-27T00:00:00Z',data:{tool_output:'synthetic original'}};
function boot(kv:ReturnType<typeof mockKV>){
 const sdk=mockSdk({looseTrigger:true}),dedup=new DedupMap();
 Object.assign(kv,{backend:'file',durability:createStateDurabilityFence({storePath:'/synthetic-not-used',completion:'sdk'})});
 registerObserveFunction(sdk as never,kv as never,dedup);const capture=registerCaptureFunctions(sdk as never,kv as never);registerApiTriggers(sdk as never,kv as never);
 const stop=()=>{capture.stop();dedup.stop();};clean.push(stop);
 return {stop,post:async(b:any)=>{const response=await sdk.fns.get('api::observe')!({body:b}) as any;return {status:response.status_code,body:response.body};}};
}
it('collects, accepts and processes a capture once; retains both originals across serialized worker recreation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'am-sdk-e2e-'));clean.push(()=>rmSync(dir,{recursive:true,force:true}));vi.stubEnv('AGENTMEMORY_CAPTURE_SPOOL_DIR',join(dir,'spool'));
 let kv=mockKV();let worker=boot(kv);let responses:any[]=[];
 let client=createCapture(url,async b=>{const r=await worker.post(b);responses.push(r);return r;});client.enqueue(body);await client.flush();client.stop();worker.stop();
 expect(responses[0]).toMatchObject({status:201,body:{completion:'sdk',completed:true,durable:false}});
 expect(await kv.list(KV.observations(body.sessionId))).toHaveLength(1);expect(await kv.list(KV.captureInbox)).toHaveLength(1);
 expect(spoolSummary(url)).toMatchObject({records:0,sdkRetained:1});
 const file=join(dir,'synthetic-state.json');writeFileSync(file,JSON.stringify([...kv.store].map(([scope,rows])=>[scope,[...rows]])));
 kv=mockKV();for(const [scope,rows] of JSON.parse(readFileSync(file,'utf8')))kv.store.set(scope,new Map(rows));worker=boot(kv);
 client=createCapture(url,async b=>{const r=await worker.post(b);responses.push(r);return r;});client.enqueue(body);await client.flush();client.stop();
 expect(responses[1]).toMatchObject({status:200,body:{completion:'sdk',completed:true,durable:false}});
 expect(await kv.list(KV.observations(body.sessionId))).toHaveLength(1);expect((await kv.list<any>(KV.captureInbox))[0].payload.data).toEqual(body.data);
 expect(spoolSummary(url)).toMatchObject({records:0,sdkRetained:1});
});
it('does not acknowledge an SDK-tagged original if its observation did not survive',async()=>{
 const kv=mockKV(),worker=boot(kv);
 const first=await worker.post({...body,captureCompletion:'sdk-v1'});expect(first.status).toBe(201);
 for(const [id] of kv.store.get(KV.observations(body.sessionId))!)await kv.delete(KV.observations(body.sessionId),id);
 const response=await worker.post({...body,captureCompletion:'sdk-v1'});
 expect(response.status).toBe(503);expect(response.body.completed).not.toBe(true);expect(await kv.list(KV.captureInbox)).toHaveLength(1);
});
