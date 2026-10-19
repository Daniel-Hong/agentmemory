import {it,expect} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createStateDurabilityFence} from '../src/ops/state-durability.mjs';
it('bounded parallel reads verify an already published namespace without a false timeout',async()=>{
 const storePath=await mkdtemp(join(tmpdir(),'am-fence-parallel-'));try{
  const rows=Object.fromEntries(Array.from({length:20},(_,i)=>['k'+i,{value:i}]));
  await writeFile(join(storePath,encodeURIComponent('synthetic:parallel')+'.bin'),JSON.stringify(rows));
  const fence=createStateDurabilityFence({storePath,timeoutMs:150,pollIntervalMs:5});
  for(const [key,value]of Object.entries(rows))await fence.mutate('synthetic:parallel',key,async()=>value);
  let active=0,maxActive=0;
  const kv={get:async(_scope:string,key:string)=>{active++;maxActive=Math.max(maxActive,active);await new Promise(r=>setTimeout(r,12));active--;return rows[key];}};
  const result=await fence.wait(kv);expect(result.synced).toBe(true);expect(maxActive).toBeGreaterThan(1);expect(maxActive).toBeLessThanOrEqual(4);
 }finally{await rm(storePath,{recursive:true,force:true});}
});
it('capture timeout exposes only safe phase and counts and retains dirty keys',async()=>{
 const storePath=await mkdtemp(join(tmpdir(),'am-fence-diagnostic-'));try{
  const fence=createStateDurabilityFence({storePath,timeoutMs:30,pollIntervalMs:5});
  await fence.mutate('synthetic:SECRET_NAMESPACE','SECRET_KEY',async()=>({SECRET_VALUE:true}));
  let error:any;try{await fence.wait({get:()=>new Promise(()=>{})});}catch(e){error=e;}
  expect(error.code).toBe('STATE_DURABILITY_TIMEOUT');expect(error.diagnostics.stage).toBe('capture');expect(error.diagnostics.keyCount).toBe(1);
  expect(JSON.stringify(error.diagnostics)).not.toContain('SECRET');expect(fence.keys()).toHaveLength(1);
  expect(fence.snapshot().lastVerification.errorCode).toBe('STATE_DURABILITY_TIMEOUT');
 }finally{await rm(storePath,{recursive:true,force:true});}
});
it('full drain verifies a large dirty set in bounded publications instead of one capture deadline',async()=>{
 const storePath=await mkdtemp(join(tmpdir(),'am-fence-large-drain-'));try{
  const rows=Object.fromEntries(Array.from({length:501},(_,i)=>['k'+i,{value:i}]));
  await writeFile(join(storePath,'synthetic%3Alarge.bin'),JSON.stringify(rows));
  let elapsed=0;const fence=createStateDurabilityFence({storePath,timeoutMs:260,pollIntervalMs:5,clock:()=>elapsed});
  for(const [key,value]of Object.entries(rows))await fence.mutate('synthetic:large',key,async()=>value);
  const kv={get:async(_scope:string,key:string)=>{elapsed++;return rows[key];}};
  const result=await fence.wait(kv);expect(result.synced).toBe(true);expect(result.keys).toBe(501);expect(result.scopes).toBe(1);expect(fence.keys()).toHaveLength(0);
 }finally{await rm(storePath,{recursive:true,force:true});}
});
