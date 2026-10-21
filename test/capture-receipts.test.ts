import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mockKV, mockSdk } from './helpers/mocks.js';
import { registerCaptureFunctions, captureKey } from '../src/functions/capture.js';
import { registerApiTriggers } from '../src/triggers/api.js';
import { captureEventScope } from '../src/capture/event-record.js';
import { KV } from '../src/state/schema.js';

const key=captureKey('synthetic-project','synthetic-session','synthetic-event');
const raw={id:'obs_fixture',sessionId:'synthetic-session',captureKey:key,eventId:'synthetic-event',hookType:'post_tool_use',timestamp:'2026-10-21T00:00:00Z',raw:{tool_output:'PRIVATE FIXTURE ONLY'}};
// Fixed JSON-array order defines the v1 receipt digest; object keys within raw data are sorted.
const digest=createHash('sha256').update(JSON.stringify([raw.hookType,raw.timestamp,raw.raw])).digest('hex');
async function setup(){
 const kv=mockKV(),sdk=mockSdk({looseTrigger:true});
 const done={key,eventId:raw.eventId,sessionId:raw.sessionId,project:'synthetic-project',observationId:raw.id,acceptedAt:raw.timestamp,completedAt:raw.timestamp,attempts:1};
 const obs={id:raw.id,sessionId:raw.sessionId,captureKey:key,sourceRaw:raw};
 await kv.set(captureEventScope(key),key,done);await kv.set(KV.observations(raw.sessionId),raw.id,obs);
 const fence=vi.fn(async()=>({synced:true}));Object.assign(kv,{durability:{waitForKeys:fence}});
 registerCaptureFunctions(sdk as never,kv as never);registerApiTriggers(sdk as never,kv as never,'fixture-secret');
 const call=(query_params:Record<string,string>={key},auth=true)=>{
  const fn=sdk.fns.get('api::capture-receipts');
  return fn?fn({query_params,headers:auth?{authorization:'Bearer fixture-secret'}:{}}) as Promise<any>:Promise.resolve({status_code:501,body:{error:'MISSING_RECEIPTS'}});
 };
 return {kv,sdk,done,obs,fence,call};
}
describe('body-free capture receipts',()=>{
 it('requires authentication and rejects unsafe or ambiguous selections',async()=>{const {call}=await setup();expect((await call({key},false)).status_code).toBe(401);for(const q of [{key:'../bad'},{key,preview:'true'},{key,digest:'bad'},{key,shard:'00'},{shard:'xx'},{shard:'00',offset:'-1'}])expect((await call(q)).status_code).toBe(400);});
 it('returns metadata without a proof until explicitly verified, never exposing source or personal identity',async()=>{const {call,fence}=await setup();const r=await call();expect(r.status_code).toBe(200);expect(r.body).toEqual({key,state:'completed',durable:false});expect(fence).not.toHaveBeenCalled();expect(JSON.stringify(r)).not.toContain('PRIVATE');expect(JSON.stringify(r)).not.toContain('synthetic-session');});
 it('verifies both completed metadata and the matching full source before releasing ownership',async()=>{const {call,fence}=await setup();expect((await call({key,digest})).body).toEqual({key,state:'completed',durable:true});expect(fence).toHaveBeenCalledWith(expect.anything(),[{scope:captureEventScope(key),key},{scope:KV.observations(raw.sessionId),key:raw.id}],expect.objectContaining({expectedValues:[expect.any(Object),expect.any(Object)],deadline:expect.any(Number)}));});
 it.each(['deleted','missing','wrong-key','wrong-payload','no-fence','timeout','changed-after-fence'])('fails closed for %s',async(mode)=>{const {kv,done,obs,fence,call}=await setup();if(mode==='deleted')await kv.set(captureEventScope(key),key,{...done,state:'deleted'});if(mode==='missing')await kv.delete(KV.observations(raw.sessionId),raw.id);if(mode==='wrong-key')await kv.set(KV.observations(raw.sessionId),raw.id,{...obs,captureKey:'cap_'+'0'.repeat(40)});if(mode==='wrong-payload')await kv.set(KV.observations(raw.sessionId),raw.id,{...obs,sourceRaw:{...raw,raw:{tool_output:'different'}}});if(mode==='no-fence')Object.assign(kv,{durability:undefined});if(mode==='timeout')fence.mockRejectedValue(new Error('PRIVATE backend body'));if(mode==='changed-after-fence')fence.mockImplementation(async()=>{await kv.delete(KV.observations(raw.sessionId),raw.id);return {synced:true};});const r=await call({key,digest});expect(r.body.durable).toBe(false);expect(JSON.stringify(r)).not.toContain('PRIVATE');});
 it('bounds response time and outstanding work when the SDK never settles, then recovers slots',async()=>{
  const {kv,call,done}=await setup();const original=kv.get;let release!:(value:unknown)=>void;
  kv.get=vi.fn(()=>new Promise(resolve=>{release=resolve;})) as typeof kv.get;
  vi.useFakeTimers();try{
   const first=call({key,digest,budgetMs:'20'}),second=call({key,digest,budgetMs:'20'});
   await vi.advanceTimersByTimeAsync(25);
   expect((await first).body).toMatchObject({durable:false,state:'unavailable'});expect((await second).body.durable).toBe(false);
   expect((await call({key,digest,budgetMs:'20'})).body.state).toBe('busy');
   expect(kv.get).toHaveBeenCalledTimes(1);
   release(done);await vi.advanceTimersByTimeAsync(0);kv.get=original;
   expect((await call()).body.state).toBe('completed');
  }finally{vi.useRealTimers();kv.get=original;}
 });
 it('fails closed when bounded metadata paging is unavailable, without SDK namespace listing',async()=>{const {kv,call}=await setup();const list=vi.spyOn(kv,'list');expect((await call({shard:key.slice(4,6)})).status_code).toBe(503);expect(list).not.toHaveBeenCalled();});

});
