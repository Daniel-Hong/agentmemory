import {afterEach,expect,it} from 'vitest';
import {mkdtemp,writeFile,rename,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
const root=process.env.AM_SYNTHETIC_BASELINE_ROOT??resolve('.');
const {createStateDurabilityFence}=await import(pathToFileURL(join(root,'src/ops/state-durability.mjs')).href);
const {createBackgroundControl}=await import(pathToFileURL(join(root,'src/ops/background-control.mjs')).href);
const {createMemoryPressureGuard}=await import(pathToFileURL(join(root,'src/ops/memory-pressure.mjs')).href);
const dirs:string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})));});
async function fixture(gateActivation=false){
 let releaseActivation!:()=>void,queued!:()=>void;const activationReleased=new Promise<void>(r=>{releaseActivation=r;}),activationQueued=new Promise<void>(r=>{queued=r;});
 const dir=await mkdtemp(join(tmpdir(),'am-protection-disk-'));dirs.push(dir);const scopes=new Map<string,Map<string,unknown>>();let published=Promise.resolve(),sequence=0;
 const durability=createStateDurabilityFence({storePath:dir,timeoutMs:1000,pollIntervalMs:1});
 const kv={durability,get:async(scope:string,key:string)=>scopes.get(scope)?.get(key)??null,set:async(scope:string,key:string,value:unknown)=>{
  await durability.mutate(scope,key,async()=>{
   if(!scopes.has(scope))scopes.set(scope,new Map());scopes.get(scope)!.set(key,structuredClone(value));
   const body=JSON.stringify(Object.fromEntries(scopes.get(scope)!)),path=join(dir,encodeURIComponent(scope)+'.bin'),next=path+'.'+(++sequence);
   const blocked=gateActivation&&(value as any)?.paused===false&&(value as any)?.recovery?.attempts>0;if(blocked)queued();
   published=published.then(async()=>{if(blocked)await activationReleased;await new Promise(r=>setTimeout(r,3));await writeFile(next,body);await rename(next,path);});
  });
 }};
 let now=1000,available=1024**3;const control=createBackgroundControl({clock:()=>now});await control.init(kv);
 const guard=createMemoryPressureGuard({control,schedule:false,clock:()=>now,readSample:async()=>({total:8*1024**3,available})});
 const stable=async()=>{available=4*1024**3;for(let i=0;i<25;i++){now+=5000;await guard.refresh();}};
 return{dir,kv,control,guard,stable,activationQueued,releaseActivation,finish:()=>published};
}
it('opens memory-only admission only after delayed real disk publications are certified',async()=>{
 const f=await fixture(true);let stabilizing:Promise<void>|undefined;try{
  await f.guard.refresh();await f.control.settled();expect(f.control.snapshot().status).toBe('paused');
  stabilizing=f.stable();await f.activationQueued;await new Promise(r=>setImmediate(r));
  expect(f.control.isPaused()).toBe(true);expect(await f.control.run(async()=> 'admitted')).toMatchObject({deferred:true});
  f.releaseActivation();await stabilizing;await f.guard.drain();
  expect(f.control.snapshot()).toMatchObject({status:'running',pausedRequested:false,holds:[],recovery:{attempts:1}});
  const disk=JSON.parse(await readFile(join(f.dir,encodeURIComponent('mem:background-control:v1')+'.bin'),'utf8'));
  expect(disk['manual-pause']).toMatchObject({version:2,paused:false,resumePending:true,holds:[],recovery:{attempts:1}});
  expect(f.kv.durability.snapshot().lastVerification).toMatchObject({status:'verified'});
 }finally{f.releaseActivation();await stabilizing;await f.guard.drain();await f.guard.stop();await f.finish();}
});
it('preserves manual hold through stable memory and verifies its explicit partial release before automatic recovery',async()=>{
 const f=await fixture();try{
  await f.guard.refresh();await f.control.settled();await f.control.change('pause');await f.control.settled();
  await f.stable();expect(f.control.snapshot()).toMatchObject({status:'paused',holds:['manual','memory']});
  await f.control.change('resume');expect(f.control.snapshot()).toMatchObject({status:'paused',holds:['memory']});
  await f.guard.refresh();await f.guard.drain();
  expect(f.control.snapshot()).toMatchObject({status:'running',holds:[]});
  const disk=JSON.parse(await readFile(join(f.dir,encodeURIComponent('mem:background-control:v1')+'.bin'),'utf8'));
  expect(disk['manual-pause']).toMatchObject({paused:false,resumePending:true,holds:[]});
  expect(f.kv.durability.snapshot().lastVerification).toMatchObject({status:'verified'});
 }finally{await f.guard.stop();await f.finish();}
});
