import {engineFixture} from './helpers/engine-evidence.js';
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
  const child=spawn(process.execPath,['--input-type=module','-e',`import {acquireFileWriterLease} from ${JSON.stringify('file://'+modulePath)};import {writeFileSync} from 'node:fs';const lease=acquireFileWriterLease(${JSON.stringify(d)});writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`],{stdio:'ignore',env:{PATH:'/usr/bin:/bin',HOME:d}});
  try{
   const until=Date.now()+1500;while(!existsSync(ready)&&child.exitCode===null&&Date.now()<until)await new Promise(r=>setTimeout(r,10));
   expect(existsSync(ready)).toBe(true);
   expect(()=>m.acquireFileWriterLease(d)).toThrowError('FILE_WRITER_BUSY');
  }finally{if(child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}}
  const next=await m.acquireFileWriterLease(d);expect(m.ownsFileWriterLease(next,d)).toBe(true);next.close();
 });
});
it('does not admit an ordinary worker restart on the same engine',async()=>{
 const m=await load(),d=dir(),{epoch,storeHash,evidence}=engineFixture(d);writeFileSync(join(d,'.agentmemory-writer.lock'),JSON.stringify({version:3,store:storeHash,epoch,clean:false}));const lease=m.acquireFileWriterLease(d,{evidence});expect(m.fileWriterRecoveryAdmitted(lease)).toBe(false);expect(()=>m.markFileWriterClean(lease)).toThrow('WRITER_EPOCH_UNVERIFIED');lease.close();
});
it('admits a verified new engine only after both old processes terminated',async()=>{
 const m=await load(),d=dir(),{evidence}=engineFixture(d);let lease=m.acquireFileWriterLease(d,{evidence:{...evidence,gone:()=>false}});expect(m.fileWriterRecoveryAdmitted(lease)).toBe(false);lease.close();
 engineFixture(d);lease=m.acquireFileWriterLease(d,{evidence});expect(m.fileWriterRecoveryAdmitted(lease)).toBe(true);m.markFileWriterClean(lease);lease.close();
});
it.each(['foreign','unsupported','pid-namespace'])('does not launder %s evidence across repeated cold starts',async(kind)=>{
 const m=await load(),d=dir(),{epoch,storeHash,evidence}=engineFixture(d);const original=JSON.stringify(kind==='unsupported'?{version:2,clean:true}:{version:3,store:storeHash,epoch:{...epoch,...(kind==='foreign'?{host:'b'.repeat(64)}:{pidNamespace:'pid:[different]'})},clean:false});writeFileSync(join(d,'.agentmemory-writer.lock'),original);
 for(let i=0;i<2;i++){const lease=m.acquireFileWriterLease(d,{evidence});expect(m.fileWriterRecoveryAdmitted(lease)).toBe(false);lease.close();}expect((await import('node:fs')).readFileSync(join(d,'.agentmemory-writer.lock'),'utf8')).toBe(original);
});
it('closes admission when the actual SDK peer changes',async()=>{const m=await load(),d=dir(),{evidence}=engineFixture(d);let current=true;const lease=m.acquireFileWriterLease(d,{evidence:{...evidence,current:()=>current}});expect(m.fileWriterRecoveryAdmitted(lease)).toBe(true);current=false;expect(m.fileWriterRecoveryAdmitted(lease)).toBe(false);lease.close();});

it('retains overlap uncertainty rather than laundering a surviving earlier engine',async()=>{
 const m=await load(),d=dir(),{epoch,storeHash,evidence}=engineFixture(d);let lease=m.acquireFileWriterLease(d,{evidence:{...evidence,gone:p=>p.pid!==201}});expect(m.fileWriterRecoveryAdmitted(lease)).toBe(false);lease.close();
 const later={...epoch,worker:{pid:102,start:'12'},engine:{pid:202,start:'22'}};lease=m.acquireFileWriterLease(d,{evidence:{bootIdentity:()=>later.bootId,capture:()=>later,current:()=>true,gone:()=>true}});expect(m.fileWriterRecoveryAdmitted(lease)).toBe(false);expect(m.fileWriterRecoveryReason(lease)).toBe('WRITER_ENGINE_OVERLAP');lease.close();
});

it('refuses a marker copied from another local store without rewriting it',async()=>{const m=await load(),a=dir(),b=dir(),{evidence}=engineFixture(a);const fs=await import('node:fs'),original=fs.readFileSync(join(a,'.agentmemory-writer.lock'),'utf8');fs.writeFileSync(join(b,'.agentmemory-writer.lock'),original);const lease=m.acquireFileWriterLease(b,{evidence});expect(m.fileWriterRecoveryAdmitted(lease)).toBe(false);expect(m.fileWriterRecoveryReason(lease)).toBe('WRITER_PRIOR_FOREIGN');lease.close();expect(fs.readFileSync(join(b,'.agentmemory-writer.lock'),'utf8')).toBe(original);});

