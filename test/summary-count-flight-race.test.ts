import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,writeFile,rm,rename} from 'node:fs/promises';
import {setImmediate as turn} from 'node:timers/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSummaryCount} from '../src/ops/summary-count.mjs';

const observed=vi.hoisted(()=>({path:'',stats:0,opens:0,entered:null as null|(()=>void),gate:null as null|Promise<void>}));
vi.mock('node:fs/promises',async original=>{
 const fs=await original<typeof import('node:fs/promises')>();
 return{...fs,open:async(...args:Parameters<typeof fs.open>)=>{
  if(String(args[0])===observed.path)observed.opens++;
  return fs.open(...args);
 },stat:async(...args:Parameters<typeof fs.stat>)=>{
  const value=await fs.stat(...args);
  if(String(args[0])===observed.path&&++observed.stats===3){observed.entered?.();await observed.gate;}
  return value;
 }};
});
const dirs:string[]=[];
afterEach(async()=>{observed.path='';observed.gate=null;observed.entered=null;await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});

it('keeps the physical count flight shared until final generation validation and cache publication finish',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am-summary-flight-'));dirs.push(dir);
 const path=join(dir,encodeURIComponent('mem:summaries')+'.bin');await writeFile(path,'{"one":{}}');
 let release!:()=>void,entered!:()=>void;
 observed.path=path;observed.stats=0;observed.opens=0;
 observed.gate=new Promise<void>(resolve=>release=resolve);const ready=new Promise<void>(resolve=>entered=resolve);observed.entered=entered;
 const counter=createSummaryCount({storePath:dir,kv:{}});const first=counter.count();let late:Promise<number>|undefined;
 try{
  await ready;late=counter.count();
  await vi.waitFor(()=>expect(observed.stats).toBeGreaterThanOrEqual(4));await turn();
  expect(observed.opens).toBe(1);release();expect(await Promise.all([first,late])).toEqual([1,1]);
 }finally{release();await Promise.allSettled([first,...late?[late]:[]]);}
});
it('revalidates a publication changed during the flight and applies latest pending inserts and deletes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am-summary-flight-'));dirs.push(dir);
 const path=join(dir,encodeURIComponent('mem:summaries')+'.bin');await writeFile(path,'{"one":{}}');
 let release!:()=>void,entered!:()=>void;
 observed.path=path;observed.stats=0;observed.opens=0;
 observed.gate=new Promise<void>(resolve=>release=resolve);const ready=new Promise<void>(resolve=>entered=resolve);observed.entered=entered;
 const counter=createSummaryCount({storePath:dir,kv:{}}),first=counter.count();
 try{
  await ready;await writeFile(path+'.next','{"one":{},"other":null}');await rename(path+'.next',path);
  counter.record('pending',true,counter.prepare({sessionId:'pending'}));counter.record('one',false);
  release();expect(await first).toBe(2);expect(await counter.count()).toBe(2);
 }finally{release();await first.catch(()=>{});}
});
