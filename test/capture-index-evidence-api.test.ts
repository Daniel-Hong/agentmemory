import {expect,it,vi} from 'vitest';
import {mockKV,mockSdk} from './helpers/mocks.js';
import {registerApiTriggers} from '../src/triggers/api.js';

const key='cap_'+'a'.repeat(40),other='cap_'+'b'.repeat(40);
function fixture(secret:string|undefined='synthetic-secret'){
  const kv=mockKV(),sdk=mockSdk({looseTrigger:true}),query=vi.fn(async()=>({version:1,items:[],readOnly:true}));
  sdk.fns.set('mem::capture-index-evidence',query);
  registerApiTriggers(sdk as never,kv as never,secret);
  const call=(query_params:Record<string,unknown>={keys:key},headers:Record<string,string>={authorization:'Bearer synthetic-secret'},body:unknown=undefined)=>{
    const fn=sdk.fns.get('api::capture-index-evidence');
    return fn?fn({method:'GET',query_params,headers,body}) as Promise<any>:Promise.resolve({status_code:501,headers:{}});
  };
  return {sdk,query,call};
}
it('requires existing auth before lookup and applies no-store to denials',async()=>{
  const f=fixture(),r=await f.call({keys:key},{});
  expect(r.status_code).toBe(401);expect(r.headers['Cache-Control']).toBe('no-store');expect(f.query).not.toHaveBeenCalled();
});
it('registers the GET route and forwards only selected keys',async()=>{
  const f=fixture(),r=await f.call({keys:key+','+other},undefined,{payload:'synthetic-private-ignored'});
  expect(r.status_code).toBe(200);expect(r.headers['Cache-Control']).toBe('no-store');expect(f.query).toHaveBeenCalledExactlyOnceWith({keys:[key,other]});
  expect(f.sdk.registerTrigger).toHaveBeenCalledWith({type:'http',function_id:'api::capture-index-evidence',config:{api_path:'/agentmemory/capture/index-evidence',http_method:'GET'}});
});
it('rejects HTTP extras and malformed CSV before invoking the diagnostic',async()=>{
  const f=fixture();
  for(const q of [{},{keys:''},{keys:[key]},{keys:1},{keys:key+','},{keys:key+', '+other},{keys:key+','+key},{keys:'../bad'},{keys:key.toUpperCase()},{keys:Array.from({length:11},(_,i)=>'cap_'+i.toString(16).repeat(40)).join(',')},{keys:key,_caller_worker_id:'synthetic'},{keys:key,ids:'obs'},{keys:key,budgetMs:'5000'}]){
    const r=await f.call(q);expect(r.status_code).toBe(400);expect(r.headers['Cache-Control']).toBe('no-store');expect(r.body).toEqual({error:'INVALID_CAPTURE_INDEX_EVIDENCE_QUERY'});
  }
  expect(f.query).not.toHaveBeenCalled();
});
it('redacts failures and preserves no-store',async()=>{
  const f=fixture();f.query.mockRejectedValue(Error('synthetic-private-token-path-body'));
  const r=await f.call();expect(r).toMatchObject({status_code:503,headers:{'Cache-Control':'no-store'},body:{error:'CAPTURE_INDEX_EVIDENCE_UNAVAILABLE'}});expect(JSON.stringify(r)).not.toContain('synthetic-private');
});
it('preserves the existing unconfigured-secret read policy',async()=>{
  const f=fixture('');expect((await f.call({keys:key},{})).status_code).toBe(200);
});
