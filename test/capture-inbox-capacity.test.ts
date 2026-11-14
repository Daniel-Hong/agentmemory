import {afterEach,expect,it,vi} from 'vitest';
import {mockKV,mockSdk} from './helpers/mocks.js';
import {registerCaptureFunctions} from '../src/functions/capture.js';
import {KV} from '../src/state/schema.js';
import {createStateDurabilityFence} from '../src/ops/state-durability.mjs';
vi.mock('../src/logger.js',()=>({logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}}));
const stops:(()=>void)[]=[];
afterEach(()=>{stops.splice(0).forEach(f=>f());vi.unstubAllEnvs();});
function setup(kv=mockKV(),sdkOnly=true){
 vi.stubEnv('AGENTMEMORY_CAPTURE_INBOX_MAX','1');
 if(sdkOnly)Object.assign(kv,{durability:createStateDurabilityFence({storePath:'/synthetic-capacity',completion:'sdk'})});
 const sdk=mockSdk({looseTrigger:true});sdk.fns.set('mem::observe',async(p:any)=>({observationId:p.observationId}));
 const control=registerCaptureFunctions(sdk as never,kv as never);stops.push(()=>control.stop());
 const capture=(n:number)=>sdk.trigger('mem::capture',{eventId:`capacity_event_${n}`,payload:{hookType:'post_tool_use',sessionId:'capacity',project:'synthetic',cwd:'/synthetic',timestamp:'2026-11-14T00:00:00Z',data:{tool_name:'Read',tool_output:`synthetic ${n}`}}}) as Promise<any>;
 return {kv,sdk,control,capture};
}
it('SDK completion releases pending capacity without deleting retained originals; warm and cold cache agree',async()=>{
 const f=setup();expect(await f.capture(1)).toMatchObject({status:'accepted',state:'sdk_completed'});
 const original=await f.kv.list(KV.captureInbox);expect(original).toHaveLength(1);
 expect(await f.capture(2)).toMatchObject({status:'accepted',state:'sdk_completed'});
 f.control.stop();const restarted=setup(f.kv);
 expect(await restarted.capture(3)).toMatchObject({status:'accepted',state:'sdk_completed'});
 const all=await f.kv.list<any>(KV.captureInbox);expect(all).toHaveLength(3);expect(all.find(x=>x.key===(original[0] as any).key)).toEqual(original[0]);
});
it('retained SDK records do not hide a genuinely full pending queue',async()=>{
 const f=setup();await f.capture(1);
 f.sdk.fns.set('mem::observe',async()=>{throw Error('synthetic offline');});
 expect(await f.capture(2)).toMatchObject({status:'accepted',state:'retrying'});
 expect(await f.capture(3)).toMatchObject({status:'rejected',retryable:true});
 expect(await f.kv.list(KV.captureInbox)).toHaveLength(2);
});
for(const status of ['dead','pending','retrying'])it(`unknown/non-SDK ${status} retains original admission protection`,async()=>{
 const kv=mockKV();await kv.set(KV.captureInbox,'legacy',{key:'legacy',status,acceptedAt:'2026-11-14T00:00:00Z',updatedAt:'2026-11-14T00:00:00Z',payload:{untouched:true}});
 const before=await kv.get(KV.captureInbox,'legacy');const f=setup(kv);
 expect(await f.capture(1)).toMatchObject({status:'rejected',retryable:true});expect(await kv.get(KV.captureInbox,'legacy')).toEqual(before);
});
it('partial SDK proof and unresolved review stay untouched and are not pending-capacity slots',async()=>{
 const kv=mockKV();const archived={key:'retained',status:'retrying',storageCompletion:'sdk',sdkRestoreState:'pending',sdkResolutionState:'pending',lastError:'unverified',acceptedAt:'2026-11-14T00:00:00Z',updatedAt:'2026-11-14T00:00:00Z',payload:{unknownOriginal:true}};
 await kv.set(KV.captureInbox,'retained',archived);await kv.set(KV.captureReview,'retained',{status:'unknown',failures:[{code:'UNCONFIRMED'}]});
 const f=setup(kv);await f.control.status({sdkProofPage:{offset:0,limit:1}});
 expect(await f.capture(1)).toMatchObject({status:'accepted'});expect(await kv.get(KV.captureInbox,'retained')).toEqual(archived);expect(await kv.get(KV.captureReview,'retained')).toEqual({status:'unknown',failures:[{code:'UNCONFIRMED'}]});
});
it('repeated SDK delivery and status refresh do not consume or double-release pending slots',async()=>{
 const f=setup();await f.capture(1);await f.control.status({scanInbox:true});await f.capture(1);await f.control.status({scanInbox:true});
 f.sdk.fns.set('mem::observe',async()=>{throw Error('synthetic offline');});
 expect(await f.capture(2)).toMatchObject({status:'accepted',state:'retrying'});
 expect(await f.capture(3)).toMatchObject({status:'rejected'});expect(await f.kv.list(KV.captureInbox)).toHaveLength(2);
});
it('deleting an SDK-retained tombstone in disk mode does not release another pending slot',async()=>{
 const {captureEventScope}=await import('../src/capture/event-record.js');const kv=mockKV();
 const archived={key:'archived',eventSource:'client',status:'pending',storageCompletion:'sdk',acceptedAt:'2026-11-14T00:00:00Z'};
 await kv.set(KV.captureInbox,'archived',archived);await kv.set(captureEventScope('archived'),'archived',{state:'deleted'});
 await kv.set(KV.captureInbox,'pending',{key:'pending',status:'dead',acceptedAt:'2026-11-14T00:00:00Z'});
 const f=setup(kv,false);await f.control.sweep();expect(await kv.get(KV.captureInbox,'archived')).toBeNull();
 expect(await f.capture(1)).toMatchObject({status:'rejected'});await f.control.sweep();expect(await f.capture(2)).toMatchObject({status:'rejected'});
});
it('disk completion and deleted-event retry restore exactly one available slot',async()=>{
 const {captureEventScope}=await import('../src/capture/event-record.js');const f=setup(mockKV(),false);
 expect(await f.capture(1)).toMatchObject({state:'completed'});expect(await f.capture(2)).toMatchObject({state:'completed'});
 f.sdk.fns.set('mem::observe',async()=>{throw Error('synthetic offline');});await f.capture(3);
 const [rec]=await f.kv.list<any>(KV.captureInbox);await f.kv.set(captureEventScope(rec.key),rec.key,{state:'deleted'});await f.kv.set(KV.captureInbox,rec.key,{...rec,nextAttemptAt:'2020-01-01T00:00:00Z'});
 await f.control.sweep();expect(await f.capture(4)).toMatchObject({status:'accepted',state:'retrying'});expect(await f.capture(5)).toMatchObject({status:'rejected'});
});
it('does not rescan retained metadata after each SDK completion',async()=>{
 const kv=mockKV(),list=vi.spyOn(kv,'list');const f=setup(kv);
 for(let n=1;n<=12;n++)expect(await f.capture(n)).toMatchObject({status:'accepted',state:'sdk_completed'});
 expect(list.mock.calls.filter(([scope])=>scope===KV.captureInbox)).toHaveLength(1);
 expect(kv.store.get(KV.captureInbox)?.size).toBe(12);
});
it('a stale empty status snapshot cannot erase a concurrent pending admission',async()=>{
 const f=setup();await f.capture(1);const original=f.kv.list.bind(f.kv);
 let unblock!:()=>void,seen!:()=>void;const entered=new Promise<void>(r=>seen=r),barrier=new Promise<void>(r=>unblock=r);let intercepted=false;
 f.kv.list=async (...args:any[])=>{const rows=await (original as any)(...args);if(args[0]===KV.captureInbox&&!intercepted){intercepted=true;seen();await barrier;}return rows;};
 const status=f.control.status();await entered;
 f.sdk.fns.set('mem::observe',async()=>{throw Error('synthetic offline');});
 expect(await f.capture(2)).toMatchObject({status:'accepted',state:'retrying'});unblock();await status;
 expect(await f.capture(3)).toMatchObject({status:'rejected'});
});
it('a stale pending status snapshot cannot resurrect a completed slot or overwrite a newer key',async()=>{
 const f=setup();let finishFirst!:(v:any)=>void,firstEntered!:()=>void;const firstSeen=new Promise<void>(r=>firstEntered=r);
 f.sdk.fns.set('mem::observe',async(p:any)=>{firstEntered();return new Promise(r=>finishFirst=()=>r({observationId:p.observationId}));});
 const first=f.capture(1);await firstSeen;const original=f.kv.list.bind(f.kv);let unblock!:()=>void,seen!:()=>void;const entered=new Promise<void>(r=>seen=r),barrier=new Promise<void>(r=>unblock=r);let intercepted=false;
 f.kv.list=async (...args:any[])=>{const rows=await (original as any)(...args);if(args[0]===KV.captureInbox&&!intercepted){intercepted=true;seen();await barrier;}return rows;};
 const status=f.control.status();await entered;finishFirst(null);await first;
 let finishSecond!:()=>void,secondEntered!:()=>void;const secondSeen=new Promise<void>(r=>secondEntered=r);
 f.sdk.fns.set('mem::observe',async(p:any)=>{secondEntered();return new Promise(r=>finishSecond=()=>r({observationId:p.observationId}));});
 const second=f.capture(2);await secondSeen;unblock();await status;finishSecond();await second;
 f.sdk.fns.set('mem::observe',async(p:any)=>({observationId:p.observationId}));expect(await f.capture(3)).toMatchObject({status:'accepted'});expect(f.kv.store.get(KV.captureInbox)?.size).toBe(3);
});
