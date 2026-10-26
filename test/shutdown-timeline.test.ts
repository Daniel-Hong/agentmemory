import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifiedShutdown} from '../src/ops/verified-shutdown.js';

const dirs:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});
async function run(work:any,extra:any={}) {
  const dir=await mkdtemp(join(tmpdir(),'am-timeline-'));dirs.push(dir);
  const result=await verifiedShutdown({receiptDir:dir,engineAlive:()=>true,timeoutMs:100,pollMs:5,work,...extra});
  return {result,disk:JSON.parse(await readFile(join(dir,'shutdown-receipt.json'),'utf8'))};
}

it('records bounded phase transitions and worker events in the existing final receipt',async()=>{
  const {result,disk}=await run(async(progress:any)=>{
    progress({stage:'lifecycle',raw:'private'});
    progress({stage:'worker_stop',workerIndex:0,event:'start',path:'private'});
    progress({stage:'worker_stop',workerIndex:0,event:'done'});
    progress({stage:'disk_fence'});
    return {synced:true,mutationFailures:0};
  });
  expect(result.verified).toBe(true);
  expect(disk.timeline).toMatchObject({version:1,limit:128,omittedEvents:0,unavailable:false});
  expect(disk.timeline.events).toEqual(expect.arrayContaining([
    expect.objectContaining({stage:'lifecycle',event:'start'}),expect.objectContaining({stage:'lifecycle',event:'done'}),
    expect.objectContaining({stage:'worker_stop',workerIndex:0,event:'start'}),
    expect.objectContaining({stage:'disk_fence',event:'done'}),
  ]));
  expect(disk.timeline.events.every((e:any)=>Number.isFinite(e.elapsedMs)&&e.elapsedMs>=0)).toBe(true);
  expect(JSON.stringify(disk)).not.toContain('private');
});

it('retains failure and timeout outcomes without inventing worker completion',async()=>{
  const {disk}=await run(async(progress:any)=>{progress({stage:'disk_fence'});throw Object.assign(Error('private'),{code:'EIO'});});
  expect(disk).toMatchObject({verified:false,errorCode:'EIO'});
  expect(disk.timeline.events).toContainEqual(expect.objectContaining({stage:'disk_fence',event:'interrupted'}));
  expect(disk.timeline.events.at(-1)).toMatchObject({stage:'work',event:'failed'});
  const timed=await run(async(progress:any)=>{progress({stage:'lifecycle'});progress({stage:'worker_drain',workerIndex:2,event:'start'});return new Promise(()=>{});},{timeoutMs:10});
  expect(timed.disk).toMatchObject({verified:false,errorCode:'SHUTDOWN_TIMEOUT',pendingWorkers:[{workerIndex:2}]});
  expect(timed.disk.timeline.events).toContainEqual(expect.objectContaining({stage:'lifecycle',event:'interrupted'}));
  expect(timed.disk.timeline.events.at(-1)).toMatchObject({stage:'work',event:'interrupted'});
  expect(timed.disk.timeline.events.some((e:any)=>e.workerIndex===2&&e.event==='done')).toBe(false);
});

it('bounds excess events and pending workers and reports missing coverage',async()=>{
  const {disk}=await run(async(progress:any)=>{
    progress({stage:'lifecycle'});
    for(let i=0;i<1000;i++)progress({stage:'worker_stop',workerIndex:i,event:'start'});
    return {synced:true,mutationFailures:1};
  });
  expect(disk.verified).toBe(false);
  expect(disk.timeline.events).toHaveLength(128);
  expect(disk.timeline.omittedEvents).toBeGreaterThan(0);
  expect(disk.pendingWorkers.length).toBeLessThanOrEqual(32);
  expect(disk.timeline.pendingWorkersTruncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(disk))).toBeLessThan(20000);
});

it('does not turn diagnostic clock or observer failure into a storage failure',async()=>{
  const original=Date.now;let calls=0;
  vi.spyOn(Date,'now').mockImplementation(()=>{if(++calls===2)throw Error('diagnostic clock');return original();});
  const {disk}=await run(async(progress:any)=>{progress({stage:'disk_fence'});return {synced:true,mutationFailures:0};},{onProgress:async()=>{throw Error('private');}});
  expect(disk).toMatchObject({verified:true,errorCode:null,timeline:{unavailable:true}});
});

it.each([NaN,Infinity])('marks non-finite final diagnostic time unavailable (%s)',async(value)=>{
  const original=Date.now;let calls=0;
  vi.spyOn(Date,'now').mockImplementation(()=>++calls===2?value:original());
  const {disk}=await run(async()=>({synced:true,mutationFailures:0}));
  expect(disk).toMatchObject({verified:true,errorCode:null,timeline:{unavailable:true}});
  expect(disk.timeline.events).toEqual([{stage:'work',event:'start',elapsedMs:0}]);
});

it('does not mutate a returned timeout timeline when work later finishes',async()=>{
  let release!:()=>void,finish!:()=>void;
  const gate=new Promise<void>(resolve=>release=resolve),done=new Promise<void>(resolve=>finish=resolve);
  const {result}=await run(async(progress:any)=>{
    progress({stage:'disk_fence'});await gate;progress({stage:'freeze'});finish();
    return {synced:true,mutationFailures:0};
  },{timeoutMs:10});
  const before=JSON.stringify(result.timeline);
  release();await done;
  expect(JSON.stringify(result.timeline)).toBe(before);
  expect(result).toMatchObject({verified:false,errorCode:'SHUTDOWN_TIMEOUT'});
});
