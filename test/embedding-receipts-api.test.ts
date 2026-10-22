import {afterEach,expect,it,vi} from 'vitest';
import {mockKV,mockSdk} from './helpers/mocks.js';
import {registerApiTriggers} from '../src/triggers/api.js';
import {createHash} from 'node:crypto';
import {createEmbeddingReceiptStatus} from '../src/ops/embedding-receipt-status.mjs';
import {createObservationReader} from '../src/ops/observation-pages.mjs';
import {KV} from '../src/state/schema.js';
afterEach(()=>vi.useRealTimers());
const fixture=()=>{
 const kv=mockKV(),sdk=mockSdk({looseTrigger:true});
 const query=vi.fn(async({ids})=>({version:1,evidence:'metadata_only',items:ids.map((id:string)=>({id,status:'unavailable',diskVerified:false}))}));
 sdk.fns.set('mem::embedding-receipts',query);registerApiTriggers(sdk as never,kv as never,'fixture-secret');
 const call=(query_params:Record<string,unknown>={ids:'obs_a,obs_b'},auth=true)=>{
  const fn=sdk.fns.get('api::embedding-receipts');return fn?fn({query_params,headers:auth?{authorization:'Bearer fixture-secret'}:{}}) as Promise<any>:Promise.resolve({status_code:501});
 };return{call,query,sdk};
};
it('requires authentication before any embedding metadata lookup',async()=>{
 const f=fixture();expect((await f.call(undefined,false)).status_code).toBe(401);expect(f.query).not.toHaveBeenCalled();
});
it('rejects duplicate, unbounded and unknown query fields without touching state',async()=>{
 const f=fixture();for(const q of [{},{ids:'x,x'},{ids:''},{ids:'../bad'},{ids:'a',preview:'true'},{ids:['a','b']},{ids:'a'.repeat(257)},{ids:'a\nb'},{ids:Array.from({length:33},(_,n)=>'obs_'+n).join(',')}])expect((await f.call(q)).status_code).toBe(400);
 expect(f.query).not.toHaveBeenCalled();
});
it('returns only the internal bounded metadata response with no caching',async()=>{
 const f=fixture();const r=await f.call();expect(r.status_code).toBe(200);expect(r.headers['Cache-Control']).toBe('no-store');expect(f.query).toHaveBeenCalledWith({ids:['obs_a','obs_b']});expect(r.body.items).toHaveLength(2);
});
it('does not disclose an internal read failure',async()=>{
 const f=fixture();f.query.mockRejectedValueOnce(Error('PRIVATE_BODY_SECRET'));const r=await f.call();expect(r.status_code).toBe(503);expect(JSON.stringify(r)).not.toContain('PRIVATE');
});
it('registers the read-only route and applies no-store to denial and validation responses',async()=>{
 const f=fixture();expect(f.sdk.registerTrigger).toHaveBeenCalledWith({type:'http',function_id:'api::embedding-receipts',config:{api_path:'/agentmemory/embedding/receipts',http_method:'GET'}});
 const denied=await f.call({ids:'a',preview:'true'},false);expect(denied.status_code).toBe(401);expect(denied.headers['Cache-Control']).toBe('no-store');
 const invalid=await f.call({ids:'a',preview:'true'});expect(invalid.headers['Cache-Control']).toBe('no-store');expect(f.query).not.toHaveBeenCalled();
});
async function integrated(timeoutMs=5000){
 const kv=mockKV(),sdk=mockSdk(),id='obs_a',sessionId='PRIVATE_SESSION';
 const fingerprint=createHash('sha256').update('PRIVATE_TITLE PRIVATE_BODY').digest('hex');
 await kv.set(KV.observations(sessionId),id,{id,sessionId,title:'PRIVATE_TITLE',narrative:'PRIVATE_BODY'});
 await kv.set('mem:embedding-committed:v1',id,{id,sessionId,kind:'observation',fingerprint,committedAt:'2026-10-21T00:00:00Z'});
 const get=vi.spyOn(kv,'get'),guard=createObservationReader({storePath:'/synthetic',kv:kv as never});
 const query=createEmbeddingReceiptStatus({kv:Object.assign(kv,{observationReader:guard}),KV,index:{has:()=>true},timeoutMs,
  observedPublication:()=>({fingerprint,verifiedAt:Date.parse('2026-10-22T00:00:00Z')})});
 sdk.fns.set('mem::embedding-receipts',input=>query(input as {ids:string[]}));
 registerApiTriggers(sdk as never,kv as never,'fixture-secret');
 const call=(auth=true)=>sdk.fns.get('api::embedding-receipts')!({query_params:{ids:id},headers:auth?{authorization:'Bearer fixture-secret'}:{}}) as Promise<any>;
 return{kv,get,call,id,sessionId};
}
it('integrates authenticated SDK routing with the real receipt query and mutation guard without exposing content',async()=>{
 const f=await integrated();expect((await f.call(false)).status_code).toBe(401);expect(f.get).not.toHaveBeenCalled();
 const observed=await f.call();expect(observed.status_code).toBe(200);
 expect(observed.body.items[0]).toMatchObject({id:f.id,status:'publication_verified_observed',durablePublicationObserved:true,diskVerified:false,completionConfirmed:false});
 expect(JSON.stringify(observed)).not.toMatch(/PRIVATE|fingerprint|sessionId/);
 await f.kv.set('mem:embedding-retry:v1',f.id,{id:f.id,sessionId:f.sessionId,kind:'observation',generation:'PRIVATE_NEXT'});
 const pending=await f.call();expect(pending.body.items[0]).toMatchObject({status:'pending',durablePublicationObserved:false});
 expect(JSON.stringify(pending)).not.toContain('PRIVATE');
});
it('reuses query capacity across HTTP requests when SDK reads remain hung after timeout',async()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});
 const f=await integrated(10);f.get.mockImplementation(()=>new Promise(()=>{}));
 const requests=Array.from({length:4},()=>f.call());await vi.advanceTimersByTimeAsync(10);
 for(const result of await Promise.all(requests))expect(result.body.items[0].status).toBe('unavailable');
 for(let n=0;n<8;n++)expect((await f.call()).body.items[0].status).toBe('unavailable');
 expect(f.get).toHaveBeenCalledTimes(4);
});
