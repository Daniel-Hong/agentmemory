import {afterEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {chmodSync,mkdirSync,mkdtempSync,readFileSync,lstatSync,readdirSync,symlinkSync,rmSync,truncateSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';
import {SdkSpoolV2} from '../src/capture/sdk-spool-v2.js';
import {deliverSdkCaptureV2,drainSdkCapturesV2} from '../src/capture/sdk-delivery-v2.js';

const BLOCK=4096,MiB=1024*1024,target='https://synthetic.invalid';
const roots:string[]=[];
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const canonical=(v:any):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const ack=(body:Record<string,unknown>)=>({status:201,body:{eventId:body.eventId,status:'accepted',completion:'sdk',completed:true,durable:false}});
afterEach(()=>{vi.restoreAllMocks();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function root(){const path=mkdtempSync(join(tmpdir(),'sdk-progress-'));roots.push(path);return path;}
async function fixture(refs=1240,completed=2328,textBytes=32*1024){
 const dir=root(),store=new SdkSpoolV2({dir});await store.usage();
 const selected:Array<{sourceId:string;body:Record<string,unknown>}>=[];
 for(let index=0;index<refs+completed;index++){
  const eventId='synthetic-'+index,body={eventId,captureCompletion:'sdk-v1',data:{text:'synthetic '+index+'x'.repeat(textBytes)}};
  const bytes=Buffer.from(canonical(body)),sourceId=hash(hash(target)+'\0'+eventId),folder=join(dir,'originals',sourceId);
  mkdirSync(folder,{mode:0o700});writeFileSync(join(folder,'000000.chunk'),bytes,{mode:0o600});
  writeFileSync(join(folder,'manifest.json'),canonical({v:2,sourceId,targetHash:hash(target),eventId,bytes:bytes.length,hash:hash(bytes),chunks:[{name:'000000.chunk',bytes:bytes.length,hash:hash(bytes)}],conflict:false,completed:index>=refs}),{mode:0o600});
  if(index<refs){writeFileSync(join(dir,'queue',sourceId+'.ref'),canonical({v:2,targetHash:hash(target),sourceId,state:'pending',attempts:0,nextAttemptAt:0}),{mode:0o600});selected.push({sourceId,body});}
 }
 return {dir,store,selected};
}
function fill(path:string,bytes:number){expect(bytes).toBeGreaterThanOrEqual(BLOCK);writeFileSync(path,'',{mode:0o600});truncateSync(path,bytes);}

it('progresses a legacy 1200-ref byte-saturated queue, preserving all originals and reserved admission',async()=>{
 // Keep reference count portable; exact byte saturation below still tests the same cap.
 // ext4 directory blocks can make 1240 refs alone exceed 5MiB on some layouts.
 const {dir,store,selected}=await fixture(1200,2368);
 const filler=join(dir,'queue','legacy-preserved.tmp');writeFileSync(filler,'',{mode:0o600});
 fill(filler,5*MiB-(await store.usage()).queueBytes+BLOCK);
 const before=await store.usage();expect(before.queueBytes).toBeLessThanOrEqual(5*MiB);expect(5*MiB-before.queueBytes).toBeLessThan(2*BLOCK);
 const source=selected[0],chunk=join(dir,'originals',source.sourceId,'000000.chunk'),digest=hash(readFileSync(chunk));
 const extra=await store.retain(target,'new-after-full',{eventId:'new-after-full',data:'synthetic'});
 await expect(store.enqueue(target,extra.sourceId)).rejects.toMatchObject({code:'QUEUE_FULL'});
 await store.markSending(target,source.sourceId);await store.retry(target,source.sourceId,'known-not-sent');
 vi.spyOn(Date,'now').mockReturnValue(Date.now()+10000);
 await store.markSending(target,source.sourceId);await store.hold(target,source.sourceId,'unknown');
 await expect(store.markSending(target,source.sourceId)).rejects.toMatchObject({code:'SOURCE_HELD'});
 await store.markSending(target,source.sourceId,source.body);await store.acknowledge(target,source.sourceId);
 expect(hash(readFileSync(chunk))).toBe(digest);expect(readdirSync(join(dir,'originals'))).toHaveLength(3569);
 expect(JSON.parse(readFileSync(join(dir,'originals',source.sourceId,'manifest.json'),'utf8')).completed).toBe(true);
 await store.markSending(target,selected[1].sourceId);await store.acknowledge(target,selected[1].sourceId);
 await expect(store.enqueue(target,extra.sourceId)).resolves.toBeUndefined();
 expect((await store.usage()).queueBytes).toBeLessThanOrEqual(5*MiB+2*BLOCK);
},30000);

it('ACKs at the original admission limit while retaining chunks and refusing new originals',async()=>{
 const dir=root(),store=new SdkSpoolV2({dir}),body={eventId:'original-limit',data:'synthetic'};
 const source=await store.retain(target,body.eventId,body);await store.enqueue(target,source.sourceId);await store.markSending(target,source.sourceId);
 const before=await store.usage(),limited=new SdkSpoolV2({dir,maxOriginalBytes:before.originalBytes});
 await expect(limited.retain(target,'new',{eventId:'new'})).rejects.toMatchObject({code:'ORIGINALS_FULL'});
 await limited.acknowledge(target,source.sourceId);
 expect(await limited.load(target,source.sourceId)).toEqual(body);expect((await limited.usage()).originalBytes).toBeLessThanOrEqual(before.originalBytes+17*BLOCK);
});

it('counts preserved crash files against transition workspace and refuses overcommit',async()=>{
 const {dir,store,selected}=await fixture(1,0,256),before=await store.usage();
 fill(join(dir,'queue','preserved-crash.tmp'),BLOCK);
 await expect(new SdkSpoolV2({dir,maxQueueBytes:before.queueBytes}).markSending(target,selected[0].sourceId)).rejects.toMatchObject({code:'QUEUE_FULL'});
 expect((await store.pending(target))[0].state).toBe('pending');expect(readFileSync(join(dir,'queue','preserved-crash.tmp'))).toHaveLength(BLOCK);
 await store.markSending(target,selected[0].sourceId);
 fill(join(dir,'originals','preserved-crash.tmp'),17*BLOCK);
 await expect(new SdkSpoolV2({dir,maxOriginalBytes:before.originalBytes}).acknowledge(target,selected[0].sourceId)).rejects.toMatchObject({code:'ORIGINALS_FULL'});
 expect((await store.pending(target))[0].state).toBe('sending');expect(await store.load(target,selected[0].sourceId)).toEqual(selected[0].body);
});

it('delivers more than 1200 retained refs without deleting originals or replaying completed entries',async()=>{
 const {dir,store,selected}=await fixture(1201,0,256);let calls=0;const start=performance.now();
 for(const source of selected){const result=await deliverSdkCaptureV2(target,source.body,async body=>{calls++;return ack(body);},{dir});expect(result.outcome).toBe('delivered');}
 expect(calls).toBe(1201);expect(await store.pending(target)).toEqual([]);expect(readdirSync(join(dir,'originals'))).toHaveLength(1201);
 for(const source of selected){const manifest=JSON.parse(readFileSync(join(dir,'originals',source.sourceId,'manifest.json'),'utf8'));expect(manifest.completed).toBe(true);expect(hash(readFileSync(join(dir,'originals',source.sourceId,'000000.chunk')))).toBe(manifest.hash);}
 const completed=await deliverSdkCaptureV2(target,selected[0].body,async body=>{calls++;return ack(body);},{dir});expect(completed.outcome).toBe('duplicate');expect(calls).toBe(1201);
 console.log(JSON.stringify({syntheticSpoolDrain:true,delivered:calls,originalsPreserved:1201,elapsedMs:Math.round(performance.now()-start)}));
},120000);

it('one sender owns delivery while concurrent attempts and unknown replies cannot replay',async()=>{
 const dir=root(),body={eventId:'concurrent',data:'synthetic'};let calls=0,release!:()=>void,started!:()=>void;
 const entered=new Promise<void>(resolve=>started=resolve),wait=new Promise<void>(resolve=>release=resolve);
 const first=deliverSdkCaptureV2(target,body,async()=>{calls++;started();await wait;throw Error('uncertain');},{dir});await entered;
 const second=await deliverSdkCaptureV2(target,body,async value=>{calls++;return ack(value);},{dir});expect(second).toMatchObject({outcome:'held',code:'SDK_SEND_IN_PROGRESS_OR_UNCERTAIN'});
 release();expect(await first).toMatchObject({outcome:'held',code:'SDK_SEND_UNCERTAIN'});
 const third=await deliverSdkCaptureV2(target,body,async value=>{calls++;return ack(value);},{dir});expect(third).toMatchObject({outcome:'held',code:'SOURCE_HELD'});expect(calls).toBe(1);
});

it('a malformed unrelated reference cannot prevent selected delivery',async()=>{
 const {dir,selected}=await fixture(2,0,256),unrelated=join(dir,'queue',selected[1].sourceId+'.ref');writeFileSync(unrelated,'{malformed');
 let calls=0;expect(await deliverSdkCaptureV2(target,selected[0].body,async body=>{calls++;return ack(body);},{dir})).toMatchObject({outcome:'delivered'});
 expect(calls).toBe(1);expect(readFileSync(unrelated,'utf8')).toBe('{malformed');
});

it('lists metadata and verifies only selected source bytes for direct delivery and bounded drain',async()=>{
 const {dir,store,selected}=await fixture(1200,2368);let verified=0;
 const options={dir,storeOptions:{onPhase:(phase:string)=>{if(phase==='source_verified')verified++;}}};
 const start=performance.now(),records=await new SdkSpoolV2({...options.storeOptions,dir}).pending(target),listingMs=performance.now()-start;
 expect(records).toHaveLength(1200);expect(verified).toBe(0);
 const result=await deliverSdkCaptureV2(target,selected[0].body,async body=>ack(body),options);
 expect(result.outcome).toBe('delivered');expect(verified).toBeLessThanOrEqual(5);
 verified=0;const drained=await drainSdkCapturesV2(target,async body=>ack(body),{...options,limit:1,budgetMs:1500});
 expect(drained).toMatchObject({attempted:1,delivered:1,remaining:1198});expect(verified).toBeLessThanOrEqual(3);
 console.log(JSON.stringify({syntheticSpoolProgress:true,refs:1200,originals:3568,listingMs:Math.round(listingMs),selectedSourceReads:verified}));
 expect((await store.usage()).originalBytes).toBeGreaterThan(100*MiB);
},30000);

it('queue transitions do not inspect unrelated original trees and corrupt selected bytes never POST',async()=>{
 const {dir,store,selected}=await fixture(2,1),unrelated=join(dir,'originals','unrelated');
 mkdirSync(unrelated,{mode:0o700});writeFileSync(join(unrelated,'private'),'',{mode:0o600});chmodSync(join(unrelated,'private'),0o644);
 await store.markSending(target,selected[0].sourceId);await store.hold(target,selected[0].sourceId,'unknown');
 const chunk=join(dir,'originals',selected[1].sourceId,'000000.chunk');writeFileSync(chunk,'corrupt');let posts=0;
 const result=await deliverSdkCaptureV2(target,selected[1].body,async body=>{posts++;return ack(body);},{dir});
 expect(result.outcome).toBe('dropped');expect(posts).toBe(0);expect(readFileSync(chunk,'utf8')).toBe('corrupt');
});


it('preserves crashed transition workspace and refuses replacement without consuming another slot',async()=>{
 const {dir,store,selected}=await fixture(1,0,256);
 const slot=join(dir,'queue','.transitions','pending.tmp');writeFileSync(slot,'synthetic crash evidence',{mode:0o600});
 const before=await store.usage();
 await expect(store.markSending(target,selected[0].sourceId)).rejects.toMatchObject({code:'QUEUE_FULL'});
 expect(readFileSync(slot,'utf8')).toBe('synthetic crash evidence');
 expect(await store.usage()).toEqual(before);expect((await store.pending(target))[0].state).toBe('pending');
});

it('refuses legacy workspace bootstrap over its reserved peak without deleting preserved pressure',async()=>{
 const {dir,store,selected}=await fixture(1,0,256);
 rmSync(join(dir,'queue','.transitions'),{recursive:true});
 const before=await store.usage(),pressure=join(dir,'queue','legacy-crash.tmp');
 fill(pressure,5*MiB-before.queueBytes+BLOCK);
 const usage=await store.usage();
 await expect(store.markSending(target,selected[0].sourceId)).rejects.toMatchObject({code:'QUEUE_FULL'});
 expect(await store.usage()).toEqual(usage);
 expect(readdirSync(join(dir,'queue'))).not.toContain('.transitions');
 expect((await store.pending(target))[0].state).toBe('pending');
});


it('keeps actual staged replacement peak inside the unchanged 8KiB reserve',async()=>{
 const {dir,store,selected}=await fixture(1,0,256);
 const before=await store.usage();let peaks=0;
 const measure=(path:string):number=>{const stat=lstatSync(path);return Math.max(BLOCK,Math.ceil(stat.size/BLOCK)*BLOCK,stat.blocks*512)+(stat.isDirectory()?readdirSync(path).reduce((sum,name)=>sum+measure(join(path,name)),0):0);};
 const constrained=new SdkSpoolV2({dir,maxQueueBytes:before.queueBytes,onPhase:phase=>{
  if(phase==='queue_transition_staged'){peaks++;expect(measure(join(dir,'queue'))+BLOCK).toBeLessThanOrEqual(before.queueBytes+2*BLOCK);}
 }});
 await constrained.markSending(target,selected[0].sourceId);await constrained.hold(target,selected[0].sourceId,'unknown');
 expect(peaks).toBe(2);expect(readdirSync(join(dir,'queue','.transitions'))).toEqual([]);
 expect(await store.load(target,selected[0].sourceId)).toEqual(selected[0].body);
});

it('rejects a symlinked transition workspace without writing outside the spool',async()=>{
 const {dir,store,selected}=await fixture(1,0,256),outside=root();
 rmSync(join(dir,'queue','.transitions'),{recursive:true});symlinkSync(outside,join(dir,'queue','.transitions'));
 await expect(store.markSending(target,selected[0].sourceId)).rejects.toMatchObject({code:'STORE_UNSAFE'});
 expect(readdirSync(outside)).toEqual([]);
});


it('preserves a legacy 1240-ref layout that is actually over the byte quota',async()=>{
 const {dir,store,selected}=await fixture(1240,0,256);
 rmSync(join(dir,'queue','.transitions'),{recursive:true});
 const usage=await store.usage();
 if(usage.queueBytes<=5*MiB)fill(join(dir,'queue','preserved-pressure.tmp'),5*MiB-usage.queueBytes+BLOCK);
 const before=await store.usage();expect(before.queueBytes).toBeGreaterThan(5*MiB);
 await expect(store.markSending(target,selected[0].sourceId)).rejects.toMatchObject({code:'QUEUE_FULL'});
 expect(await store.usage()).toEqual(before);expect(await store.pending(target)).toHaveLength(1240);
 expect(readdirSync(join(dir,'originals'))).toHaveLength(1240);
 expect(await store.load(target,selected[0].sourceId)).toEqual(selected[0].body);
});
