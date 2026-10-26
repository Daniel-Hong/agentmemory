import {afterEach,expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStateDurabilityFence} from '../src/ops/state-durability.mjs';

const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function fixture(timeoutMs=500){
 const dir=await mkdtemp(join(tmpdir(),'am-capture-window-'));dirs.push(dir);
 const rows=Object.fromEntries(Array.from({length:8},(_,i)=>[String(i),{n:i}]));
 await writeFile(join(dir,'synthetic.bin'),JSON.stringify(rows));
 const selected=Object.keys(rows).map(key=>({scope:'synthetic',key}));
 return {rows,selected,fence:createStateDurabilityFence({storePath:dir,timeoutMs})};
}

it('uses a freed capture slot while a peer lookup remains pending, without exceeding four lookups',async()=>{
 const f=await fixture();let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const started:string[]=[];let active=0,peak=0;
 const kv={get:async(_scope:string,key:string)=>{
  started.push(key);peak=Math.max(peak,++active);
  try{if(key==='0')await gate;return f.rows[key];}finally{active--;}
 }};
 const pending=f.fence.waitForKeys(kv,f.selected);
 try{await tick();await tick();expect(started).toHaveLength(8);expect(peak).toBeLessThanOrEqual(4);}
 finally{release();await pending;}
 expect(f.fence.snapshot().lastVerification).toMatchObject({status:'verified',capturedKeyCount:8});
});

it('stops dispatching after capture failure even when other SDK lookups settle later',async()=>{
 const f=await fixture();let release!:()=>void;const gate=new Promise<void>(r=>release=r);const started:string[]=[];
 const pending=f.fence.waitForKeys({get:async(_scope:string,key:string)=>{
  started.push(key);if(key==='0')throw Error('synthetic SDK failure');await gate;return f.rows[key];
 }},f.selected);
 await expect(pending).rejects.toMatchObject({code:'STATE_DURABILITY_TIMEOUT',diagnostics:{stage:'capture',errorCode:'STATE_CAPTURE_FAILED'}});
 const before=JSON.stringify(f.fence.snapshot().measurements);release();await tick();await tick();
 expect(started).toHaveLength(4);expect(JSON.stringify(f.fence.snapshot().measurements)).toBe(before);
});

it('does not dispatch beyond the original deadline after late SDK completion',async()=>{
 const f=await fixture(15);let release!:(v:unknown)=>void;const gate=new Promise<unknown>(r=>release=r);const started:string[]=[];
 await expect(f.fence.waitForKeys({get:async(_scope:string,key:string)=>{started.push(key);return gate;}},f.selected))
  .rejects.toMatchObject({code:'STATE_DURABILITY_TIMEOUT',diagnostics:{stage:'capture'}});
 const before=JSON.stringify(f.fence.snapshot().measurements);release({n:0});await tick();await tick();
 expect(started).toHaveLength(4);expect(JSON.stringify(f.fence.snapshot().measurements)).toBe(before);
});

it('does not let a sibling timer replace the recorded cause of an early capture failure',async()=>{
 const f=await fixture(20);let release!:(v:unknown)=>void;const gate=new Promise<unknown>(r=>release=r);
 await expect(f.fence.waitForKeys({get:async(_scope:string,key:string)=>{
  if(key==='0')throw Error('synthetic SDK failure');return gate;
 }},f.selected)).rejects.toMatchObject({diagnostics:{errorCode:'STATE_CAPTURE_FAILED'}});
 const before=JSON.stringify(f.fence.snapshot().lastVerification);
 try{await new Promise(resolve=>setTimeout(resolve,35));expect(JSON.stringify(f.fence.snapshot().lastVerification)).toBe(before);}
 finally{release({n:0});await tick();}
});

it('retains pinned-value rejection rather than certifying a changed SDK value',async()=>{
 const f=await fixture();
 await expect(f.fence.waitForKeys({get:async(_scope:string,key:string)=>key==='0'?{n:'changed'}:f.rows[key]},f.selected,{expectedValues:Object.values(f.rows)}))
  .rejects.toMatchObject({code:'STATE_DURABILITY_TIMEOUT',diagnostics:{stage:'capture',errorCode:'STATE_EXPECTATION_CHANGED'}});
 expect(f.fence.snapshot().measurements.totals.verified).toBe(0);
});
