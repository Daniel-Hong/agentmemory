import {it,expect,vi} from 'vitest';
import {mkdtemp,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';import {performance} from 'node:perf_hooks';
const model=vi.hoisted(()=>({mainPath:'',mainBytes:0,mainReads:[] as any[],bulkReads:[] as any[],stopReason:null as null|string,guard:null as AbortController|null,peakRss:0,peakHeap:0}));
const abortableDelay=(ms:number,signal?:AbortSignal)=>new Promise<void>((resolve,reject)=>{if(signal?.aborted){reject(signal.reason);return;}let timer:ReturnType<typeof setTimeout>;const done=()=>{signal?.removeEventListener('abort',abort);resolve();};const abort=()=>{clearTimeout(timer);reject(signal?.reason);};timer=setTimeout(done,ms);signal?.addEventListener('abort',abort,{once:true});});
vi.mock('../src/ops/namespace-reader.mjs',async importOriginal=>{
 const actual:any=await importOriginal();
 return {...actual,readNamespaceEntries:async(path:string,options:any)=>{
  const signal=model.guard?AbortSignal.any([...(options.signal?[options.signal]:[]),model.guard.signal]):options.signal;
  const isMain=path===model.mainPath,isBulk=typeof options.onEntry==='function';
  let row:any;
  if(isMain&&!isBulk){row={startedAt:performance.now(),openedAt:null,finishedAt:null,injectedDelayMs:0,bytesRead:0,complete:false};model.mainReads.push(row);}
  if(isMain&&isBulk){row={startedAt:performance.now(),openedAt:null,finishedAt:null,bytesRead:0,complete:false};model.bulkReads.push(row);}
  const pulse=()=>{const m=process.memoryUsage();model.peakRss=Math.max(model.peakRss,m.rss);model.peakHeap=Math.max(model.peakHeap,m.heapUsed);if(m.rss>256*1024*1024&&!model.stopReason){model.stopReason='worker_rss_limit';model.guard?.abort(Error(model.stopReason));}};
  pulse();
  const paced=isMain&&!isBulk;
  try{return await actual.readNamespaceEntries(path,{...options,signal,
   ...(paced?{withReadChunk:async(work:any)=>{const began=performance.now();await abortableDelay(9000/Math.ceil(model.mainBytes/(64*1024)),signal);row.injectedDelayMs+=performance.now()-began;return work();}}:{}),
   onOpen:(info:any)=>{if(row)row.openedAt=performance.now();options.onOpen?.(info);},
   onProgress:(info:any)=>{pulse();options.onProgress?.(info);},
   onRead:(info:any)=>{if(row)Object.assign(row,{bytesRead:info.bytesRead,complete:info.complete});options.onRead?.(info);},
  });}catch(e:any){if(['EIO','ENOSPC','EROFS'].includes(e?.code)){model.stopReason='synthetic_store_io_error';model.guard?.abort(Error(model.stopReason));}throw e;}
  finally{if(row)row.finishedAt=performance.now();pulse();}
 }};
});
import {createStateDurabilityFence} from '../src/ops/state-durability.mjs';
import {createObservationReader} from '../src/ops/observation-pages.mjs';
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(fn:()=>boolean,limit=2000){const end=performance.now()+limit;while(!fn()&&performance.now()<end)await pause(2);if(!fn())throw Error('diagnostic_setup_not_ready');}
it('lets late and small proofs finish without a duplicate physical read',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am-latejoin-realtime-'));const output=process.env.AM_LATEJOIN_RESULT??join(dir,'result.json');const results:any[]=[];let report:any={syntheticOnly:true,engineUsed:false,sdkQueries:'synthetic expected-value lookup',productChanged:false,realClock:true,injectedMainScanDelayMs:9000,results};const began=performance.now();
 const scope='mem:obs:diagnostic',smallScope='mem:obs:probe';const rows:any={};for(let i=0;i<24;i++)rows['synthetic_'+i]={id:'synthetic_'+i,timestamp:'2026-10-27T00:00:00Z',title:'synthetic',narrative:'x'.repeat(256*1024),sourceRaw:{synthetic:true}};
 const probe={id:'probe',narrative:'p'.repeat(60*1024)};
 model.mainPath=join(dir,encodeURIComponent(scope)+'.bin');const smallPath=join(dir,encodeURIComponent(smallScope)+'.bin');
 try{
  await writeFile(model.mainPath,JSON.stringify(rows));await writeFile(smallPath,JSON.stringify({probe}));model.mainBytes=(await stat(model.mainPath)).size;const total=model.mainBytes+(await stat(smallPath)).size;expect(total).toBeLessThanOrEqual(8*1024*1024);const original=createHash('sha256').update(await readFile(model.mainPath)).digest('hex');
  report={...report,storeBytes:total,mainBytes:model.mainBytes,temporaryStore:dir};await writeFile(output,JSON.stringify(report,null,2));
  for(const [index,coordinated] of [true].entries()){
   if(model.stopReason||performance.now()-began>240000)break;
   model.mainReads=[];model.bulkReads=[];model.guard=new AbortController();model.peakRss=0;model.peakHeap=0;
   const armBegan=performance.now(),fence=createStateDurabilityFence({storePath:dir,timeoutMs:15000,pollIntervalMs:100});
   const kv={get:async(s:string,k:string)=>s===scope?rows[k]??null:s===smallScope&&k==='probe'?probe:null,...(coordinated?{durability:fence}:{})};const reader=createObservationReader({storePath:dir,kv});
   let peakQueue=0;const sampler=setInterval(()=>{peakQueue=Math.max(peakQueue,fence.snapshot().readCoordination.queued);const m=process.memoryUsage();model.peakRss=Math.max(model.peakRss,m.rss);model.peakHeap=Math.max(model.peakHeap,m.heapUsed);if(m.rss>256*1024*1024&&!model.stopReason){model.stopReason='worker_rss_limit';model.guard?.abort(Error(model.stopReason));}},100);
   const request=(s=scope,k='synthetic_0')=>{const start=performance.now();return fence.waitForKeys(kv,[{scope:s,key:k}]).then((v:any)=>({ok:true,elapsedMs:performance.now()-start,synced:v.synced}), (e:any)=>({ok:false,elapsedMs:performance.now()-start,code:e.code,stage:e.diagnostics?.stage,cause:e.diagnostics?.errorCode}));};
   let arm:any;
   try{
    const first=Array.from({length:5},()=>request());await until(()=>model.mainReads[0]?.openedAt&&fence.snapshot().readSharing.activeWaiters===5);
    const firstOpen=model.mainReads[0].openedAt;await pause(Math.max(0,firstOpen+300-performance.now()));const bulkStart=performance.now();const bulk=reader.list(scope).then((v:any)=>({ok:true,rows:v.length,elapsedMs:performance.now()-bulkStart}), (e:any)=>({ok:false,code:e.code,elapsedMs:performance.now()-bulkStart}));
    await until(()=>coordinated?fence.snapshot().readCoordination.queuedBulk>0:model.bulkReads[0]?.openedAt);
    await pause(Math.max(0,firstOpen+1000-performance.now()));const lateArrivalMs=performance.now()-firstOpen;const beforeLate=fence.snapshot().readCoordination;const late=request(),small=request(smallScope,'probe').then(value=>({...value,settledWhileMainActive:model.mainReads[0]?.finishedAt===null}));
    const early=await Promise.all(first),lateResult=await late,smallResult=await small,bulkResult=await bulk;await fence.drain();
    const snap=fence.snapshot();arm={index,coordinated,lateArrivalMs,early,late:lateResult,small:smallResult,bulk:bulkResult,beforeLate,elapsedMs:performance.now()-armBegan,mainPhysicalReads:model.mainReads.map(r=>({...r,startedAt:r.startedAt-armBegan,openedAt:r.openedAt===null?null:r.openedAt-armBegan,finishedAt:r.finishedAt-armBegan})),bulkReads:model.bulkReads.length,peakQueued:peakQueue,peakRssBytes:model.peakRss,peakHeapBytes:model.peakHeap,readSharing:snap.readSharing,coordination:snap.readCoordination,totals:snap.measurements.totals};
    results.push(arm);await writeFile(output,JSON.stringify({...report,results,stopReason:model.stopReason,elapsedMs:performance.now()-began},null,2));
    if(model.stopReason)break;
    expect(early.every(r=>r.ok&&r.synced)).toBe(true);expect(bulkResult.ok).toBe(true);expect(smallResult.ok).toBe(true);expect(lateResult.ok).toBe(true);expect(model.mainReads).toHaveLength(1);expect(smallResult.settledWhileMainActive).toBe(true);
    expect(snap.readCoordination.activeCritical).toBe(0);expect(snap.readCoordination.activeBulk).toBe(false);expect(snap.readCoordination.queued).toBe(0);expect(snap.readSharing.activeWaiters).toBe(0);expect(snap.readSharing.sharedJobs).toBe(0);expect(arm.elapsedMs).toBeLessThan(30000);
   }finally{clearInterval(sampler);model.guard?.abort();await fence.drain();}
  }
  const sourceUnchanged=createHash('sha256').update(await readFile(model.mainPath)).digest('hex')===original;report={...report,results,sourceUnchanged,stopReason:model.stopReason,elapsedMs:performance.now()-began,allArmsSettled:results.every(r=>r.coordination.activeCritical===0&&r.coordination.activeBulk===false&&r.coordination.queued===0),portsUsed:false};
  await writeFile(output,JSON.stringify(report,null,2));expect(sourceUnchanged).toBe(true);expect(model.stopReason).toBeNull();expect(results).toHaveLength(1);expect(report.elapsedMs).toBeLessThan(300000);
 }finally{model.guard?.abort();await rm(dir,{recursive:true,force:true});report={...report,temporaryStoreRemoved:true};if(process.env.AM_LATEJOIN_RESULT)await writeFile(output,JSON.stringify(report,null,2));}
},30000);
