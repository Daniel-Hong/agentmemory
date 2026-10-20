import {describe,it,expect} from 'vitest';
import {mockKV,mockSdk} from './helpers/mocks.js';
import {registerApiTriggers} from '../src/triggers/api.js';
import {registerCaptureFunctions} from '../src/functions/capture.js';
const id='a74320eb-bef5-4319-ab7c-dd539952c567';
function setup(){const kv=mockKV(),sdk=mockSdk({looseTrigger:true});registerCaptureFunctions(sdk as never,kv as never);registerApiTriggers(sdk as never,kv as never,'fixture-secret');return {sdk,call:(name:string,body={},query_params={},headers={authorization:'Bearer fixture-secret'})=>sdk.fns.get(name)!({headers,body,query_params})};}
describe('capture review REST boundary',()=>{
 it('enforces auth for the quarantine list and selected retry',async()=>{const {call}=setup();expect((await call('api::capture',{}, {},{})).status_code).toBe(401);expect((await call('api::capture-retry',{eventId:'evh_fixture',requestId:id},{},{})).status_code).toBe(401);});
 it('rejects malformed retry ids instead of discarding them and retrying anyway',async()=>{const {call}=setup();expect((await call('api::capture-retry',{eventId:'evh_fixture',requestId:'bad'})).status_code).toBe(400);});
 it('rejects unsafe capture keys before retrying',async()=>{const {call}=setup();expect((await call('api::capture-retry',{eventId:'evh_fixture',key:'../../data',requestId:id})).status_code).toBe(400);});
 it('rejects malformed quarantine cursors and forwards review filters',async()=>{const {call}=setup();const r=await call('api::capture',{}, {review:'true',status:'completed',cursor:'not-json'});expect(r.status_code).toBe(400);const page=await call('api::capture',{}, {review:'true',status:'completed'});expect(page.body).toMatchObject({total:0,items:[],nextCursor:null});});
});

describe('capture job REST boundary',()=>{
 it('requires auth and whitelists job selection and job IDs',async()=>{const {call}=setup();expect((await call('api::capture-jobs',{}, {},{})).status_code).toBe(401);expect((await call('api::capture-jobs-start',{requestId:id,all:true},{},{})).status_code).toBe(401);expect((await call('api::capture-jobs-stop',{jobId:id},{},{})).status_code).toBe(401);for(const body of [{requestId:'bad',all:true},{requestId:id,all:true,eventId:'evh_fixture'},{requestId:id,eventId:'evh_fixture',key:'../bad'},{requestId:id,all:true,other:'bad'}])expect((await call('api::capture-jobs-start',body)).status_code).toBe(400);expect((await call('api::capture-jobs',{}, {jobId:'bad'})).status_code).toBe(400);expect((await call('api::capture-jobs-stop',{jobId:'bad'})).status_code).toBe(400);});
 it('returns fast durable job status and idempotent no-target work',async()=>{const {call}=setup();const r=await call('api::capture-jobs-start',{requestId:id,all:true});expect(r.status_code).toBe(202);expect(r.body).toMatchObject({job:{id,status:'completed',total:0}});expect((await call('api::capture-jobs',{}, {jobId:id})).body).toMatchObject({job:{id,status:'completed'}});expect((await call('api::capture-jobs-stop',{jobId:id})).body).toMatchObject({job:{id,status:'completed'}});});
});
