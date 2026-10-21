import {expect,it} from 'vitest';
import {createBackgroundControl,registerBackgroundControlApi} from '../src/ops/background-control.mjs';
import {createMemoryPressureGuard} from '../src/ops/memory-pressure.mjs';
const GiB=1024**3;
function fixture(saved:any=null){let record=saved,now=1000,available=GiB;let fail=false;
 const kv:any={get:async()=>record,set:async(_:any,__:any,v:any)=>{if(fail)throw Error('synthetic');record=structuredClone(v);},durability:{wait:async()=>({synced:true,mutationFailures:0}),waitForKeys:async()=>{}}};
 const control=createBackgroundControl({clock:()=>now});
 const guard=createMemoryPressureGuard({control,schedule:false,clock:()=>now,readSample:async()=>({total:16*GiB,available})});
 return{kv,control,guard,record:()=>record,clock:()=>now,time:(v:number)=>now=v,memory:(v:number)=>available=v,fail:(v:boolean)=>fail=v,
 async normal(ms=120000){available=8*GiB;for(let i=0;i<=ms/5000;i++){now+=5000;await guard.refresh();await guard.drain();await control.settled();}}};}
it('persists distinct overlapping holds and never automatically releases manual or deployment',async()=>{
 const f=fixture();await f.control.init(f.kv);await f.control.change('pause',{source:'manual'});await f.control.settled();await f.guard.refresh();
 expect(f.control.snapshot().holds).toEqual(['manual','memory']);await f.normal();expect(f.control.isPaused()).toBe(true);
 await f.control.change('pause',{source:'deployment'});await f.control.change('resume');expect(f.control.snapshot().holds).toEqual(['deployment','memory']);
});
it('recovers only after strictly greater recovery threshold and sustained fresh samples',async()=>{
 const f=fixture();await f.control.init(f.kv);await f.guard.refresh();await f.control.settled();expect(f.control.snapshot().holds).toEqual(['memory']);
 f.memory(4*GiB);for(let i=0;i<30;i++){f.time(f.clock()+5000);await f.guard.refresh();}expect(f.control.isPaused()).toBe(true);
 await f.normal(115000);expect(f.control.isPaused()).toBe(true);f.time(f.clock()+5000);await f.guard.refresh();await f.guard.drain();expect(f.control.isPaused()).toBe(false);
 expect(f.record()).toMatchObject({version:2,paused:false,resumePending:true,recovery:{attempts:1}});
});
it('restores protection holds and attempt budget across a clean restart but restarts stable time',async()=>{
 const f=fixture();await f.control.init(f.kv);await f.guard.refresh();await f.control.settled();await f.normal(60000);await f.control.commitCleanShutdown();
 const g=fixture(f.record());await g.control.init(g.kv);await g.normal(115000);expect(g.control.isPaused()).toBe(true);g.time(g.clock()+5000);await g.guard.refresh();await g.guard.drain();expect(g.control.isPaused()).toBe(false);
});
it.each([{paused:true}, {paused:true,resumePending:true}])('keeps legacy or interrupted records held %j',async saved=>{
 const f=fixture(saved);await f.control.init(f.kv);await f.normal();expect(f.control.isPaused()).toBe(true);expect(f.control.snapshot().holds).toContain(saved.resumePending?'storage_error':'legacy_unknown');
});
it('resets stable time on stale gaps and clock regression',async()=>{
 const f=fixture();await f.control.init(f.kv);await f.guard.refresh();await f.control.settled();await f.normal(110000);
 f.time(f.clock()+11000);await f.guard.refresh();expect(f.control.isPaused()).toBe(true);f.time(0);await f.guard.refresh();await f.normal(110000);expect(f.control.isPaused()).toBe(true);
});
it('does not open admission when a manual pause arrives during automatic activation',async()=>{
 const f=fixture();await f.control.init(f.kv);await f.guard.refresh();await f.control.settled();
 let release!:()=>void;const disk=new Promise<void>(r=>release=r);f.kv.durability.wait=async()=>{await disk;return{synced:true,mutationFailures:0};};
 const resuming=f.control.change('resume',{source:'memory',canResume:async()=>true});await new Promise(r=>setImmediate(r));
 const pausing=f.control.change('pause');expect(f.control.isPaused()).toBe(true);release();await resuming;await pausing;await f.control.settled();expect(f.control.snapshot().holds).toContain('manual');expect(f.control.isPaused()).toBe(true);
});
it('rechecks fresh pressure during activation and preserves memory hold if high returns',async()=>{
 const f=fixture();await f.control.init(f.kv);await f.guard.refresh();await f.control.settled();await f.normal(115000);
 f.kv.durability.wait=async()=>{f.memory(GiB);return{synced:true,mutationFailures:0};};f.time(f.clock()+5000);await f.guard.refresh();await f.guard.drain();expect(f.control.isPaused()).toBe(true);expect(f.control.snapshot().holds).toContain('memory');
});
it('persists storage failures as a hold and requires manual recovery',async()=>{
 const f=fixture();await f.control.init(f.kv);f.kv.durability.wait=async()=>{throw Error('synthetic');};await f.guard.refresh();await f.control.settled();expect(f.control.snapshot().holds).toContain('storage_error');
 f.kv.durability.wait=async()=>({synced:true,mutationFailures:0});await f.normal();expect(f.control.isPaused()).toBe(true);await f.control.change('resume');expect(f.control.snapshot().holds).toEqual(['memory']);
});
it('bounds automatic attempts durably and honors persisted backoff',async()=>{
 const f=fixture({version:2,paused:true,resumePending:false,holds:['memory'],recovery:{attempts:3,nextAttemptAt:0}});await f.control.init(f.kv);await f.normal();expect(f.control.isPaused()).toBe(true);
 const g=fixture({version:2,paused:true,resumePending:false,holds:['memory'],recovery:{attempts:1,nextAttemptAt:999999}});await g.control.init(g.kv);await g.normal();expect(g.control.isPaused()).toBe(true);expect(g.record().recovery.attempts).toBe(1);
});
it('uses exact pressure boundaries and never recovers with unavailable samples',async()=>{
 const f=fixture();await f.control.init(f.kv);f.memory(16*GiB*.2);await f.guard.refresh();expect(f.guard.snapshot().level).toBe('normal');f.memory(16*GiB*.05);await f.guard.refresh();expect(f.guard.snapshot().level).toBe('high');await f.control.settled();f.memory(NaN);await f.normal(0);f.memory(NaN);f.time(f.clock()+120000);await f.guard.refresh();expect(f.control.isPaused()).toBe(true);
});
it('retains cumulative attempts through repeated pressure and clean restart until manual acknowledgment',async()=>{
 const f=fixture();await f.control.init(f.kv);
 for(let i=1;i<=3;i++){f.memory(GiB);await f.guard.refresh();await f.control.settled();await f.normal();expect(f.control.isPaused()).toBe(false);expect(f.record().recovery.attempts).toBe(i);}
 f.memory(GiB);await f.guard.refresh();await f.control.settled();await f.normal();expect(f.control.isPaused()).toBe(true);await f.control.commitCleanShutdown();
 const g=fixture(f.record());await g.control.init(g.kv);await g.normal();expect(g.control.snapshot().recovery.attempts).toBe(3);expect(g.control.isPaused()).toBe(true);
 await g.control.change('resume');expect(g.control.snapshot()).toMatchObject({holds:['memory'],recovery:{attempts:0},pausedRequested:true});await g.normal();expect(g.control.isPaused()).toBe(false);
});
it('persists a failed activation attempt before its fence and keeps interrupted recovery held after restart',async()=>{
 const f=fixture();await f.control.init(f.kv);await f.guard.refresh();await f.control.settled();
 f.kv.durability.wait=async()=>{throw Error('synthetic');};await f.normal();expect(f.record()).toMatchObject({resumePending:true,recovery:{attempts:1}});
 const g=fixture(f.record());await g.control.init(g.kv);await g.normal();expect(g.control.snapshot().holds).toContain('storage_error');expect(g.control.isPaused()).toBe(true);
});
it('holds after a pause write failure and can later certify manual acknowledgment',async()=>{
 const f=fixture();await f.control.init(f.kv);f.fail(true);await expect(f.control.change('pause')).rejects.toThrow('background_storage_unavailable');
 expect(f.control.snapshot()).toMatchObject({holds:['manual','storage_error'],pausedRequested:true});f.fail(false);await f.control.change('resume');expect(f.control.isPaused()).toBe(false);
});
it('rejects malformed durable v2 records and never exposes private saved fields',async()=>{
 const f=fixture({version:2,paused:true,resumePending:false,holds:['memory'],recovery:{attempts:-1,nextAttemptAt:0}});await expect(f.control.init(f.kv)).rejects.toThrow('invalid_background_control');expect(f.control.isPaused()).toBe(true);
 const g=fixture({version:2,paused:true,resumePending:false,holds:['memory'],recovery:{attempts:0,nextAttemptAt:0,private:'PRIVATE'}});await g.control.init(g.kv);expect(JSON.stringify(g.control.snapshot())).not.toContain('PRIVATE');
});
it('sample failure during activation keeps the memory hold without mislabeling it as a storage fault',async()=>{
 const f=fixture();await f.control.init(f.kv);await f.guard.refresh();await f.control.settled();await f.normal(115000);
 f.kv.durability.wait=async()=>{f.memory(NaN);return{synced:true,mutationFailures:0};};f.time(f.clock()+5000);await f.guard.refresh();await f.guard.drain();expect(f.control.snapshot().holds).toEqual(['memory']);expect(f.control.snapshot().status).toBe('paused');expect(f.guard.snapshot().sampleError).toBe(true);
});
it('retains safe diagnostics when adding a hold to a restored pause fails before any transition exists',async()=>{
 const f=fixture({paused:true});await f.control.init(f.kv);f.fail(true);await expect(f.control.change('pause',{source:'memory'})).rejects.toThrow('background_storage_unavailable');expect(f.control.snapshot()).toMatchObject({status:'error',holds:['legacy_unknown','memory','storage_error'],diagnostics:{stage:'request'}});
});
it('keeps admission closed when a manual pause arrives at the final activation certificate',async()=>{
 const f=fixture();await f.control.init(f.kv);await f.guard.refresh();await f.control.settled();
 let release!:()=>void;const disk=new Promise<void>(r=>release=r);f.kv.durability.waitForKeys=async()=>{if(!f.record().paused)await disk;};
 const resuming=f.control.change('resume',{source:'memory',canResume:async()=>true});await new Promise(r=>setImmediate(r));expect(f.record().paused).toBe(false);
 const pausing=f.control.change('pause');expect((await f.control.run(async()=>42)) as any).toMatchObject({deferred:true});release();await resuming;await pausing;await f.control.settled();expect(f.control.snapshot()).toMatchObject({holds:['manual','memory'],pausedRequested:true,status:'paused'});expect(f.record().holds).toEqual(['manual','memory']);
});
it('rolls activation back if the final fresh memory check becomes high after activation reaches disk',async()=>{
 const f=fixture();await f.control.init(f.kv);await f.guard.refresh();await f.control.settled();await f.normal(115000);
 f.kv.durability.waitForKeys=async()=>{if(!f.record().paused)f.memory(GiB);};f.time(f.clock()+5000);await f.guard.refresh();await f.guard.drain();expect(f.record()).toMatchObject({paused:true,resumePending:false,holds:['memory'],recovery:{attempts:1}});expect(f.control.isPaused()).toBe(true);
});
it('honors future backoff even when stable samples survive a clean restart and accepts equality',async()=>{
 const f=fixture({version:2,paused:true,resumePending:false,holds:['memory'],recovery:{attempts:1,nextAttemptAt:130001}});await f.control.init(f.kv);await f.normal();expect(f.control.isPaused()).toBe(true);f.time(130001);await f.guard.refresh();await f.guard.drain();expect(f.control.isPaused()).toBe(false);expect(f.control.snapshot().recovery.attempts).toBe(2);
});

