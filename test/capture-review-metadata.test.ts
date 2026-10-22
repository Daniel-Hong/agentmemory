import {afterEach,expect,it,vi} from 'vitest';
import {createCaptureReviewMetadata} from '../src/capture/review-metadata.js';
import {KV} from '../src/state/schema.js';
import {captureEventScope} from '../src/capture/event-record.js';
import {mockKV} from './helpers/mocks.js';
afterEach(()=>vi.useRealTimers());
const key='cap_'+'a'.repeat(40),id='synthetic-private-observation',session='synthetic-private-session';
function history(k=key){return {key:k,eventId:'synthetic-private-event',sessionId:session,project:'synthetic-private-project',hookType:'synthetic',observationId:id,status:'dead',totalAttempts:6,cycleAttempts:6,manualRetries:0,acceptedAt:'2026-10-22T00:00:00Z',updatedAt:'2026-10-22T01:00:00Z',failures:[{code:'CAPTURE_STORE_FAILED',at:'2026-10-22T01:00:00Z',attempt:6}],requests:{}};}
async function fixture(){const kv=mockKV();await kv.set(KV.captureReview,key,history());const originalGet=kv.get,originalList=kv.list;
 const get=vi.spyOn(kv,'get').mockImplementation(async(scope,k)=>{if(scope===KV.captureInbox||scope.startsWith('mem:obs:'))throw Error('BODY_READ_FORBIDDEN');return originalGet(scope,k);});
 const list=vi.spyOn(kv,'list').mockImplementation(async scope=>{if(scope!==KV.captureReview)throw Error('BODY_LIST_FORBIDDEN');return originalList(scope);});
 const writes=[vi.spyOn(kv,'set'),vi.spyOn(kv,'update'),vi.spyOn(kv,'delete')];return{kv,get,list,writes,query:createCaptureReviewMetadata(kv as never)};
}
it('returns only nonidentifying metadata and leaves canonical/inbox certainty unknown',async()=>{
 const f=await fixture();const result=await f.query({status:'dead'});expect(result.items).toHaveLength(1);expect(result.items[0]).toMatchObject({recordedStatus:'dead',attempts:6,failureCode:'CAPTURE_STORE_FAILED',canonicalState:'not_checked',inboxState:'not_checked',retryIntent:'absent',completionReceipt:'absent',nextStep:'verify_source_and_inbox',retryAuthorized:false});
 expect(JSON.stringify(result)).not.toMatch(/synthetic-private|sessionId|project|fingerprint|digest|preview|sourceRaw|payload/);expect(f.list).toHaveBeenCalledWith(KV.captureReview);for(const spy of f.writes)expect(spy).not.toHaveBeenCalled();
});
it('distinguishes deletion and historical completion without certifying or replaying',async()=>{
 const f=await fixture();await f.kv.set(captureEventScope(key),key,{...history(),state:'deleted'});f.writes.forEach(s=>s.mockClear());expect((await f.query()).items[0]).toMatchObject({completionReceipt:'deleted',nextStep:'respect_deletion',retryAuthorized:false});
 await f.kv.set(captureEventScope(key),key,{...history(),state:undefined});f.writes.forEach(s=>s.mockClear());expect((await f.query()).items[0]).toMatchObject({completionReceipt:'completed_metadata',nextStep:'verify_existing_completion',diskVerified:false});for(const spy of f.writes)expect(spy).not.toHaveBeenCalled();
});
it('reports current intent and marker as metadata only and never returns generation or digest',async()=>{
 const f=await fixture();await f.kv.set(KV.embeddingRetry,id,{id,sessionId:session,generation:'synthetic-private-generation',phase:'embedded',fingerprint:'synthetic-private-digest'});await f.kv.set(KV.embeddingCommitted,id,{id,sessionId:session,fingerprint:'synthetic-private-digest'});f.writes.forEach(s=>s.mockClear());const result=await f.query();expect(result.items[0]).toMatchObject({retryIntent:'present',intentPhase:'embedded',publicationMarker:'present_unverified'});expect(JSON.stringify(result)).not.toContain('synthetic-private');for(const spy of f.writes)expect(spy).not.toHaveBeenCalled();
});
it('keeps stable nonidentifying refs within one instance but rejects old refs after restart',async()=>{
 const f=await fixture();const a=await f.query(),b=await f.query();expect(a.items[0].reviewRef).toBe(b.items[0].reviewRef);expect((await f.query({reviewRef:String(a.items[0].reviewRef)})).items).toHaveLength(1);const restarted=createCaptureReviewMetadata(f.kv as never);await expect(restarted({reviewRef:String(a.items[0].reviewRef)})).rejects.toMatchObject({code:'CAPTURE_METADATA_REFERENCE_UNKNOWN'});
});
it('rejects unknown filters and unsafe pagination before reads',async()=>{
 const f=await fixture();for(const input of [{status:'other'},{limit:51},{limit:0},{offset:-1},{offset:5001},{reviewRef:'../bad'},{preview:true}])await expect(f.query(input as never)).rejects.toMatchObject({code:'INVALID_CAPTURE_METADATA_QUERY'});expect(f.list).not.toHaveBeenCalled();expect(f.get).not.toHaveBeenCalled();
});
it('holds its slot for an uncancellable metadata read after timeout',async()=>{
 vi.useFakeTimers();const kv=mockKV();let release!:(v:any)=>void;const list=vi.spyOn(kv,'list').mockImplementation(()=>new Promise(r=>release=r));const query=createCaptureReviewMetadata(kv as never,{budgetMs:10});const first=query().catch(e=>e.code);await vi.advanceTimersByTimeAsync(10);expect(await first).toBe('CAPTURE_METADATA_UNAVAILABLE');await expect(query()).rejects.toMatchObject({code:'CAPTURE_METADATA_BUSY'});expect(list).toHaveBeenCalledTimes(1);release([]);await vi.advanceTimersByTimeAsync(1);list.mockResolvedValue([]);await query();
});
it('never touches preview, payload, source text, request bodies or fingerprints in history',async()=>{
 const f=await fixture(),row=history();for(const name of ['preview','payload','sourceRaw','fingerprint','requests'])Object.defineProperty(row,name,{get(){throw Error('BODY_FIELD_READ_FORBIDDEN');}});await f.kv.set(KV.captureReview,key,row);f.writes.forEach(s=>s.mockClear());const r=await f.query();expect(r.items).toHaveLength(1);expect(r.sourceRead).toBe(false);expect(r.inboxRead).toBe(false);for(const spy of f.writes)expect(spy).not.toHaveBeenCalled();
});
it('distinguishes identity conflicts from absence and does not endorse a retry',async()=>{
 const f=await fixture();await f.kv.set(KV.embeddingRetry,id,{id:'synthetic-private-other',sessionId:session});const r=await f.query();expect(r.items[0]).toMatchObject({retryIntent:'identity_conflict',nextStep:'investigate_identity',retryAuthorized:false});expect(JSON.stringify(r)).not.toContain('synthetic-private');
});
it('labels lookup errors unknown without echoing private errors or authorizing retry',async()=>{
 const f=await fixture();f.get.mockRejectedValue(Error('synthetic-private-body-token-digest'));const r=await f.query();expect(r.items[0]).toMatchObject({nextStep:'metadata_unavailable',completionReceipt:'unavailable',retryAuthorized:false});expect(JSON.stringify(r)).not.toContain('synthetic-private');
});
it('paginates recorded history with only nonidentifying refs and keeps invalid rows explicit',async()=>{
 const f=await fixture();for(const char of ['b','c'])await f.kv.set(KV.captureReview,'cap_'+char.repeat(40),history('cap_'+char.repeat(40)));await f.kv.set(KV.captureReview,'invalid',{...history(),key:'synthetic-private-invalid'});const a=await f.query({limit:2}),b=await f.query({offset:2,limit:2});expect(a).toMatchObject({totalRecorded:3,invalidMetadataRows:1,nextOffset:2});expect(b.items).toHaveLength(1);expect(b.nextOffset).toBeNull();expect(new Set([...a.items,...b.items].map(i=>i.reviewRef)).size).toBe(3);expect(JSON.stringify([a,b])).not.toContain('synthetic-private');
});
it('refuses oversized metadata lists rather than silently claiming complete coverage',async()=>{
 const f=await fixture();f.list.mockResolvedValue(Array.from({length:5001},()=>history()));await expect(f.query()).rejects.toMatchObject({code:'CAPTURE_METADATA_UNAVAILABLE'});expect(f.get).not.toHaveBeenCalled();
});
it('never calls missing metadata identities a matching completion',async()=>{
 const f=await fixture(),h:any=history();delete h.observationId;delete h.sessionId;await f.kv.set(KV.captureReview,key,h);await f.kv.set(captureEventScope(key),key,{key});const r=await f.query();expect(r.items[0]).toMatchObject({completionReceipt:'identity_conflict',nextStep:'investigate_identity',retryAuthorized:false});
});
it('does not accept an unknown receipt state as completion',async()=>{
 const f=await fixture();await f.kv.set(captureEventScope(key),key,{...history(),state:'synthetic-unsupported'});expect((await f.query()).items[0]).toMatchObject({completionReceipt:'unavailable',nextStep:'metadata_unavailable'});
});
it('does not call intent or marker identities present when both session fields are missing',async()=>{
 const f=await fixture(),h:any=history();delete h.sessionId;await f.kv.set(KV.captureReview,key,h);await f.kv.set(KV.embeddingRetry,id,{id});await f.kv.set(KV.embeddingCommitted,id,{id});const r=await f.query();expect(r.items[0]).toMatchObject({retryIntent:'unavailable',publicationMarker:'unavailable',nextStep:'metadata_unavailable',retryAuthorized:false});
});
