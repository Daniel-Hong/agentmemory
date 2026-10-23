import {expect,it,vi} from 'vitest';
import {mockKV,mockSdk} from './helpers/mocks.js';
const {control}=vi.hoisted(()=>({control:vi.fn(async(value:boolean)=>({ok:true,code:null,state:{enabled:value}}))}));
vi.mock('../src/functions/capture.js',async original=>({...await original<object>(),getCaptureController:()=>({setAutomaticRecoveryEnabled:control})}));
import {registerApiTriggers} from '../src/triggers/api.js';
function fixture(secret:string|undefined='fixture-secret'){
 const sdk=mockSdk({looseTrigger:true});registerApiTriggers(sdk as never,mockKV()as never,secret);
 return {sdk,call:(body:unknown,headers:Record<string,string>={authorization:'Bearer fixture-secret'},query_params={})=>sdk.fns.get('api::capture-auto-recovery-control')!({body,headers,query_params,method:'POST'})};
}
it('uses existing authentication and strict boolean-only input',async()=>{
 control.mockClear();const {call}=fixture();expect((await call({enabled:true},{})).status_code).toBe(401);
 for(const body of [null,[],{},{enabled:'true'},{enabled:true,force:true}])expect((await call(body)).status_code).toBe(400);
 expect(control).not.toHaveBeenCalled();expect((await call({enabled:false})).status_code).toBe(200);expect(control).toHaveBeenCalledWith(false);
});
it('does not expose an unauthenticated configuration path',async()=>{const {call}=fixture('');expect((await call({enabled:true})).status_code).toBe(503);});
it('returns safe guard and uncertainty outcomes without raw errors',async()=>{
 const {call}=fixture();control.mockResolvedValueOnce({ok:false,code:'HOLD_STORAGE_ERROR',state:{enabled:false}}as never);const held=await call({enabled:true});expect(held.status_code).toBe(409);expect(held.body).toMatchObject({code:'HOLD_STORAGE_ERROR'});
 control.mockRejectedValueOnce(Error('private content must not escape'));const failed=await call({enabled:false});expect(failed.status_code).toBe(503);expect(JSON.stringify(failed)).not.toContain('private content');expect(failed.headers).toMatchObject({'Cache-Control':'no-store'});
});