it('invalidates old clean admission before an unverified worker can write',async()=>{const m=await load(),d=dir(),{epoch,storeHash,evidence}=engineFixture(d);const prior={version:3,store:storeHash,epoch,clean:true};writeFileSync(join(d,'.agentmemory-writer.lock'),JSON.stringify(prior));let lease=m.acquireFileWriterLease(d,{evidence:{...evidence,capture:()=>null}});expect(m.fileWriterRecoveryAdmitted(lease)).toBe(false);lease.close();const saved=JSON.parse((await import('node:fs')).readFileSync(join(d,'.agentmemory-writer.lock'),'utf8'));expect(saved).toMatchObject({...prior,blockedUntilBoot:true,unverifiedWriter:true});lease=m.acquireFileWriterLease(d,{evidence});expect(m.fileWriterRecoveryAdmitted(lease)).toBe(false);expect(()=>m.markFileWriterClean(lease)).toThrow('WRITER_EPOCH_UNVERIFIED');lease.close();});

it('does not erase a current-boot unknown writer using a prior-boot marker',async()=>{const m=await load(),d=dir(),{epoch,storeHash,evidence}=engineFixture(d),old={...epoch,bootId:'22222222-2222-2222-2222-222222222222'};writeFileSync(join(d,'.agentmemory-writer.lock'),JSON.stringify({version:3,store:storeHash,epoch:old,clean:true}));let lease=m.acquireFileWriterLease(d,{evidence:{...evidence,capture:()=>null}});lease.close();lease=m.acquireFileWriterLease(d,{evidence});expect(m.fileWriterRecoveryAdmitted(lease)).toBe(false);expect(m.fileWriterRecoveryReason(lease)).toBe('WRITER_NATIVE_PROBE_UNCERTAIN');lease.close();const later={...epoch,bootId:'33333333-3333-3333-3333-333333333333'};lease=m.acquireFileWriterLease(d,{evidence:{...evidence,capture:()=>later,current:()=>true}});expect(m.fileWriterRecoveryAdmitted(lease)).toBe(true);lease.close();});
it('strict startup leaves existing evidence untouched and creates no marker without a verified epoch',async()=>{
 const m=await load(),d=dir(),path=join(d,'.agentmemory-writer.lock');
 const options={requireVerifiedEpoch:true,evidence:{capture:()=>null}};
 expect(()=>m.acquireFileWriterLease(d,options)).toThrow('ENGINE_EPOCH_UNVERIFIED');
 expect(existsSync(path)).toBe(false);
 writeFileSync(path,'prior-evidence');
 expect(()=>m.acquireFileWriterLease(d,options)).toThrow('ENGINE_EPOCH_UNVERIFIED');
 expect((await import('node:fs')).readFileSync(path,'utf8')).toBe('prior-evidence');
});
it('does not promote engine-only v3 evidence into a State-bound writer',async()=>{
 const m=await load(),d=dir(),f=engineFixture(d),path=join(d,'.agentmemory-writer.lock');
 const original=(await import('node:fs')).readFileSync(path,'utf8');
 const state={pid:300,start:'30',instanceId:'22222222-2222-4222-8222-222222222222',store:f.storeHash,executableSha256:'a'.repeat(64)};
 const epoch={...f.epoch,state};const evidence={...f.evidence,capture:()=>epoch,current:()=>true};
 const lease=m.acquireFileWriterLease(d,{evidence});try{
 expect(m.fileWriterRecoveryAdmitted(lease)).toBe(false);expect(m.fileWriterRecoveryReason(lease)).toBe('WRITER_PRIOR_UNSUPPORTED');
 expect((await import('node:fs')).readFileSync(path,'utf8')).toBe(original);
 }finally{lease.close();}
});
it('State-only replacement invalidates v4 evidence and refuses a surviving prior State',async()=>{
 const m=await load(),d=dir(),f=engineFixture(d),path=join(d,'.agentmemory-writer.lock');
 const oldState={pid:300,start:'30',instanceId:'22222222-2222-4222-8222-222222222222',store:f.storeHash,executableSha256:'a'.repeat(64)};
 const oldEpoch={...f.epoch,worker:{pid:101,start:'11'},state:oldState};
 writeFileSync(path,JSON.stringify({version:4,store:f.storeHash,epoch:oldEpoch,clean:true}));
 const epoch={...f.epoch,state:{...oldState,pid:301,start:'31',instanceId:'33333333-3333-4333-8333-333333333333'}};
 const evidence={...f.evidence,capture:()=>epoch,current:()=>true,gone:(p:any)=>p.pid!==300};
 const lease=m.acquireFileWriterLease(d,{evidence});try{expect(m.fileWriterRecoveryAdmitted(lease)).toBe(false);expect(m.fileWriterRecoveryReason(lease)).toBe('WRITER_ENGINE_OVERLAP');}finally{lease.close();}
});
it('engine-only restart cannot admit dirty evidence while old external State survives',async()=>{
 const m=await load(),d=dir(),f=engineFixture(d),path=join(d,'.agentmemory-writer.lock');
 const state={pid:300,start:'30',instanceId:'22222222-2222-4222-8222-222222222222',store:f.storeHash,executableSha256:'a'.repeat(64)};
 writeFileSync(path,JSON.stringify({version:4,store:f.storeHash,epoch:{...f.epoch,worker:{pid:101,start:'11'},engine:{pid:201,start:'21'},state},clean:false}));
 const epoch={...f.epoch,state},evidence={...f.evidence,capture:()=>epoch,current:()=>true,gone:(p:any)=>p.pid!==300};
 const lease=m.acquireFileWriterLease(d,{evidence});try{expect(m.fileWriterRecoveryAdmitted(lease)).toBe(false);}finally{lease.close();}
});
it('preserves v4 evidence whose bound State store contradicts its marker store',async()=>{
 const m=await load(),d=dir(),f=engineFixture(d),path=join(d,'.agentmemory-writer.lock');
 const state={pid:300,start:'30',instanceId:'22222222-2222-4222-8222-222222222222',store:f.storeHash,executableSha256:'a'.repeat(64)};
 const original=JSON.stringify({version:4,store:f.storeHash,epoch:{...f.epoch,state:{...state,store:'b'.repeat(64)}},clean:true});writeFileSync(path,original);
 const evidence={...f.evidence,capture:()=>({...f.epoch,state}),current:()=>true};
 const lease=m.acquireFileWriterLease(d,{evidence});try{expect(m.fileWriterRecoveryAdmitted(lease)).toBe(false);expect((await import('node:fs')).readFileSync(path,'utf8')).toBe(original);}finally{lease.close();}
});
it('does not use upgrade provenance to permit an inverse native downgrade',async()=>{
 const m=await load(),d=dir(),f=engineFixture(d),path=join(d,'.agentmemory-writer.lock');
 const state={pid:300,start:'30',instanceId:'22222222-2222-4222-8222-222222222222',store:f.storeHash,executableSha256:'a'.repeat(64)};
 const original=JSON.stringify({version:4,store:f.storeHash,epoch:{...f.epoch,state},clean:true,migration:{kind:'verified-native-v3',sourceSha256:'c'.repeat(64)}});writeFileSync(path,original);
 const lease=m.acquireFileWriterLease(d,{evidence:f.evidence});try{expect(m.fileWriterRecoveryAdmitted(lease)).toBe(false);expect((await import('node:fs')).readFileSync(path,'utf8')).toBe(original);}finally{lease.close();}
});
it('publishes a fresh v4 clean marker only from matching State seal, never overwrites unsupported prior evidence',async()=>{
 const m=await load(),d=dir(),f=engineFixture(d),path=join(d,'.agentmemory-writer.lock');
 const state={pid:300,start:'30',instanceId:'22222222-2222-4222-8222-222222222222',store:f.storeHash,executableSha256:'a'.repeat(64)},epoch={...f.epoch,state},evidence={...f.evidence,capture:()=>epoch,current:()=>true};
 const receipt={version:1,instanceId:state.instanceId,storePath:d,sealed:true,synced:true};
 const original=(await import('node:fs')).readFileSync(path,'utf8');let lease=m.acquireFileWriterLease(d,{evidence});
 expect(()=>m.markFileWriterSealedClean(lease,receipt)).toThrow('STATE_SEAL_UNVERIFIED');lease.close();
 expect((await import('node:fs')).readFileSync(path,'utf8')).toBe(original);
 rmSync(path);lease=m.acquireFileWriterLease(d,{evidence});
 try{expect(()=>m.markFileWriterSealedClean(lease,{...receipt,instanceId:'wrong'})).toThrow();m.markFileWriterSealedClean(lease,receipt);expect(JSON.parse((await import('node:fs')).readFileSync(path,'utf8')).clean).toBe(true);}finally{lease.close();}
});
it('strict candidate native startup rejects a v4 marker without rewriting it',async()=>{
 const m=await load(),d=dir(),f=engineFixture(d),path=join(d,'.agentmemory-writer.lock');
 const state={pid:300,start:'30',instanceId:'22222222-2222-4222-8222-222222222222',store:f.storeHash,executableSha256:'a'.repeat(64)};
 const original=JSON.stringify({version:4,store:f.storeHash,epoch:{...f.epoch,state},clean:true});writeFileSync(path,original);
 expect(()=>m.acquireFileWriterLease(d,{evidence:f.evidence,requireVerifiedEpoch:true})).toThrow('WRITER_NATIVE_DOWNGRADE_UNSUPPORTED');
 expect((await import('node:fs')).readFileSync(path,'utf8')).toBe(original);
});
