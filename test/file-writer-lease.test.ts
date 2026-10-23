import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,rmSync,existsSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
const dirs:string[]=[];afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const dir=()=>{const d=mkdtempSync(join(tmpdir(),'am-writer-lock-'));dirs.push(d);return d;};
const modulePath=resolve('src/ops/file-writer-lease.mjs');
async function load(){return import(modulePath);}
describe('native file writer ownership',()=>{
 it('retains the kernel lock in the parent after the flock utility exits',async()=>{
  const m=await load(),d=dir(),first=await m.acquireFileWriterLease(d);
  expect(first).not.toBeNull();expect(m.ownsFileWriterLease(first,d)).toBe(true);
  try{expect(()=>m.acquireFileWriterLease(d)).toThrowError('FILE_WRITER_BUSY');}finally{first?.close();}
  expect(m.ownsFileWriterLease(first,d)).toBe(false);
  const next=await m.acquireFileWriterLease(d);next.close();
 });
 it('rejects another process and releases only when the owning process exits',async()=>{
  const m=await load(),d=dir();expect(typeof m.acquireFileWriterLease).toBe('function');
  const ready=join(d,'ready');
  const child=spawn('/usr/bin/node',['--input-type=module','-e',`import {acquireFileWriterLease} from ${JSON.stringify('file://'+modulePath)};import {writeFileSync} from 'node:fs';const lease=acquireFileWriterLease(${JSON.stringify(d)});writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`],{stdio:'ignore',env:{PATH:'/usr/bin:/bin',HOME:d}});
  try{
   const until=Date.now()+1500;while(!existsSync(ready)&&child.exitCode===null&&Date.now()<until)await new Promise(r=>setTimeout(r,10));
   expect(existsSync(ready)).toBe(true);
   expect(()=>m.acquireFileWriterLease(d)).toThrowError('FILE_WRITER_BUSY');
  }finally{if(child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}}
  const next=await m.acquireFileWriterLease(d);expect(m.ownsFileWriterLease(next,d)).toBe(true);next.close();
 });
});
it('does not launder an unknown epoch through one graceful worker cycle',async()=>{
 const m=await load(),d=dir(),options={engineUrl:'ws://127.0.0.1:12345'};let lease=m.acquireFileWriterLease(d,options);
 expect((m as any).fileWriterRecoveryAdmitted(lease)).toBe(false);expect(()=>(m as any).markFileWriterClean(lease)).toThrow('WRITER_EPOCH_UNVERIFIED');lease.close();lease=m.acquireFileWriterLease(d,options);expect((m as any).fileWriterRecoveryAdmitted(lease)).toBe(false);lease.close();
});
it('admits only local-engine previous-boot evidence and preserves dirty same-boot restart',async()=>{
 const m=await load(),d=dir(),options={engineUrl:'ws://127.0.0.1:12345'};
 writeFileSync(join(d,'.agentmemory-writer.lock'),JSON.stringify({version:2,bootId:'00000000-0000-0000-0000-000000000000',clean:false}));
 let lease=m.acquireFileWriterLease(d,options);expect((m as any).fileWriterRecoveryAdmitted(lease)).toBe(true);(m as any).markFileWriterClean(lease);lease.close();lease=m.acquireFileWriterLease(d,options);expect((m as any).fileWriterRecoveryAdmitted(lease)).toBe(true);lease.close();lease=m.acquireFileWriterLease(d,options);expect((m as any).fileWriterRecoveryAdmitted(lease)).toBe(false);lease.close();
});
