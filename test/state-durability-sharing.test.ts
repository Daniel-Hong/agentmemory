import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,writeFile,rm,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const hooks=vi.hoisted(()=>({reads:0,syncs:0,beforeRead:null as null|(()=>Promise<void>),streamStart:null as null|(()=>Promise<void>),directorySync:null as null|(()=>Promise<void>)}));
vi.mock('node:fs/promises',async original=>{
 const actual=await original<typeof import('node:fs/promises')>();
 return {...actual,open:async(...args:Parameters<typeof actual.open>)=>{
  const handle=await actual.open(...args),sync=handle.sync.bind(handle),stream=handle.createReadStream.bind(handle);
  handle.createReadStream=(options:any)=>{const result=stream(options),iterate=result.iterator.bind(result);result.iterator=(opts:any)=>{const iterator=iterate(opts);return(async function*(){await hooks.streamStart?.();yield* {[Symbol.asyncIterator]:()=>iterator};})();};return result;};
  handle.sync=async()=>{hooks.syncs++;if(!String(args[0]).endsWith('.bin'))await hooks.directorySync?.();await sync();};return handle;
 }};
});
vi.mock('../src/ops/namespace-reader.mjs',async original=>{
 const actual=await original<any>();
 return {...actual,readNamespaceEntries:async(path:string,options:any)=>{hooks.reads++;await hooks.beforeRead?.();return actual.readNamespaceEntries(path,options);}};
});
import {createStateDurabilityFence} from '../src/ops/state-durability.mjs';
const dirs:string[]=[];
afterEach(async()=>{hooks.reads=0;hooks.syncs=0;hooks.beforeRead=null;hooks.streamStart=null;hooks.directorySync=null;await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})));});
it('shares one validated scan across simultaneous requests while certifying each request',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am-shared-fence-'));dirs.push(dir);
 await writeFile(join(dir,'synthetic.bin'),'{"a":1,"b":2}');
 const fence=createStateDurabilityFence({storePath:dir});
 const kv={get:async(_scope:string,key:string)=>key==='a'?1:2};
 const results=await Promise.all(['a','b'].map(key=>fence.waitForKeys(kv,[{scope:'synthetic',key}])));
 expect(results.every(x=>x.synced)).toBe(true);expect(hooks.reads).toBe(1);
 expect(hooks.syncs).toBe(4);
 const snapshot=fence.snapshot() as any;
 expect(snapshot.measurements.recent).toHaveLength(2);
 expect(snapshot.measurements.recent.reduce((n:number,s:any)=>n+s.scans,0)).toBe(2); // Each waiter receives scan attribution; physical reads remain counted once below.
 expect(snapshot.readSharing).toMatchObject({requests:2,sharedRequests:1,startedReads:1,activeReads:0,activeWaiters:0});
});
async function fixture(timeoutMs=150){
 const dir=await mkdtemp(join(tmpdir(),'am-shared-fence-'));dirs.push(dir);const path=join(dir,'synthetic.bin');await writeFile(path,'{"a":1}');
 return {dir,path,fence:createStateDurabilityFence({storePath:dir,timeoutMs,pollIntervalMs:5})};
}
it('compares each expectation independently after a shared scan',async()=>{
 const {fence}=await fixture();
 const results=await Promise.allSettled([1,2].map(value=>fence.waitForKeys({get:async()=>value},[{scope:'synthetic',key:'a'}])));
 expect(results[0].status).toBe('fulfilled');expect(results[1]).toMatchObject({status:'rejected',reason:{code:'STATE_DURABILITY_TIMEOUT'}});
 expect(hooks.reads).toBe(1);expect((fence.snapshot() as any).measurements.recent.some((x:any)=>x.retryReasons.not_committed)).toBe(true);
});
it('rejects a shared result replaced before final verification and certifies a fresh current file',async()=>{
 const {path,fence}=await fixture(1000);let replaced=false;
 hooks.directorySync=async()=>{if(!replaced){replaced=true;await writeFile(path+'.next','{"a":1}');await rename(path+'.next',path);}};
 const results=await Promise.all([1,2].map(()=>fence.waitForKeys({get:async()=>1},[{scope:'synthetic',key:'a'}])));
 expect(results.every(x=>x.synced)).toBe(true);expect(hooks.reads).toBeGreaterThanOrEqual(2);
 expect((fence.snapshot() as any).measurements.recent.reduce((n:number,s:any)=>n+(s.retryReasons.namespace_changed??0),0)).toBeGreaterThan(0);
});
it('retains dirty revision changes made during the shared certification',async()=>{
 const {fence}=await fixture(1000);await fence.mutate('synthetic','a',async()=>{});
 hooks.directorySync=async()=>{await fence.mutate('synthetic','a',async()=>{});};
 await Promise.all([1,2].map(()=>fence.waitForKeys({get:async()=>1},fence.keys())));
 expect(fence.keys()).toHaveLength(1);
});
it('rejects an inode replaced during a shared read and retries the current inode',async()=>{
 const {path,fence}=await fixture(1000);let replaced=false;
 hooks.streamStart=async()=>{if(!replaced){replaced=true;await writeFile(path+'.next','{"a":1}');await rename(path+'.next',path);}};
 await Promise.all([1,2].map(()=>fence.waitForKeys({get:async()=>1},[{scope:'synthetic',key:'a'}])));
 expect(hooks.reads).toBeGreaterThanOrEqual(2);expect((fence.snapshot() as any).measurements.recent.every((s:any)=>s.retryReasons.namespace_changed>0)).toBe(true);
});
it('never acknowledges shared values after repeated directory fsync failure',async()=>{
 const {fence}=await fixture();await fence.mutate('synthetic','a',async()=>{});
 hooks.directorySync=async()=>{throw Object.assign(Error('synthetic sync error'),{code:'EIO'});};
 const results=await Promise.allSettled([1,2].map(()=>fence.waitForKeys({get:async()=>1},fence.keys())));
 expect(results.every(x=>x.status==='rejected'&&x.reason.code==='STATE_DURABILITY_TIMEOUT')).toBe(true);
 expect(fence.keys()).toHaveLength(1);
});
it('honors separate request deadlines when the scan owner expires first',async()=>{
 const {dir}=await fixture(500);vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date']});
 try{
  const fence=createStateDurabilityFence({storePath:dir,timeoutMs:500,pollIntervalMs:5});let release!:()=>void,entered!:()=>void;
  const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
  hooks.beforeRead=async()=>{entered();await gate;};
  const a=fence.waitForKeys({get:async()=>1},[{scope:'synthetic',key:'a'}]);const expired=expect(a).rejects.toMatchObject({code:'STATE_DURABILITY_TIMEOUT'});
  const peer=fence.waitForKeys({get:async()=>1},[{scope:'synthetic',key:'a'}]);const peerExpired=expect(peer).rejects.toMatchObject({code:'STATE_DURABILITY_TIMEOUT'});await ready;
  await vi.advanceTimersByTimeAsync(300);
  const b=fence.waitForKeys({get:async()=>1},[{scope:'synthetic',key:'a'}]);await vi.advanceTimersByTimeAsync(201);await Promise.all([expired,peerExpired]);release();
  expect(await b).toMatchObject({synced:true});expect(hooks.reads).toBe(1);
  expect((fence.snapshot() as any).readSharing).toMatchObject({startedReads:1,sharedRequests:2,activeReads:0,activeWaiters:0});
 }finally{vi.useRealTimers();}
});
it('certifies an oversized singleton with one scan and both fsyncs',async()=>{
 const {path,fence}=await fixture(2000),value='x'.repeat(5*1024*1024);await writeFile(path,JSON.stringify({a:value}));
 expect(await fence.waitForKeys({get:async()=>value},[{scope:'synthetic',key:'a'}])).toMatchObject({synced:true});
 expect(hooks.reads).toBe(1);expect(hooks.syncs).toBe(2);
 expect((fence.snapshot() as any).readSharing).toMatchObject({projectionFallbacks:0,activeReads:0,activeWaiters:0});
});
it('does not certify an oversized singleton whose current value differs',async()=>{
 const {path,fence}=await fixture(200),value='x'.repeat(5*1024*1024);await writeFile(path,JSON.stringify({a:value}));
 await expect(fence.waitForKeys({get:async()=>value+'mismatch'},[{scope:'synthetic',key:'a'}])).rejects.toMatchObject({code:'STATE_DURABILITY_TIMEOUT'});
 expect(hooks.reads).toBe(1);expect(hooks.syncs).toBe(0);
 expect((fence.snapshot() as any).measurements.recent[0].retryReasons.not_committed).toBeGreaterThan(0);
});
it('rechecks an oversized singleton replaced during fsync',async()=>{
 const {path,fence}=await fixture(2000),value='x'.repeat(5*1024*1024),body=JSON.stringify({a:value});await writeFile(path,body);let replaced=false;
 hooks.directorySync=async()=>{if(!replaced){replaced=true;await writeFile(path+'.next',body);await rename(path+'.next',path);}};
 expect(await fence.waitForKeys({get:async()=>value},[{scope:'synthetic',key:'a'}])).toMatchObject({synced:true});
 expect(hooks.reads).toBe(2);expect(hooks.syncs).toBe(4);
 expect((fence.snapshot() as any).measurements.recent[0].retryReasons.namespace_changed).toBeGreaterThan(0);
});
