import {afterEach,expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {prepareRecoverySource} from '../scripts/personal-release/prepare-recovery-build.mjs';
const dirs:string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function source(){
 const dir=await mkdtemp(join(tmpdir(),'am-recovery-profile-'));dirs.push(dir);await mkdir(join(dir,'src/ops'),{recursive:true});
 for(const name of ['memory-pressure.mjs','background-control.mjs'])await writeFile(join(dir,'src/ops',name),await readFile(resolve('src/ops',name)));
 await writeFile(join(dir,'package.json'),JSON.stringify({name:'synthetic',version:'0.9.30-daniel.11',agentmemoryCompatibility:{backgroundControlVersion:2,automaticMemoryRecovery:true}}));
 for(const args of [['init','--quiet'],['add','.'],['-c','user.name=Synthetic','-c','user.email=synthetic@localhost','commit','--quiet','-m','fixture']])execFileSync('git',args,{cwd:dir});
 return dir;
}
it('prepares an isolated v2-compatible recovery profile without changing source',async()=>{
 const dir=await source(),before=await readFile(join(dir,'src/ops/memory-pressure.mjs'),'utf8');
 const result=await prepareRecoverySource({sourceRoot:dir,destination:join(dir,'output'),version:'0.9.30-daniel.12'});
 const pkg=JSON.parse(await readFile(join(result.source,'package.json'),'utf8'));
 expect(pkg).toMatchObject({version:'0.9.30-daniel.12',agentmemoryCompatibility:{backgroundControlVersion:2,automaticMemoryRecovery:false}});
 expect(await readFile(join(dir,'src/ops/memory-pressure.mjs'),'utf8')).toBe(before);
 const {createBackgroundControl}=await import(pathToFileURL(join(result.source,'src/ops/background-control.mjs')).href);
 const {createMemoryPressureGuard,MEMORY_RECOVERY_ENABLED}=await import(pathToFileURL(join(result.source,'src/ops/memory-pressure.mjs')).href);
 expect(MEMORY_RECOVERY_ENABLED).toBe(false);
 let record:any={version:2,paused:true,resumePending:false,holds:['memory'],recovery:{attempts:2,nextAttemptAt:12345}},now=1000,available=8*1024**3;
 const kv={get:async()=>structuredClone(record),set:async(_:any,__:any,v:any)=>{record=structuredClone(v);},durability:{wait:async()=>({synced:true,mutationFailures:0}),waitForKeys:async()=>{}}};
 const control=createBackgroundControl({clock:()=>now});await control.init(kv);
 const guard=createMemoryPressureGuard({control,schedule:false,clock:()=>now,readSample:async()=>({total:16*1024**3,available})});
 for(let i=0;i<80;i++){now+=5000;await guard.refresh();await guard.drain();}
 expect(control.snapshot()).toMatchObject({formatVersion:2,holds:['memory'],pausedRequested:true,recovery:{attempts:2,nextAttemptAt:12345}});
 expect(guard.snapshot()).toMatchObject({automaticMemoryRecovery:false,recoveryStatus:'disabled'});
 await control.commitCleanShutdown();expect(record).toMatchObject({holds:['memory'],recovery:{attempts:2,nextAttemptAt:12345}});
 available=0;await guard.refresh();await guard.drain();expect(guard.snapshot().level).toBe('critical');
 const handlers:any={};
 const sdk:any={registerFunction:(id:string,fn:any)=>{handlers[id]=fn;}};guard.install(sdk,()=>null);sdk.registerFunction('api::write',async()=>({status_code:200}));
 expect((await handlers['api::write']({})).status_code).toBe(503);await guard.stop();
 const restarted=createBackgroundControl();await restarted.init(kv);expect(restarted.snapshot()).toMatchObject({holds:['memory'],recovery:{attempts:2,nextAttemptAt:12345}});
});
it('refuses dirty input and invalid or unchanged versions',async()=>{
 const dir=await source();
 await expect(prepareRecoverySource({sourceRoot:dir,destination:join(dir,'x'),version:'0.9.30-daniel.11'})).rejects.toThrow('recovery_version_required');
 await expect(prepareRecoverySource({sourceRoot:dir,destination:join(dir,'x'),version:'invalid'})).rejects.toThrow('recovery_version_required');
 await writeFile(join(dir,'package.json'),'{}');
 await expect(prepareRecoverySource({sourceRoot:dir,destination:join(dir,'x'),version:'0.9.30-daniel.12'})).rejects.toThrow('clean_source_required');
});

it.each([['manual','memory'],['deployment','memory'],['legacy_unknown'],['storage_error','memory']])('preserves overlapping holds and exhausted budgets in fallback %j',async(...holds)=>{
 const dir=await source(),out=dir+'-recovery';dirs.push(out);
 const result=await prepareRecoverySource({sourceRoot:dir,destination:out,version:'0.9.30-daniel.12'});
 const {createBackgroundControl}=await import(pathToFileURL(join(result.source,'src/ops/background-control.mjs')).href);
 const {createMemoryPressureGuard}=await import(pathToFileURL(join(result.source,'src/ops/memory-pressure.mjs')).href);
 let record:any={version:2,paused:true,resumePending:false,holds,recovery:{attempts:3,nextAttemptAt:900000}},now=1000;
 const kv={get:async()=>structuredClone(record),set:async(_:any,__:any,v:any)=>{record=structuredClone(v);},durability:{wait:async()=>({synced:true,mutationFailures:0}),waitForKeys:async()=>{}}};
 const control=createBackgroundControl();await control.init(kv);
 const guard=createMemoryPressureGuard({control,schedule:false,clock:()=>now,readSample:async()=>({total:16*1024**3,available:8*1024**3})});
 for(let i=0;i<30;i++){now+=5000;await guard.refresh();await guard.drain();}
 expect(control.snapshot()).toMatchObject({pausedRequested:true,holds:[...holds].sort(),recovery:{attempts:3,nextAttemptAt:900000}});
 await guard.stop();await control.commitCleanShutdown();expect(record).toMatchObject({holds:[...holds].sort(),recovery:{attempts:3,nextAttemptAt:900000}});
});
it('refuses to overwrite an existing destination',async()=>{
 const dir=await source(),out=dir+'-existing';dirs.push(out);await mkdir(out);await writeFile(join(out,'sentinel'),'preserve');
 await expect(prepareRecoverySource({sourceRoot:dir,destination:out,version:'0.9.30-daniel.12'})).rejects.toThrow('EEXIST');
 expect(await readFile(join(out,'sentinel'),'utf8')).toBe('preserve');
});
it('pins every archived input and provenance to one commit despite a concurrent HEAD change',async()=>{
 const dir=await source(),out=dir+'-pinned',shim=dir+'-shim';dirs.push(out,shim);await mkdir(shim);
 const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:dir,encoding:'utf8'}).trim();
 const realGit=execFileSync('which',['git'],{encoding:'utf8'}).trim();
 const program=`#!/bin/sh
if [ "$1" = show ] && [ ! -e "$PWD/.race-fired" ]; then
 touch "$PWD/.race-fired"
 printf '%s' '{"version":"0.9.30-daniel.99"}' > package.json
 "${realGit}" add package.json
 "${realGit}" -c user.name=Synthetic -c user.email=synthetic@localhost commit --quiet -m race
fi
exec "${realGit}" "$@"
`;
 await writeFile(join(shim,'git'),program,{mode:0o755});const prior=process.env.PATH;process.env.PATH=shim+':'+prior;
 try{
  const result=await prepareRecoverySource({sourceRoot:dir,destination:out,version:'0.9.30-daniel.12'});
  expect(result.provenance.sourceCommit).toBe(commit);
  expect(execFileSync(realGit,['rev-parse','HEAD'],{cwd:dir,encoding:'utf8'}).trim()).not.toBe(commit);
  expect(JSON.parse(await readFile(join(result.source,'package.json'),'utf8')).name).toBe('synthetic');
 }finally{process.env.PATH=prior;}
});
