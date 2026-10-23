import {expect,it,vi,afterEach} from 'vitest';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {StateKV} from '../src/state/kv.js';import {acquireFileWriterLease} from '../src/ops/file-writer-lease.mjs';
const dirs:string[]=[];afterEach(()=>{vi.unstubAllEnvs();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
it('coordinates every normal state mutation against a short recovery transaction',async()=>{
 const d=mkdtempSync(join(tmpdir(),'am-state-gate-'));dirs.push(d);vi.stubEnv('AGENTMEMORY_STATE_STORE_PATH',d);const lease=acquireFileWriterLease(d);const effects:string[]=[];
 const sdk={trigger:async(x:any)=>{effects.push(x.function_id);return null;}};
 const kv=new StateKV(sdk as never,{writerLease:lease}as never);const gate=(kv as any).recoveryWrite;
 expect(gate).toBeDefined();let release!:()=>void;const blocked=new Promise<void>(r=>release=r);
 try{
  const exclusive=gate.exclusive([{scope:'fixture',key:'internal'}],async()=>{await kv.set('fixture','internal',{});await blocked;});
  await new Promise(r=>setTimeout(r,0));const other=kv.delete('fixture','internal');await new Promise(r=>setTimeout(r,0));expect(effects).toEqual(['state::set']);release();await Promise.all([exclusive,other]);expect(effects).toEqual(['state::set','state::delete']);
 }finally{lease.close();}
});
it('does not grant mutation coordination from an arbitrary capability object',()=>{
 const kv=new StateKV({}as never,{writerLease:{close(){}}}as never);expect((kv as any).recoveryWrite).toBeUndefined();
});
it('latches automatic changes off after an uncertain SDK write while releasing record gates',async()=>{
 const d=mkdtempSync(join(tmpdir(),'am-state-uncertain-'));dirs.push(d);vi.stubEnv('AGENTMEMORY_STATE_STORE_PATH',d);const m=await import('../src/ops/file-writer-lease.mjs');writeFileSync(join(d,'.agentmemory-writer.lock'),JSON.stringify({version:2,bootId:'00000000-0000-0000-0000-000000000000',clean:false}));const lease=m.acquireFileWriterLease(d,{engineUrl:'ws://127.0.0.1:12345'});
 let reject=true;const kv=new StateKV({trigger:async()=>{if(reject)throw Error('invocation_timeout');return null;}}as never,{writerLease:lease});
 try{expect(kv.recoveryMutationSafe).toBe(true);await expect(kv.set('fixture','late',{})).rejects.toThrow();expect(kv.recoveryMutationSafe).toBe(false);reject=false;await kv.set('fixture','other',{});expect(kv.recoveryWrite!.size()).toBe(0);}finally{lease.close();}
});
it('rejects new writes after losing writer ownership',async()=>{
 const d=mkdtempSync(join(tmpdir(),'am-state-lost-'));dirs.push(d);vi.stubEnv('AGENTMEMORY_STATE_STORE_PATH',d);const lease=acquireFileWriterLease(d);const trigger=vi.fn();const kv=new StateKV({trigger}as never,{writerLease:lease});lease.close();await expect(kv.set('fixture','item',{})).rejects.toThrow('FILE_WRITER_LOST');expect(trigger).not.toHaveBeenCalled();
});