it('keeps action-only HTTP pauses manual and permits only an explicit deployment reason',async()=>{
 const f=fixture(),handlers=new Map<string,any>();await f.control.init(f.kv);registerBackgroundControlApi({registerFunction:(id:string,fn:any)=>handlers.set(id,fn),registerTrigger:()=>{}} as any,'fixture',f.control);
 const post=(body:any)=>handlers.get('api::background-control-set')({headers:{authorization:'Bearer fixture','x-agentmemory-background':'1','content-type':'application/json'},body});
 expect((await post({action:'pause'})).status_code).toBe(202);await f.control.settled();expect(f.control.snapshot().holds).toEqual(['manual']);
 expect((await post({action:'pause',reason:'deployment'})).status_code).toBe(202);expect(f.control.snapshot().holds).toEqual(['deployment','manual']);
 expect((await post({action:'resume',reason:'memory'})).status_code).toBe(400);expect((await post({action:'resume',source:'manual'})).status_code).toBe(400);expect((await post({action:'resume',reason:'deployment'})).status_code).toBe(202);expect(f.control.snapshot().holds).toEqual(['manual']);
});
it.each([
 {holds:['manual','memory'],resumeSource:'manual',pauseSource:'manual'},
 {holds:['manual'],resumeSource:'manual',pauseSource:'manual'},
 {holds:['deployment','memory'],resumeSource:'deployment',pauseSource:'deployment'},
 {holds:['deployment'],resumeSource:'deployment',pauseSource:'deployment'},
])('preserves the newer same-turn pause through queued $resumeSource resume for $holds',async({holds,resumeSource,pauseSource})=>{
 const f=fixture({version:2,paused:true,resumePending:false,holds,recovery:{attempts:0,nextAttemptAt:0}});await f.control.init(f.kv);
 const resuming=f.control.change('resume',{source:resumeSource as any});const pausing=f.control.change('pause',{source:pauseSource as any});
 expect(f.control.isPaused()).toBe(true);
 const resumed=await resuming;expect(resumed.pausedRequested).toBe(true);expect(resumed.holds).toEqual([...holds].sort());expect((await f.control.run(async()=>42)) as any).toMatchObject({deferred:true});
 await pausing;await f.control.settled();await f.normal();expect(f.control.snapshot().holds).toEqual([...holds].sort());expect(f.control.isPaused()).toBe(true);
});
it('continues critical sampling and middleware rejection while automatic recovery waits on the full fence',async()=>{
 const f=fixture();await f.control.init(f.kv);await f.guard.refresh();await f.control.settled();await f.normal(115000);
 const handlers=new Map<string,any>();
 const sdk:any={registerFunction:(id:string,fn:any)=>handlers.set(id,fn)};f.guard.install(sdk,()=>null);sdk.registerFunction('api::write',async()=>({status_code:200}));
 let release!:()=>void;const fence=new Promise<void>(r=>release=r);f.kv.durability.wait=async()=>{await fence;return{synced:true,mutationFailures:0};};
 try{
  f.time(f.clock()+5000);await f.guard.refresh();await new Promise(r=>setImmediate(r));expect(f.control.snapshot().status).toBe('resuming');
  f.time(f.clock()+15000);f.memory(0);await f.guard.refresh();
  expect(f.guard.snapshot().level).toBe('critical');expect((await handlers.get('api::write')({})).status_code).toBe(503);expect(f.control.isPaused()).toBe(true);
  f.time(f.clock()+5000);await f.guard.refresh();expect(f.guard.snapshot().checkedAt).toBe(f.clock());expect(f.guard.snapshot().level).toBe('critical');
 }finally{release();await f.guard.stop();await f.control.settled();}
 expect(f.control.snapshot().holds).toContain('memory');
});

