import {it,expect,vi,afterEach} from 'vitest';
import {mockKV,mockSdk} from './helpers/mocks.js';
import {registerObserveFunction} from '../src/functions/observe.js';
import {registerCaptureReceipts} from '../src/capture/receipts.js';
import {captureEventScope} from '../src/capture/event-record.js';
import {capturePayloadDigest} from '../src/capture/receipt-digest.js';
import {scrubRecord} from '../src/functions/privacy.js';
import {KV} from '../src/state/schema.js';
vi.mock('../src/logger.js',()=>({logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}}));
afterEach(()=>vi.unstubAllEnvs());
const cases=[
 ['ordinary',{text:'한😀',array:[null,false,3]}],
 ['secret-value',{text:'api_key='+'a'.repeat(26)}],
 ['private-value',{text:'before <private>synthetic</private> after'}],
 ['secret-key',{['sk-'+'a'.repeat(26)]:'ordinary'}],
 ['colliding-secret-keys',{['sk-'+'a'.repeat(26)]:'first',['pk-'+'a'.repeat(26)]:'second'}],
 ['cross-field-private-tags',{a:'<private>start',b:'end</private>'}],
 ['quoted-secret',{text:'password="'+'a'.repeat(26)+'"'}],
 ['own-proto',JSON.parse('{"__proto__":{"text":"ordinary"}}')],
] as const;

for(const viaSpool of [false,true])for(const [name,data]of cases){
 it(`${viaSpool?'spooled':'direct'} ${name}: compatible proof`,async()=>{
  vi.stubEnv('AGENTMEMORY_AUTO_COMPRESS','true');
  const sdk=mockSdk({looseTrigger:true}),kv=mockKV();
  registerObserveFunction(sdk as never,kv as never);registerCaptureReceipts(sdk as never,kv as never);
  const fence=vi.fn(async()=>({synced:true}));Object.assign(kv,{durability:{waitForKeys:fence}});
  const key='cap_'+'a'.repeat(40),wire=JSON.parse(JSON.stringify(data));
  const body={hookType:'post_tool_use',project:'synthetic',sessionId:'synthetic-session',eventId:'synthetic-event',cwd:'/synthetic',timestamp:'2026-10-27T00:00:00Z',captureKey:key,data:viaSpool?scrubRecord(wire,{scrubKeys:true}):wire};
  const original=JSON.stringify(body);
  const observed:any=await sdk.trigger({function_id:'mem::observe',payload:body});
  expect(observed.observationId).toBeTruthy();
  const obs:any=await kv.get(KV.observations(body.sessionId),observed.observationId);expect(obs.sourceRaw).toBeTruthy();
  await kv.set(captureEventScope(key),key,{key,sessionId:body.sessionId,eventId:body.eventId,observationId:observed.observationId});
  const proof:any=await sdk.trigger({function_id:'mem::capture-receipt',payload:{key,digest:capturePayloadDigest(body),budgetMs:1000}});
  expect(proof).toEqual({key,state:'completed',durable:true});
  expect(fence).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(body)).toBe(original);
 });
}
