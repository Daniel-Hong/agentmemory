import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, statSync, truncateSync, symlinkSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { SdkSpoolV2 } from '../src/capture/sdk-spool-v2.js';
const MiB=1024*1024;
const target='https://synthetic.invalid/observe?credential=not-real';
let dir:string;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'sdk-spool-v2-'));});
afterEach(()=>rmSync(dir,{recursive:true,force:true}));
const body=(eventId='event-1',data:unknown={text:'synthetic'})=>({eventId,captureCompletion:'sdk-v1',timestamp:'2026-01-01T00:00:00Z',data});
const store=(options:Record<string,unknown>={})=>new SdkSpoolV2({dir,...options});
function files(root=dir):string[]{return readdirSync(root,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(root,e.name)):[join(root,e.name)]);}

describe('SdkSpoolV2 durable originals and references',()=>{
 it('retains exact 8 MiB canonical envelope and rejects one extra byte',async()=>{
  const initial=body('boundary',{text:''}); const overhead=Buffer.byteLength(JSON.stringify(initial));
  const exact=body('boundary',{text:'x'.repeat(8*MiB-overhead)});
  const s=store(); const retained=await s.retain(target,'boundary',exact);
  expect(await s.load(target,retained.sourceId)).toEqual(exact);
  await expect(s.retain(target,'boundary',{...exact,data:{text:'x'.repeat(8*MiB-overhead+1)}})).rejects.toMatchObject({code:'SOURCE_TOO_LARGE'});
  expect(files().filter(p=>p.endsWith('.chunk')).every(p=>statSync(p).size<=256*1024)).toBe(true);
 });
 it('reuses first timestamp, preserves arrays and own __proto__, and isolates endpoint',async()=>{
  const s=store(); const original=JSON.parse('{"eventId":"event-1","timestamp":"first","data":{"__proto__":{"safe":1},"values":[1,null,{"__proto__":2}]}}');
  const first=await s.retain(target,'event-1',original);
  const again=await s.retain(target,'event-1',{...original,timestamp:'second'});
  expect(again).toMatchObject({duplicate:true,conflict:false,sourceId:first.sourceId,body:original});
  expect(await s.load(target,first.sourceId)).toEqual(original);
  expect(Object.prototype.hasOwnProperty.call((again.body.data as any),'__proto__')).toBe(true);
  await expect(s.load('https://else.invalid',first.sourceId)).rejects.toMatchObject({code:'SOURCE_UNVERIFIED'});
  expect(files().filter(p=>!p.endsWith('.chunk')).map(p=>readFileSync(p,'utf8')).join('')).not.toContain(target);
 });
 it('preserves changed-payload conflict and prohibits queueing it',async()=>{
  const s=store(); const first=await s.retain(target,'event-1',body());
  const conflict=await s.retain(target,'event-1',body('event-1',{text:'changed'}));
  expect(conflict.conflict).toBe(true); expect(conflict.sourceId).not.toBe(first.sourceId);
  await expect(s.enqueue(target,conflict.sourceId)).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
  expect(await s.load(target,first.sourceId)).toEqual(body());
  expect(await s.load(target,conflict.sourceId)).toEqual(body('event-1',{text:'changed'}));
 });
 it('matches prompt backfill semantics while keeping other data changes distinct',async()=>{
  const s=store(); const first=await s.retain(target,'event-1',{...body(),hookType:'prompt_submit',data:{prompt:'hello'}});
  const next=await s.retain(target,'event-1',{...body(),hookType:'prompt_submit',data:{prompt:'hello',backfill:true}});
  expect(next.sourceId).toBe(first.sourceId); expect(next.duplicate).toBe(true);
 });
 it('rejects 256 MiB sparse orphan originals without deleting them',async()=>{
  const s=store(); await s.usage(); const orphan=join(dir,'originals','orphan');writeFileSync(orphan,'',{mode:0o600});truncateSync(orphan,256*MiB);
  await expect(s.retain(target,'event-1',body())).rejects.toMatchObject({code:'ORIGINALS_FULL'});
  expect(statSync(orphan).size).toBe(256*MiB);
 });
 it('rejects 5 MiB sparse queue orphan while preserving retained source',async()=>{
  const s=store();const retained=await s.retain(target,'event-1',body());const orphan=join(dir,'queue','orphan');writeFileSync(orphan,'',{mode:0o600});truncateSync(orphan,5*MiB);
  await expect(s.enqueue(target,retained.sourceId)).rejects.toMatchObject({code:'QUEUE_FULL'});
  expect(await s.load(target,retained.sourceId)).toEqual(body());
 });
 it('requires source hash readback before enqueue and preserves corruption',async()=>{
  const s=store();const retained=await s.retain(target,'event-1',body());
  const chunk=files().find(p=>p.endsWith('.chunk'))!;writeFileSync(chunk,'corrupted');
  await expect(s.enqueue(target,retained.sourceId)).rejects.toMatchObject({code:'SOURCE_UNVERIFIED'});
  expect(readFileSync(chunk,'utf8')).toBe('corrupted');expect(await s.pending(target)).toEqual([]);
 });
 it.each(['chunk_fsynced','manifest_fsynced','source_published'])('preserves interruption at %s and never queues incomplete data',async phase=>{
  const s=store({onPhase:(p:string)=>{if(p===phase)throw Error('synthetic crash');}});
  await expect(s.retain(target,'event-1',body())).rejects.toBeDefined();
  const recovered=store();expect(await recovered.pending(target)).toEqual([]);expect((await recovered.usage()).originalBytes).toBeGreaterThan(4096);
  expect(files().some(p=>p.endsWith('.chunk'))).toBe(true);
 });
 it('fsyncs complete source and verifies readback before returning',async()=>{
  const phases:string[]=[];const s=store({onPhase:(p:string)=>phases.push(p)});const r=await s.retain(target,'event-1',body());await s.enqueue(target,r.sourceId);
  expect(phases.indexOf('chunk_fsynced')).toBeLessThan(phases.indexOf('manifest_fsynced'));
  expect(phases.indexOf('manifest_fsynced')).toBeLessThan(phases.indexOf('source_published'));
  expect(phases.indexOf('source_verified')).toBeLessThan(phases.indexOf('reference_published'));
 });
 it('persists sending, preserves live owner, and holds obsolete owner epoch',async()=>{
  const s=store();const r=await s.retain(target,'event-1',body());await s.enqueue(target,r.sourceId);await s.markSending(target,r.sourceId);
  expect((await store().pending(target))[0].state).toBe('sending');
  const ref=files(join(dir,'queue')).find(p=>p.endsWith('.ref'))!;const value=JSON.parse(readFileSync(ref,'utf8'));value.owner.start='obsolete';writeFileSync(ref,JSON.stringify(value));
  expect((await store().pending(target))[0].state).toBe('held');
  await expect(s.markSending(target,r.sourceId)).rejects.toMatchObject({code:'SOURCE_HELD'});
 });
 it('retries with bounded backoff and stores no caller-provided reason payload',async()=>{
  const s=store();const r=await s.retain(target,'event-1',body());await s.enqueue(target,r.sourceId);await s.markSending(target,r.sourceId);const before=Date.now();await s.retry(target,r.sourceId,'sensitive arbitrary reason');
  const [ref]=await s.pending(target);expect(ref.attempts).toBe(1);expect(ref.nextAttemptAt).toBeGreaterThanOrEqual(before+1000);expect(ref.nextAttemptAt).toBeLessThanOrEqual(Date.now()+300000);
  expect(files(join(dir,'queue')).map(p=>readFileSync(p,'utf8')).join('')).not.toContain('sensitive');
 });
 it('ACK survives recreation, removes reference, and preserves all original bytes',async()=>{
  const s=store();const r=await s.retain(target,'event-1',body());await s.enqueue(target,r.sourceId);await s.markSending(target,r.sourceId);const chunks=files().filter(p=>p.endsWith('.chunk'));await s.acknowledge(target,r.sourceId);
  expect(await store().pending(target)).toEqual([]);expect((await store().retain(target,'event-1',body())).completed).toBe(true);
  expect(await s.load(target,r.sourceId)).toEqual(body());expect(chunks.every(p=>statSync(p).isFile())).toBe(true);
  await s.enqueue(target,r.sourceId);expect(await s.pending(target)).toEqual([]);
 });
 it('holds uncertain ACK update and retains source/reference on failure',async()=>{
  const s=store();const r=await s.retain(target,'event-1',body());await s.enqueue(target,r.sourceId);await s.markSending(target,r.sourceId);
  const failing=store({onPhase:(phase:string)=>{if(phase==='ack_before_publish')throw Error('synthetic');}});
  await expect(failing.acknowledge(target,r.sourceId)).rejects.toBeDefined();expect((await s.pending(target))[0].state).not.toBe('pending');expect(await s.load(target,r.sourceId)).toEqual(body());
 });
 it('rejects symlinks and path traversal without touching their destination',async()=>{
  const s=store();await s.usage();const outside=join(dir,'outside');writeFileSync(outside,'safe');symlinkSync(outside,join(dir,'originals','link'));
  await expect(s.retain(target,'event-1',body())).rejects.toMatchObject({code:'STORE_UNSAFE'});expect(readFileSync(outside,'utf8')).toBe('safe');
  await expect(s.load(target,'../../outside')).rejects.toMatchObject({code:'SOURCE_UNVERIFIED'});
 });
 it('serializes competing small-quota writers without overcommit',async()=>{
  const s=store({maxOriginalBytes:20*1024});
  const results=await Promise.allSettled(Array.from({length:6},(_,i)=>store({maxOriginalBytes:20*1024}).retain(target,'race-'+i,body('race-'+i))));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect((await s.usage()).originalBytes).toBeLessThanOrEqual(20*1024);
 });
 it('serializes actual child processes sharing one source quota',async()=>{
  const moduleUrl=pathToFileURL(join(process.cwd(),'src/capture/sdk-spool-v2.ts')).href;
  const run=(index:number)=>new Promise<{status:string,code?:string}>((resolve,reject)=>{
   const program=`import { SdkSpoolV2 } from ${JSON.stringify(moduleUrl)};const s=new SdkSpoolV2({dir:process.argv[1],maxOriginalBytes:20480});try{await s.retain('synthetic-target',process.argv[2],{eventId:process.argv[2],data:'synthetic'});console.log(JSON.stringify({status:'ok'}));}catch(e){console.log(JSON.stringify({status:'error',code:e.code}));}`;
   const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',program,dir,'child-'+index],{env:{...process.env,HOME:dir},stdio:['ignore','pipe','pipe']});
   let output='';let errors='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>errors+=data);child.on('error',reject);child.on('exit',status=>{try{if(status!==0)throw Error(errors);resolve(JSON.parse(output.trim()));}catch(error){reject(error);}});
  });
  const results=await Promise.all(Array.from({length:6},(_,index)=>run(index)));
  expect(results.filter(value=>value.status==='ok')).toHaveLength(1);
  expect(results.filter(value=>value.status==='error').every(value=>value.code==='ORIGINALS_FULL')).toBe(true);
  expect((await store().usage()).originalBytes).toBeLessThanOrEqual(20480);
 });
 it('reserves bounded sending-state workspace beyond the queue admission quota',async()=>{
  const s=store();const r=await s.retain(target,'event-1',body());await s.enqueue(target,r.sourceId);
  const before=(await s.usage()).queueBytes;const constrained=store({maxQueueBytes:before});
  await expect(constrained.markSending(target,r.sourceId)).resolves.toBeUndefined();
  expect((await s.pending(target))[0].state).toBe('sending');
  expect((await s.usage()).queueBytes).toBeLessThanOrEqual(before+8192);
 });
 it('fails explicitly when a conflict original cannot fit',async()=>{
  const s=store();const r=await s.retain(target,'event-1',body());const before=(await s.usage()).originalBytes;
  await expect(store({maxOriginalBytes:before}).retain(target,'event-1',body('event-1',{changed:true}))).rejects.toMatchObject({code:'ORIGINALS_FULL'});
  expect(await s.load(target,r.sourceId)).toEqual(body());
 });

 it('rejects corrupt manifest and missing chunks while retaining every remaining original',async()=>{
  const s=store();const r=await s.retain(target,'event-1',body());const manifest=join(dir,'originals',r.sourceId,'manifest.json');
  const original=readFileSync(manifest);writeFileSync(manifest,'{"partial":');
  await expect(s.load(target,r.sourceId)).rejects.toMatchObject({code:'SOURCE_UNVERIFIED'});
  expect(readFileSync(manifest,'utf8')).toBe('{"partial":');writeFileSync(manifest,original);
  const chunk=files(join(dir,'originals',r.sourceId)).find(p=>p.endsWith('.chunk'))!;rmSync(chunk);
  await expect(s.enqueue(target,r.sourceId)).rejects.toMatchObject({code:'SOURCE_UNVERIFIED'});expect(statSync(manifest).isFile()).toBe(true);
 });
 it('keeps source and directory permissions private',async()=>{
  const s=store();const r=await s.retain(target,'event-1',body());await s.enqueue(target,r.sourceId);
  expect(statSync(join(dir,'originals',r.sourceId)).mode&0o777).toBe(0o700);
  expect(files().every(p=>(statSync(p).mode&0o777)===0o600)).toBe(true);
 });

 it('uses one bounded lease file and no growing ticket bookkeeping',async()=>{
  const s=store();for(let index=0;index<10;index++)await s.usage();
  expect(readdirSync(join(dir,'queue'))).toEqual(['lease.lock']);
  expect(statSync(join(dir,'queue','lease.lock')).size).toBe(0);
 });
 it('kernel releases crashed writer lease while preserving its partial original',async()=>{
  const moduleUrl=pathToFileURL(join(process.cwd(),'src/capture/sdk-spool-v2.ts')).href;
  const program=`import { SdkSpoolV2 } from ${JSON.stringify(moduleUrl)};const s=new SdkSpoolV2({dir:process.argv[1],onPhase:p=>{if(p==='chunk_fsynced'){console.log('synthetic-crash');process.exit(0);}}});await s.retain('target','crash',{eventId:'crash',data:'synthetic'});`;
  const output=await new Promise<string>((resolve,reject)=>{const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',program,dir],{env:{...process.env,HOME:dir},stdio:['ignore','pipe','pipe']});let output='';let errors='';child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>errors+=v);child.on('error',reject);child.on('close',status=>status===0?resolve(output):reject(Error(errors)));});
  expect(output.trim()).toBe('synthetic-crash');
  const s=store();const r=await s.retain(target,'event-1',body());expect(await s.load(target,r.sourceId)).toEqual(body());
  expect(readdirSync(join(dir,'originals')).some(name=>name.startsWith('.stage-'))).toBe(true);
  expect(readdirSync(join(dir,'queue'))).toEqual(['lease.lock']);
 });

 it('rejects impossible fixture budgets below fixed directory and lease charges',()=>{
  expect(()=>store({maxQueueBytes:1})).toThrowError('STORE_OPTIONS_INVALID');
  expect(()=>store({maxOriginalBytes:1})).toThrowError('STORE_OPTIONS_INVALID');
 });
 it('retains a new original even when existing queue data occupies its full allowance',async()=>{
  const s=store();await s.usage();const orphan=join(dir,'queue','full.tmp');writeFileSync(orphan,'',{mode:0o600});truncateSync(orphan,5*MiB);
  const r=await s.retain(target,'event-1',body());expect(await s.load(target,r.sourceId)).toEqual(body());
  await expect(s.enqueue(target,r.sourceId)).rejects.toMatchObject({code:'QUEUE_FULL'});
 });
 it('keeps the parent fd locked after the flock subprocess exits',async()=>{
  const moduleUrl=pathToFileURL(join(process.cwd(),'src/capture/sdk-spool-v2.ts')).href;
  const program=`import { SdkSpoolV2 } from ${JSON.stringify(moduleUrl)};const s=new SdkSpoolV2({dir:process.argv[1],onPhase:p=>{if(p==='chunk_fsynced'){console.log('locked');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,600);}}});await s.retain('target','held',{eventId:'held',data:'synthetic'});`;
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',program,dir],{env:{...process.env,HOME:dir},stdio:['ignore','pipe','pipe']});
  const finished=new Promise<void>((resolve,reject)=>{let errors='';child.stderr.on('data',v=>errors+=v);child.on('error',reject);child.on('close',status=>status===0?resolve():reject(Error(errors)));});
  await new Promise<void>((resolve,reject)=>{child.stdout.once('data',()=>resolve());child.once('error',reject);child.once('close',()=>reject(Error('missing lock-ready evidence')));});
  await expect(store().retain(target,'event-1',body())).rejects.toMatchObject({code:'STORE_BUSY'});
  await finished;expect((await store().retain(target,'event-1',body())).body).toEqual(body());
 });

 it('includes multi-block chunk directory growth in the pre-write original budget',async()=>{
  const sample=new SdkSpoolV2({dir:join(dir,'sample'),chunkBytes:16});
  const data=body('small-chunks',{text:'x'.repeat(5000)});await sample.retain(target,'small-chunks',data);
  const actual=(await sample.usage()).originalBytes;
  const limited=new SdkSpoolV2({dir:join(dir,'limited'),chunkBytes:16,maxOriginalBytes:actual-4096});
  await expect(limited.retain(target,'small-chunks',data)).rejects.toMatchObject({code:'ORIGINALS_FULL'});
  expect((await limited.usage()).originalBytes).toBeLessThanOrEqual(actual-4096);
 });

 it.each(['root','originals','queue','source'])('round1 rejects existing permissive %s directory without chmod',async kind=>{
  const s=store();const r=await s.retain(target,'event-1',body());
  const path=kind==='root'?dir:kind==='source'?join(dir,'originals',r.sourceId):join(dir,kind);
  chmodSync(path,0o777);
  await expect(s.load(target,r.sourceId)).rejects.toMatchObject({code:'STORE_UNSAFE'});
  expect(statSync(path).mode&0o7777).toBe(0o777);
 });
 it.each(['chunk','manifest','reference','lease'])('round1 rejects existing permissive %s file using fd validation',async kind=>{
  const s=store();const r=await s.retain(target,'event-1',body());await s.enqueue(target,r.sourceId);
  const path=kind==='chunk'?files().find(p=>p.endsWith('.chunk'))!:kind==='manifest'?join(dir,'originals',r.sourceId,'manifest.json'):kind==='reference'?join(dir,'queue',r.sourceId+'.ref'):join(dir,'queue','lease.lock');
  chmodSync(path,0o644);
  await expect(kind==='reference'?s.pending(target):s.load(target,r.sourceId)).rejects.toMatchObject({code:'STORE_UNSAFE'});
  expect(statSync(path).mode&0o7777).toBe(0o644);
 });
 it('round1 rejects a store owned by a different effective caller uid',async()=>{
  const s=store();await s.usage();const actualUid=process.geteuid!();
  const effectiveCaller=vi.spyOn(process,'geteuid').mockReturnValue(actualUid+1);
  try{await expect(s.usage()).rejects.toMatchObject({code:'STORE_UNSAFE'});}finally{effectiveCaller.mockRestore();}
 });
 it('round1 allows ordinary public ancestors without changing their mode',async()=>{
  const ancestor=join(dir,'shared');mkdirSync(ancestor,{mode:0o755});chmodSync(ancestor,0o755);
  const s=new SdkSpoolV2({dir:join(ancestor,'store')});const r=await s.retain(target,'event-1',body());
  expect(await s.load(target,r.sourceId)).toEqual(body());expect(statSync(ancestor).mode&0o7777).toBe(0o755);
 });
 it('round1 rejects unknown existing root layout without creating v2 subdirectories',async()=>{
  writeFileSync(join(dir,'legacy-spool.json'),'synthetic legacy',{mode:0o600});
  await expect(store().retain(target,'event-1',body())).rejects.toMatchObject({code:'STORE_UNSAFE'});
  expect(readdirSync(dir)).toEqual(['legacy-spool.json']);expect(readFileSync(join(dir,'legacy-spool.json'),'utf8')).toBe('synthetic legacy');
 });
 it.each(['manifest','chunk','reference'])('round1 rejects writerless %s FIFO before the child deadline',async kind=>{
  const s=store();const r=await s.retain(target,'event-1',body());await s.enqueue(target,r.sourceId);
  const path=kind==='manifest'?join(dir,'originals',r.sourceId,'manifest.json'):kind==='chunk'?files().find(p=>p.endsWith('.chunk'))!:join(dir,'queue',r.sourceId+'.ref');
  rmSync(path);expect(spawnSync('/usr/bin/mkfifo',['-m','600',path]).status).toBe(0);
  const moduleUrl=pathToFileURL(join(process.cwd(),'src/capture/sdk-spool-v2.ts')).href;
  const program=`import {SdkSpoolV2} from ${JSON.stringify(moduleUrl)};const s=new SdkSpoolV2({dir:process.argv[1]});try{${kind==='reference'?"await s.pending(process.argv[2])":"await s.load(process.argv[2],process.argv[3])"};console.log('unexpected-success');}catch(e){console.log(e.code);}`;
  const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',program,dir,target,r.sourceId],{env:{...process.env,HOME:dir},encoding:'utf8',timeout:1500,killSignal:'SIGKILL'});
  expect((result.error as NodeJS.ErrnoException | undefined)?.code).not.toBe('ETIMEDOUT');expect(result.status).toBe(0);expect(result.stdout.trim()).toBe('STORE_UNSAFE');
  expect(statSync(path).isFIFO()).toBe(true);
 });
 it('round1 reuses earliest conflict envelope across timestamp-only retries without growth',async()=>{
  const s=store();await s.retain(target,'event-1',body());
  const first=await s.retain(target,'event-1',{...body('event-1',{text:'conflict'}),timestamp:'first'});const before=await s.usage();
  const again=await s.retain(target,'event-1',{...body('event-1',{text:'conflict'}),timestamp:'second'});
  expect(again).toMatchObject({sourceId:first.sourceId,duplicate:true,conflict:true,body:first.body});
  expect(await s.usage()).toEqual(before);await expect(s.enqueue(target,again.sourceId)).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
 });
 it('round1 reuses prompt conflict across backfill-only retry but preserves real differences',async()=>{
  const s=store();await s.retain(target,'event-1',body());
  const envelope={...body(),hookType:'prompt_submit',data:{prompt:'conflict'}};
  const first=await s.retain(target,'event-1',envelope);const before=(await s.usage()).originalBytes;
  const again=await s.retain(target,'event-1',{...envelope,data:{prompt:'conflict',backfill:true}});
  expect(again).toMatchObject({sourceId:first.sourceId,duplicate:true,conflict:true,body:envelope});expect((await s.usage()).originalBytes).toBe(before);
  const changed=await s.retain(target,'event-1',{...envelope,data:{prompt:'different'}});expect(changed.sourceId).not.toBe(first.sourceId);expect(changed.conflict).toBe(true);
  const missingTimestamp={eventId:'event-1',captureCompletion:'sdk-v1',hookType:'prompt_submit',data:{prompt:'conflict'}};
  const missing=await s.retain(target,'event-1',missingTimestamp);expect(missing.sourceId).not.toBe(first.sourceId);expect(await s.load(target,first.sourceId)).toEqual(envelope);
 });

});