it.each(['drain','stop'] as const)('keeps %s pending until recovery settles and avoids duplicate attempts during concurrent refresh',async method=>{
 const f=fixture();await f.control.init(f.kv);await f.guard.refresh();await f.control.settled();await f.normal(115000);
 let release!:()=>void;const fence=new Promise<void>(r=>release=r);let fences=0;
 f.kv.durability.wait=async()=>{fences++;await fence;return{synced:true,mutationFailures:0};};
 try{
  f.time(f.clock()+5000);const first=f.guard.refresh(),same=f.guard.refresh();expect(same).toBe(first);await first;await new Promise(r=>setImmediate(r));
  expect(f.control.snapshot().status).toBe('resuming');
  for(let i=0;i<3;i++){f.time(f.clock()+5000);await Promise.all([f.guard.refresh(),f.guard.refresh()]);}
  expect(f.control.snapshot().recovery.attempts).toBe(1);expect(fences).toBe(1);expect(f.guard.snapshot().checkedAt).toBe(f.clock());
  let finished=false;const waiting=f.guard[method]().then(()=>finished=true);await new Promise(r=>setImmediate(r));expect(finished).toBe(false);
  release();await waiting;expect(finished).toBe(true);expect(f.control.isPaused()).toBe(method==='stop');
 }finally{release();await f.guard.stop();await f.control.settled();}
});
it('requires a new stable interval after a sampling gap during the recovery fence',async()=>{
 const f=fixture();await f.control.init(f.kv);await f.guard.refresh();await f.control.settled();await f.normal(115000);
 let release!:()=>void;const fence=new Promise<void>(r=>release=r);f.kv.durability.wait=async()=>{await fence;return{synced:true,mutationFailures:0};};
 try{
  f.time(f.clock()+5000);await f.guard.refresh();await new Promise(r=>setImmediate(r));
  f.time(f.clock()+15000);await f.guard.refresh();release();await f.guard.drain();expect(f.control.isPaused()).toBe(true);expect(f.control.snapshot().holds).toEqual(['memory']);
 }finally{release();await f.guard.stop();await f.control.settled();}
});
it('does not replace a newer critical sample with a delayed recovery sample',async()=>{
 const f=fixture();let available=GiB,blockNext=false,release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const guard=createMemoryPressureGuard({control:f.control,schedule:false,clock:f.clock,readSample:async()=>{const m={total:16*GiB,available};if(blockNext){blockNext=false;await gate;}return m;}});
 await f.control.init(f.kv);await guard.refresh();await f.control.settled();available=8*GiB;
 for(let i=0;i<24;i++){f.time(f.clock()+5000);await guard.refresh();}
 f.kv.durability.wait=async()=>{blockNext=true;return{synced:true,mutationFailures:0};};
 try{
  f.time(f.clock()+5000);await guard.refresh();await new Promise(r=>setImmediate(r));
  f.time(f.clock()+5000);available=0;await guard.refresh();expect(guard.snapshot().level).toBe('critical');
  release();await guard.drain();await f.control.settled();expect(guard.snapshot().level).toBe('critical');expect(f.control.isPaused()).toBe(true);
 }finally{release();await guard.stop();await f.control.settled();}
});
