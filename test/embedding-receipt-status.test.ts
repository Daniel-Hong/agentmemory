import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createEmbeddingReceiptStatus } from '../src/ops/embedding-receipt-status.mjs';
import { createObservationReader } from '../src/ops/observation-pages.mjs';

const RETRY='mem:embedding-retry:v1', COMMITTED='mem:embedding-committed:v1';
const KV={memories:'mem:memories',observations:(id:string)=>'mem:obs:'+id,vectorPendingLog:'mem:index:vec-pending'};
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
afterEach(()=>vi.useRealTimers());
function fixture() {
  const rows=new Map<string,unknown>(), revisions=new Map<string,number>(), pending=new Set<string>();
  const set=(scope:string,id:string,row:unknown)=>rows.set(scope+'/'+id,row);
  const kv={get:vi.fn(async(scope:string,id:string)=>rows.get(scope+'/'+id)??null),
    observationReader:{tracksMutations:(_scope:string)=>true,mutationRevision:(scope:string)=>revisions.get(scope)??0,pendingMutations:(scope:string)=>pending.has(scope)?1:0}};
  const index={has:vi.fn(()=>true)};
  const marker={id:'obs_1',sessionId:'PRIVATE_SESSION',kind:'observation',fingerprint:hash('PRIVATE_TITLE PRIVATE_BODY'),committedAt:'2026-10-21T00:00:00.000Z'};
  set(COMMITTED,'obs_1',marker);
  set(KV.observations(marker.sessionId),'obs_1',{id:'obs_1',sessionId:marker.sessionId,title:'PRIVATE_TITLE',narrative:'PRIVATE_BODY'});
  return {rows,set,kv,index,marker,revisions,pending,query:createEmbeddingReceiptStatus({kv,KV,index})};
}
it('reports current marker metadata without claiming independent durable completion or returning private data',async()=>{
  const f=fixture(), result=await f.query({ids:['obs_1']});
  expect(result).toEqual({version:1,evidence:'metadata_only',items:[{id:'obs_1',status:'committed_metadata',retryPhase:null,attempts:null,retryAt:null,committedAt:'2026-10-21T00:00:00.000Z',diskVerified:false,completionConfirmed:false,durablePublicationObserved:false,verifiedAt:null,evidenceScope:'metadata_only'}]});
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|fingerprint|generation|sessionId/);
  expect(f.kv.get).toHaveBeenCalledTimes(7);
});
it('pending or newer generation always wins over a prior committed marker without reading a body',async()=>{
  const f=fixture();f.set(RETRY,'obs_1',{...f.marker,generation:'PRIVATE_NEW',phase:'embedded',attempts:2,retryAt:123,errorCode:'PRIVATE_ERROR'});
  const item=(await f.query({ids:['obs_1']})).items[0];
  expect(item).toMatchObject({status:'pending',retryPhase:'embedded',attempts:2,retryAt:123,completionConfirmed:false});
  expect(f.kv.get.mock.calls.every(([scope])=>scope===RETRY||scope===COMMITTED)).toBe(true);
  expect(JSON.stringify(item)).not.toContain('PRIVATE');
});
it.each(['projection_mismatch','canonical_missing','index_missing','index_pending'] as const)('does not confirm %s',async status=>{
  const f=fixture();
  if(status==='projection_mismatch')f.set(KV.observations(f.marker.sessionId),'obs_1',{id:'obs_1',sessionId:f.marker.sessionId,title:'changed'});
  if(status==='canonical_missing')f.rows.delete(KV.observations(f.marker.sessionId)+'/obs_1');
  if(status==='index_missing')f.index.has.mockReturnValue(false);
  if(status==='index_pending')f.set(KV.vectorPendingLog,'obs_1',{e:'PRIVATE_VECTOR'});
  expect((await f.query({ids:['obs_1']})).items[0]).toMatchObject({status,diskVerified:false,completionConfirmed:false});
});
it('treats a pending index clear as unpublished',async()=>{
  const f=fixture();f.set(KV.vectorPendingLog,'~clear',{c:1});
  expect((await f.query({ids:['obs_1']})).items[0].status).toBe('index_pending');
});
it('reads the exact bounded memory projection and treats superseded memories as absent',async()=>{
  const f=fixture(),title='x'.repeat(16001);
  f.set(COMMITTED,'mem_1',{...f.marker,id:'mem_1',kind:'memory',fingerprint:hash(title.slice(0,16000))});
  f.set(KV.memories,'mem_1',{id:'mem_1',title,content:'PRIVATE'});
  expect((await f.query({ids:['mem_1']})).items[0].status).toBe('committed_metadata');
  f.set(KV.memories,'mem_1',{id:'mem_1',title,isLatest:false});
  expect((await f.query({ids:['mem_1']})).items[0].status).toBe('canonical_missing');
});
it.each(['source','retry','commit','index'] as const)('fails closed on concurrent %s mutations',async which=>{
  const f=fixture(),scope={source:KV.observations(f.marker.sessionId),retry:RETRY,commit:COMMITTED,index:KV.vectorPendingLog}[which];
  const get=f.kv.get.getMockImplementation()!;
  f.kv.get.mockImplementation(async(s,k)=>{const row=await get(s,k);if(s===KV.observations(f.marker.sessionId))f.revisions.set(scope,1);return row;});
  expect((await f.query({ids:['obs_1']})).items[0].status).toBe('unavailable');
});
it('detects a new retry generation while inspecting the canonical projection',async()=>{
  const f=fixture(),get=f.kv.get.getMockImplementation()!;
  f.kv.get.mockImplementation(async(s,k)=>{const row=await get(s,k);if(s===KV.observations(f.marker.sessionId))f.set(RETRY,k,{...f.marker,generation:'new'});return row;});
  expect((await f.query({ids:['obs_1']})).items[0].status).toBe('unavailable');
});
it('fails closed when guard/index capabilities are absent, a mutation is pending, or SDK read fails',async()=>{
  for(const mode of ['guard','index','pending','error']) {
    const f=fixture();
    if(mode==='guard')(f.kv as any).observationReader=null;
    if(mode==='index')(f.index as any).has=null;
    if(mode==='pending')f.pending.add(COMMITTED);
    if(mode==='error')f.kv.get.mockRejectedValue(Error('PRIVATE_ERROR'));
    const result=await f.query({ids:['obs_1']});
    expect(result.items[0].status).toBe('unavailable');expect(JSON.stringify(result)).not.toContain('PRIVATE');
  }
});
it('does not trust malformed marker identity or a canonical session mismatch',async()=>{
  const f=fixture();f.set(COMMITTED,'obs_1',{...f.marker,id:'other'});
  expect((await f.query({ids:['obs_1']})).items[0].status).toBe('unavailable');
  f.set(COMMITTED,'obs_1',f.marker);f.set(KV.observations(f.marker.sessionId),'obs_1',{id:'obs_1',sessionId:'other',title:'PRIVATE_TITLE',narrative:'PRIVATE_BODY'});
  expect((await f.query({ids:['obs_1']})).items[0].status).toBe('unavailable');
});
it('returns not_found for absent markers and validates the complete bounded query before any reads',async()=>{
  const f=fixture();expect((await f.query({ids:['absent']})).items[0].status).toBe('not_found');f.kv.get.mockClear();
  for(const ids of [[],Array.from({length:33},(_,n)=>'id_'+n),['obs_1','obs_1'],['a\nb'],['a'.repeat(257)]])
    await expect(f.query({ids})).rejects.toMatchObject({code:'EMBEDDING_RECEIPT_QUERY_INVALID'});
  expect(f.kv.get).not.toHaveBeenCalled();
  expect((await f.query({ids:Array.from({length:32},(_,n)=>'id_'+n)})).items).toHaveLength(32);
  expect(f.kv.get.mock.calls.length).toBeLessThanOrEqual(32*7);
});
it('distinguishes a trusted publication observed in this process from an independent current disk verification',async()=>{
  const f=fixture(),observedPublication=vi.fn(()=>({fingerprint:f.marker.fingerprint,verifiedAt:Date.parse('2026-10-22T00:00:00Z')}));
  const query=createEmbeddingReceiptStatus({...f,KV,observedPublication});
  const item=(await query({ids:['obs_1']})).items[0];
  expect(item).toMatchObject({status:'publication_verified_observed',durablePublicationObserved:true,verifiedAt:'2026-10-22T00:00:00.000Z',evidenceScope:'this_process_observation',diskVerified:false,completionConfirmed:false});
  expect(JSON.stringify(item)).not.toContain(f.marker.fingerprint);
  expect(observedPublication).toHaveBeenCalledWith('obs_1');
});
it.each(['absent','mismatch','invalid_time','older_marker'] as const)('does not promote %s runtime evidence',async mode=>{
  const f=fixture();
  const proof=mode==='absent'?null:{fingerprint:mode==='mismatch'?hash('stale'):f.marker.fingerprint,verifiedAt:mode==='invalid_time'?'PRIVATE_TIME':mode==='older_marker'?'2026-10-20T00:00:00Z':'2026-10-22T00:00:00Z'};
  const query=createEmbeddingReceiptStatus({...f,KV,observedPublication:()=>proof});
  expect((await query({ids:['obs_1']})).items[0]).toMatchObject({status:'committed_metadata',durablePublicationObserved:false,verifiedAt:null});
});
it('never consults runtime proof when retry or index publication is pending',async()=>{
  for(const scope of [RETRY,KV.vectorPendingLog]) {
    const f=fixture();f.set(scope,'obs_1',scope===RETRY?{...f.marker,generation:'new'}:{q:1});
    const observedPublication=vi.fn(()=>({fingerprint:f.marker.fingerprint,verifiedAt:Date.now()}));
    const query=createEmbeddingReceiptStatus({...f,KV,observedPublication});
    expect((await query({ids:['obs_1']})).items[0].durablePublicationObserved).toBe(false);
    expect(observedPublication).not.toHaveBeenCalled();
  }
});
it('fails closed if runtime proof lookup fails or mutates a guarded scope',async()=>{
  for(const mode of ['throw','change']) {
    const f=fixture(),observedPublication=()=>{
      if(mode==='throw')throw Error('PRIVATE_RUNTIME_ERROR');
      f.revisions.set(RETRY,1);return {fingerprint:f.marker.fingerprint,verifiedAt:Date.now()};
    };
    expect((await createEmbeddingReceiptStatus({...f,KV,observedPublication})({ids:['obs_1']})).items[0].status).toBe('unavailable');
  }
});
it('snapshots validated IDs so an asynchronous caller cannot enlarge or change the request',async()=>{
  const f=fixture(),ids=['obs_1'],get=f.kv.get.getMockImplementation()!;
  f.kv.get.mockImplementation(async(s,k)=>{if(ids.length===1)ids.push('PRIVATE_ADDED');return get(s,k);});
  const result=await f.query({ids});
  expect(result.items).toHaveLength(1);
  expect(f.kv.get.mock.calls.every(([,id])=>id==='obs_1'||id==='~clear')).toBe(true);
});
it('requires affirmative tracking for every guarded scope, not merely zero revisions',async()=>{
  for(const scope of [RETRY,COMMITTED,KV.vectorPendingLog,KV.observations('PRIVATE_SESSION')]) {
    const f=fixture();f.kv.observationReader.tracksMutations=s=>s!==scope;
    expect((await f.query({ids:['obs_1']})).items[0].status).toBe('unavailable');
  }
  const f=fixture();delete (f.kv.observationReader as any).tracksMutations;
  expect((await f.query({ids:['obs_1']})).items[0].status).toBe('unavailable');
  expect(f.kv.get).not.toHaveBeenCalled();
});
it('uses the real reader capability to reject metadata changes during a synthetic SDK query',async()=>{
  const f=fixture(),guard=createObservationReader({storePath:'/synthetic',kv:f.kv as never});
  f.kv.observationReader=guard;
  expect((await f.query({ids:['obs_1']})).items[0].status).toBe('committed_metadata');
  const get=f.kv.get.getMockImplementation()!;
  f.kv.get.mockImplementation(async(scope,id)=>{
    const row=await get(scope,id);
    if(scope===KV.observations('PRIVATE_SESSION'))guard.beginMutation(COMMITTED)();
    return row;
  });
  expect((await f.query({ids:['obs_1']})).items[0].status).toBe('unavailable');
});
it('caps one total query budget and stops SDK reads for remaining items after timeout',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});
  const f=fixture(),get=f.kv.get.getMockImplementation()!;
  f.kv.get.mockImplementation(async(s,k)=>{await new Promise(resolve=>setTimeout(resolve,12));return get(s,k);});
  const query=createEmbeddingReceiptStatus({...f,KV,timeoutMs:20});
  let settled=false;const result=query({ids:['obs_1','next','last']}).then(value=>{settled=true;return value;});
  await vi.advanceTimersByTimeAsync(20);
  expect(settled).toBe(true);
  expect((await result).items.map(item=>item.status)).toEqual(['unavailable','unavailable','unavailable']);
  expect(f.kv.get).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(100);
  expect(f.kv.get).toHaveBeenCalledTimes(2);
});
it('keeps four outstanding SDK slots across timed-out queries until their actual promises settle',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});
  const f=fixture(),release:Array<(value:unknown)=>void>=[];
  f.kv.get.mockImplementation(()=>new Promise(resolve=>release.push(resolve)));
  const query=createEmbeddingReceiptStatus({...f,KV,timeoutMs:10});
  let settled=0;const requests=Array.from({length:4},()=>query({ids:['obs_1']}).then(value=>{settled++;return value;}));
  await vi.advanceTimersByTimeAsync(10);
  expect(settled).toBe(4);expect(f.kv.get).toHaveBeenCalledTimes(4);
  await Promise.all(requests);
  for(let n=0;n<8;n++)expect((await query({ids:['obs_1']})).items[0].status).toBe('unavailable');
  expect(f.kv.get).toHaveBeenCalledTimes(4);
  release.splice(0).forEach(resolve=>resolve(null));await vi.advanceTimersByTimeAsync(0);
  f.kv.get.mockResolvedValue(null);
  expect((await query({ids:['obs_1']})).items[0].status).toBe('not_found');
  expect(f.kv.get).toHaveBeenCalledTimes(8);
});
it('defaults to a five-second budget and rejects configurations above the hard cap',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});
  const f=fixture();f.kv.get.mockImplementation(()=>new Promise(()=>{}));
  let settled=false;const result=f.query({ids:['obs_1']}).then(value=>{settled=true;return value;});
  await vi.advanceTimersByTimeAsync(4999);expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);expect(settled).toBe(true);
  expect((await result).items[0].status).toBe('unavailable');
  for(const timeoutMs of [0,5001,Infinity,1.5])expect(()=>createEmbeddingReceiptStatus({...f,KV,timeoutMs})).toThrow('embedding_receipt_timeout_invalid');
});
it('releases SDK slots after rejection and suppresses late rejected SDK promises',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});
  const f=fixture();let reject!:(error:Error)=>void;
  f.kv.get.mockImplementation(()=>new Promise((_resolve,no)=>{reject=no;}));
  const query=createEmbeddingReceiptStatus({...f,KV,timeoutMs:10});
  let settled=false;const result=query({ids:['obs_1']}).then(value=>{settled=true;return value;});
  await vi.advanceTimersByTimeAsync(10);expect(settled).toBe(true);await result;
  reject(Error('PRIVATE_LATE_ERROR'));await vi.advanceTimersByTimeAsync(0);
  f.kv.get.mockRejectedValue(Error('PRIVATE_READ_ERROR'));
  for(let n=0;n<6;n++)expect((await query({ids:['obs_1']})).items[0].status).toBe('unavailable');
  f.kv.get.mockResolvedValue(null);
  expect((await query({ids:['obs_1']})).items[0].status).toBe('not_found');
});
