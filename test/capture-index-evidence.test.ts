import {afterEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import * as evidence from '../src/capture/index-evidence.js';
import {SearchIndex} from '../src/state/search-index.js';
import {VectorIndex} from '../src/state/vector-index.js';
import {KV} from '../src/state/schema.js';
import {mockKV} from './helpers/mocks.js';

afterEach(()=>vi.useRealTimers());
const key='cap_'+'a'.repeat(40),other='cap_'+'b'.repeat(40),id='synthetic-private-observation',session='synthetic-private-session';
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
function create(kv:any,options:any){
  expect(evidence).toHaveProperty('createCaptureIndexEvidence',expect.any(Function));
  return (evidence as any).createCaptureIndexEvidence(kv,options);
}
async function fixture(){
  const kv=mockKV(),keyword=new SearchIndex(),vector=new VectorIndex();
  const observation={id,sessionId:session,captureKey:key,title:'synthetic-private-title',narrative:'synthetic-private-narrative',facts:[],concepts:[],files:[],type:'other',timestamp:'2026-10-30T00:00:00Z',importance:1,sourceRaw:{id,sessionId:session,captureKey:key,hookType:'PostToolUse',timestamp:'2026-10-30T00:00:00Z',raw:'synthetic-private-source'}};
  await kv.set(KV.captureReview,key,{key,sessionId:session,observationId:id,status:'dead',payload:'synthetic-private-history'});
  await kv.set(KV.observations(session),id,observation);await kv.set(KV.sessions,session,{id:session,title:'synthetic-private-session-title'});
  keyword.add(observation as never);vector.add(id,session,new Float32Array([1,0]));
  const originalGet=kv.get,get=vi.spyOn(kv,'get'),forbidden=[vi.spyOn(kv,'set'),vi.spyOn(kv,'delete'),vi.spyOn(kv,'list'),vi.spyOn(kv,'update'),vi.spyOn(keyword,'add'),vi.spyOn(keyword,'remove'),vi.spyOn(vector,'add'),vi.spyOn(vector,'remove')];
  const options={keyword:()=>keyword,vector:()=>vector,indexEpoch:()=>0,indexRebuilding:()=>false};
  return {kv,keyword,vector,get,originalGet,forbidden,observation,options};
}
it('distinguishes a real BM25 entry with no session from an absent entry',async()=>{
  const f=await fixture();f.keyword.add({...f.observation,sessionId:undefined} as never);
  const query=create(f.kv,f.options),a=await query({keys:[key]});
  expect(a.items[0]).toMatchObject({keywordPresent:true,keywordSessionRef:null,vectorPresent:true,vectorSessionRef:sha(session)});
  f.keyword.remove(id);expect((await query({keys:[key]})).items[0]).toMatchObject({keywordPresent:false,keywordSessionRef:null});
});
it('returns only selected keyed canonical metadata and does not mutate or enumerate',async()=>{
  const f=await fixture(),r=await create(f.kv,f.options)({keys:[key]});
  expect(r).toMatchObject({version:1,evidenceScope:'selected_capture_canonical_current_index',readOnly:true,rawOutput:false,canonicalRecordRead:true,consistency:'non_atomic_observed_stable',indexBefore:{epoch:0,rebuilding:false},indexAfter:{epoch:0,rebuilding:false}});
  expect(r.items[0]).toEqual({keyRef:sha(key),historyStatus:'dead',historyMetadataValid:true,expectedSessionRef:sha(session),observationRef:sha(id),canonicalLookupAttempted:true,canonicalRecordRead:true,canonicalPresent:true,canonicalIdMatch:true,canonicalSessionMatch:true,canonicalCaptureKeyMatch:true,sourceRecordPresent:true,sourceMetadataValid:true,titleIsString:true,titleNonempty:true,narrativeIsString:true,narrativeNonempty:true,sessionPresent:true,sessionIdMatch:true,keywordPresent:true,keywordSessionRef:sha(session),vectorPresent:true,vectorSessionRef:sha(session),evidenceStatus:'observed',unavailableCode:null});
  expect(f.get.mock.calls).toEqual([[KV.captureReview,key],[KV.observations(session),id],[KV.sessions,session]]);
  expect(JSON.stringify(r)).not.toMatch(/synthetic-private|cap_|sourceRaw|payload|sourceDigest|diskVerified|durable|completed/);
  for(const spy of f.forbidden)expect(spy).not.toHaveBeenCalled();
});
it.each([{id:'wrong'}, {sessionId:'wrong'}, {captureKey:other}])('exposes canonical identity mismatch %j without certifying repair',async patch=>{
  const f=await fixture();await f.kv.set(KV.observations(session),id,{...f.observation,...patch});
  const row=(await create(f.kv,f.options)({keys:[key]})).items[0];
  expect(row.canonicalPresent).toBe(true);expect([row.canonicalIdMatch,row.canonicalSessionMatch,row.canonicalCaptureKeyMatch]).toContain(false);expect(row).not.toHaveProperty('repaired');
});
it('distinguishes missing canonical records and missing or mismatching session records',async()=>{
  const f=await fixture(),query=create(f.kv,f.options);await f.kv.delete(KV.observations(session),id);await f.kv.delete(KV.sessions,session);
  let row=(await query({keys:[key]})).items[0];expect(row).toMatchObject({canonicalLookupAttempted:true,canonicalRecordRead:false,canonicalPresent:false,canonicalIdMatch:null,sourceRecordPresent:null,sessionPresent:false,sessionIdMatch:null,keywordPresent:true});
  await f.kv.set(KV.sessions,session,{id:'wrong'});row=(await query({keys:[key]})).items[0];expect(row).toMatchObject({sessionPresent:true,sessionIdMatch:false});
});
it.each([{title:'',narrative:'  '},{title:null,narrative:4}])('reports text type and nonempty flags without text %j',async patch=>{
  const f=await fixture();await f.kv.set(KV.observations(session),id,{...f.observation,...patch});const row=(await create(f.kv,f.options)({keys:[key]})).items[0];
  expect(row).toMatchObject({titleIsString:typeof patch.title==='string',titleNonempty:false,narrativeIsString:typeof patch.narrative==='string',narrativeNonempty:false});
});
it.each([undefined,{id,sessionId:session,captureKey:other},{id,sessionId:session,captureKey:key}])('does not infer valid source metadata from malformed or missing source %j',async sourceRaw=>{
  const f=await fixture();await f.kv.set(KV.observations(session),id,{...f.observation,sourceRaw});const row=(await create(f.kv,f.options)({keys:[key]})).items[0];expect(row.sourceMetadataValid).toBe(false);
});
it('does not access canonical payload fields or source raw bytes',async()=>{
  const f=await fixture();for(const name of ['facts','files','concepts','source','imageData'])Object.defineProperty(f.observation,name,{get(){throw Error('private-body-read');}});
  Object.defineProperty(f.observation.sourceRaw,'raw',{get(){throw Error('private-source-read');}});
  const row=(await create(f.kv,f.options)({keys:[key]})).items[0];expect(row.sourceMetadataValid).toBe(true);expect(row.unavailableCode).toBeNull();
});
it('rejects malformed queries before reading state or indexes',async()=>{
  const f=await fixture(),keyword=vi.fn(f.options.keyword),query=create(f.kv,{...f.options,keyword});
  for(const input of [null,[],{keys:[]},{keys:new Array(1)},{keys:[key,key]},{keys:[key],extra:true},{keys:[key],_caller_worker_id:'worker'},{keys:['../bad']},{keys:[key.toUpperCase()]},{keys:Array.from({length:11},(_,i)=>'cap_'+i.toString(16).repeat(40))}])await expect(query(input)).rejects.toMatchObject({code:'INVALID_CAPTURE_INDEX_EVIDENCE_QUERY'});
  expect(f.get).not.toHaveBeenCalled();expect(keyword).not.toHaveBeenCalled();
});
it('accepts only well-typed internal transport caller metadata',()=>{
  expect(evidence).toHaveProperty('captureIndexEvidenceInvocationQuery',expect.any(Function));const parse=(evidence as any).captureIndexEvidenceInvocationQuery;
  expect(parse({keys:[key],_caller_worker_id:'worker'})).toEqual({keys:[key]});
  for(const input of [{keys:[key],_caller_worker_id:1},{keys:[key],caller:'worker'},{keys:[key],_caller_worker_id:'worker',extra:true}])expect(()=>parse(input)).toThrow('INVALID_CAPTURE_INDEX_EVIDENCE_QUERY');
});
it('keeps invalid stored review identities out of namespace and index lookups',async()=>{
  const f=await fixture(),query=create(f.kv,f.options);for(const history of [null,{key,sessionId:'../bad',observationId:id,status:'dead'},{key:other,sessionId:session,observationId:id,status:'dead'},{key,sessionId:session,observationId:'',status:'private-unknown'}]){
    await f.kv.set(KV.captureReview,key,history);f.get.mockClear();const row=(await query({keys:[key]})).items[0];expect(row).toMatchObject({historyMetadataValid:false,canonicalPresent:null,keywordPresent:null,unavailableCode:'CAPTURE_INDEX_EVIDENCE_HISTORY_UNAVAILABLE'});expect(f.get.mock.calls).toEqual([[KV.captureReview,key]]);
  }
});
it('sanitizes keyed read errors per item and continues selected keys',async()=>{
  const f=await fixture();f.get.mockImplementation((scope,k)=>k===key?Promise.reject(Error('synthetic-private-token-path')):f.originalGet(scope,k));
  const r=await create(f.kv,f.options)({keys:[key,other]});expect(r.items).toHaveLength(2);expect(r.items[0].unavailableCode).toBe('CAPTURE_INDEX_EVIDENCE_READ_UNAVAILABLE');expect(r.items[1].historyStatus).toBe('absent');expect(JSON.stringify(r)).not.toContain('synthetic-private');
});
it('holds the busy slot after timeout until the one outstanding read settles',async()=>{
  vi.useFakeTimers();const f=await fixture();let release!:(value:any)=>void;f.get.mockImplementation(()=>new Promise(r=>release=r));const query=create(f.kv,{...f.options,budgetMs:10});
  const first=query({keys:[key,other]});await vi.advanceTimersByTimeAsync(10);const r=await first;expect(r.items.map((row:any)=>row.unavailableCode)).toEqual(['CAPTURE_INDEX_EVIDENCE_TIMEOUT','CAPTURE_INDEX_EVIDENCE_TIMEOUT']);expect(f.get).toHaveBeenCalledTimes(1);
  await expect(query({keys:[key]})).rejects.toMatchObject({code:'CAPTURE_INDEX_EVIDENCE_BUSY'});expect(f.get).toHaveBeenCalledTimes(1);
  release(null);await vi.advanceTimersByTimeAsync(1);f.get.mockResolvedValue(null);expect((await query({keys:[key]})).items[0].historyStatus).toBe('absent');
});
it('marks a timed-out canonical full-record lookup unknown and starts no session lookup',async()=>{
  vi.useFakeTimers();const f=await fixture();f.get.mockImplementation(async(scope)=>scope===KV.captureReview?{key,sessionId:session,observationId:id,status:'dead'}:new Promise(()=>{}));
  const first=create(f.kv,{...f.options,budgetMs:10})({keys:[key]});await vi.advanceTimersByTimeAsync(10);const r=await first;expect(r).toMatchObject({canonicalRecordRead:null,items:[{canonicalLookupAttempted:true,canonicalRecordRead:null,canonicalPresent:null,unavailableCode:'CAPTURE_INDEX_EVIDENCE_TIMEOUT'}]});expect(f.get).toHaveBeenCalledTimes(2);
});
it('releases the busy slot after rejection and refuses invalid budgets',async()=>{
  const f=await fixture(),query=create(f.kv,f.options);f.get.mockRejectedValueOnce(Error('private'));await query({keys:[key]});await query({keys:[key]});
  for(const budgetMs of [0,5001,1.1,Infinity])expect(()=>create(f.kv,{...f.options,budgetMs})).toThrow('INVALID_CAPTURE_INDEX_EVIDENCE_BUDGET');
});
it('keeps process epochs stable and separates new helper instances',async()=>{
  const f=await fixture(),query=create(f.kv,f.options),a=await query({keys:[key]}),b=await query({keys:[key]});expect(a.processEpoch).toMatch(/^[a-f0-9-]{36}$/);expect(b.processEpoch).toBe(a.processEpoch);expect((await create(f.kv,f.options)({keys:[key]})).processEpoch).not.toBe(a.processEpoch);
});
it('marks changed rebuild epochs or rebuilding states uncertain',async()=>{
  const f=await fixture();let epoch=0,rebuilding=false;f.get.mockImplementation(async(scope,k)=>{const result=await f.originalGet(scope,k);epoch++;return result;});
  const query=create(f.kv,{...f.options,indexEpoch:()=>epoch,indexRebuilding:()=>rebuilding});let r=await query({keys:[key]});expect(r.consistency).toBe('changed');expect(r.items[0]).toMatchObject({evidenceStatus:'changed',unavailableCode:'CAPTURE_INDEX_EVIDENCE_INDEX_CHANGED'});
  rebuilding=true;r=await query({keys:[key]});expect(r.indexBefore.rebuilding).toBe(true);expect(r.consistency).toBe('changed');
});
it('rechecks earlier selected index values after subsequent awaited reads',async()=>{
  const f=await fixture();await f.kv.set(KV.captureReview,other,{key:other,sessionId:session,observationId:id,status:'dead'});
  f.get.mockImplementation(async(scope,k)=>{const result=await f.originalGet(scope,k);if(k===other)f.keyword.remove(id);return result;});
  const r=await create(f.kv,f.options)({keys:[key,other]});expect(r.items[0]).toMatchObject({keywordPresent:true,evidenceStatus:'changed',unavailableCode:'CAPTURE_INDEX_EVIDENCE_INDEX_CHANGED'});expect(r.consistency).toBe('changed');
});
it('marks unavailable indexes and getter exceptions unknown without exposing errors',async()=>{
  const f=await fixture();const r=await create(f.kv,{...f.options,keyword:()=>{throw Error('synthetic-private-token');},vector:()=>null,indexEpoch:()=>{throw Error('synthetic-private-path');}})({keys:[key]});expect(r).toMatchObject({consistency:'unavailable',indexBefore:{epoch:null},items:[{keywordPresent:null,vectorPresent:null,evidenceStatus:'unavailable',unavailableCode:'CAPTURE_INDEX_EVIDENCE_INDEX_UNAVAILABLE'}]});expect(JSON.stringify(r)).not.toContain('synthetic-private');
});
it('preserves known BM25 has evidence when only session lookup fails',async()=>{
  const f=await fixture();vi.spyOn(f.keyword,'sessionOf').mockImplementation(()=>{throw Error('synthetic-private-owner');});
  const r=await create(f.kv,f.options)({keys:[key]});expect(r.items[0]).toMatchObject({keywordPresent:true,keywordSessionRef:null,evidenceStatus:'unavailable',unavailableCode:'CAPTURE_INDEX_EVIDENCE_INDEX_UNAVAILABLE'});
});
it.each(['../owner-a','',undefined,7])('marks a present vector with invalid owner metadata unavailable: %j',async owner=>{
  const f=await fixture();f.vector.add(id,owner as never,new Float32Array([1,0]));
  const r=await create(f.kv,f.options)({keys:[key]});
  expect(r).toMatchObject({consistency:'unavailable',items:[{keywordPresent:true,vectorPresent:true,vectorSessionRef:null,evidenceStatus:'unavailable',unavailableCode:'CAPTURE_INDEX_EVIDENCE_INDEX_UNAVAILABLE'}]});
  expect(JSON.stringify(r)).not.toMatch(/owner-a|synthetic-private/);
});
it('does not report stable evidence when malformed vector owners change during canonical reads',async()=>{
  const f=await fixture();f.vector.add(id,'../owner-a',new Float32Array([1,0]));
  f.get.mockImplementation(async(scope,k)=>{
    const result=await f.originalGet(scope,k);
    if(scope===KV.observations(session))f.vector.add(id,'../owner-b',new Float32Array([1,0]));
    return result;
  });
  const r=await create(f.kv,f.options)({keys:[key]});
  expect(r).toMatchObject({consistency:'unavailable',items:[{vectorPresent:true,vectorSessionRef:null,evidenceStatus:'unavailable',unavailableCode:'CAPTURE_INDEX_EVIDENCE_INDEX_UNAVAILABLE'}]});
  expect(JSON.stringify(r)).not.toMatch(/owner-a|owner-b|synthetic-private/);
});
it('freezes the validated selected keys before the first awaited read',async()=>{
  const f=await fixture(),keys=[key];f.get.mockImplementation(async(scope,k)=>{keys.push('../private-arbitrary');return f.originalGet(scope,k);});
  const r=await create(f.kv,f.options)({keys});expect(r.items).toHaveLength(1);expect(f.get.mock.calls).toEqual([[KV.captureReview,key],[KV.observations(session),id],[KV.sessions,session]]);
});
it('accepts ten distinct keys with sequential keyed reads and bounded metadata only',async()=>{
  const f=await fixture(),keys=Array.from({length:10},(_,i)=>'cap_'+i.toString(16).repeat(40));const r=await create(f.kv,f.options)({keys});expect(r.items).toHaveLength(10);expect(f.get).toHaveBeenCalledTimes(10);expect(JSON.stringify(r).length).toBeLessThan(16000);
});
it('registers the mem boundary with transport stripping and works while background work is paused',async()=>{
  const f=await fixture(),{registerCaptureFunctions}=await import('../src/functions/capture.js'),{mockSdk}=await import('./helpers/mocks.js'),{installBackgroundControl}=await import('../src/ops/background-control.mjs');
  const sdk=mockSdk({looseTrigger:true}),blocked=vi.fn(async()=>{throw Error('background-work-must-stay-paused');});
  installBackgroundControl({isPaused:()=>true,run:blocked} as never);
  const controller=registerCaptureFunctions(sdk as never,f.kv as never,{durableAfterMs:0});
  try{
    expect(sdk.fns.has('mem::capture-index-evidence')).toBe(true);
    const fn=sdk.fns.get('mem::capture-index-evidence')!;
    const result:any=await fn({keys:[key],_caller_worker_id:'synthetic-private-worker'});expect(result.items).toHaveLength(1);expect(result.rawOutput).toBe(false);expect(JSON.stringify(result)).not.toContain('synthetic-private');
    f.get.mockClear();for(const input of [{keys:[key],_caller_worker_id:1},{keys:[key],extra:true}])await expect(fn(input)).rejects.toMatchObject({code:'INVALID_CAPTURE_INDEX_EVIDENCE_QUERY'});
    expect(f.get).not.toHaveBeenCalled();expect(blocked).not.toHaveBeenCalled();for(const spy of f.forbidden)expect(spy).not.toHaveBeenCalled();
  }finally{controller.stop();installBackgroundControl(null);}
});
