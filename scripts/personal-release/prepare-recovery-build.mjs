import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile,symlink,realpath,mkdtemp,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const marker='export const MEMORY_RECOVERY_ENABLED = true;';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const run=(cwd,command,args,options={})=>execFileSync(command,args,{cwd,encoding:'utf8',maxBuffer:128*1024*1024,...options});
export async function prepareRecoverySource({sourceRoot,destination,version}){
 sourceRoot=resolve(sourceRoot);destination=resolve(destination);
 if(run(sourceRoot,'git',['status','--porcelain']).trim())throw Error('clean_source_required');
 const sourceCommit=run(sourceRoot,'git',['rev-parse','HEAD']).trim();
 const input=JSON.parse(run(sourceRoot,'git',['show',sourceCommit+':package.json']));
 if(!/^0\.9\.30-daniel\.[1-9][0-9]*$/.test(version)||version===input.version)throw Error('recovery_version_required');
 if(input.agentmemoryCompatibility?.backgroundControlVersion!==2||input.agentmemoryCompatibility?.automaticMemoryRecovery!==true)throw Error('v2_source_required');
 const policy=run(sourceRoot,'git',['show',sourceCommit+':src/ops/memory-pressure.mjs']);
 if(policy.split(marker).length!==2)throw Error('recovery_policy_marker_invalid');
 await mkdir(destination);
 const source=join(destination,'source');await mkdir(source);
 const archive=run(sourceRoot,'git',['archive','--format=tar',sourceCommit],{encoding:'buffer'});
 run(source,'tar',['-xf','-','--no-same-owner'],{input:archive});
 const patched=policy.replace(marker,'export const MEMORY_RECOVERY_ENABLED = false;');
 await writeFile(join(source,'src/ops/memory-pressure.mjs'),patched);
 const manifest={...input,version,agentmemoryCompatibility:{backgroundControlVersion:2,automaticMemoryRecovery:false}};
 await writeFile(join(source,'package.json'),JSON.stringify(manifest,null,2)+'\n');
 const provenance={profile:'v2-recovery-disabled',sourceCommit,version,sourcePolicySha256:digest(policy),recoveryPolicySha256:digest(patched),automaticMemoryRecovery:false,backgroundControlVersion:2};
 await writeFile(join(destination,'source-provenance.json'),JSON.stringify(provenance,null,2)+'\n');
 return{source,destination,provenance};
}
export async function buildRecoveryArtifact(options){
 const prepared=await prepareRecoverySource(options),home=await mkdtemp(join(tmpdir(),'am-recovery-build-home-'));
 try{
  const env={...process.env,HOME:home,npm_config_offline:'true',npm_config_update_notifier:'false',npm_config_audit:'false'};
  run(prepared.source,'git',['init','--quiet']);run(prepared.source,'git',['add','.']);
  await symlink(await realpath(join(resolve(options.sourceRoot),'node_modules')),join(prepared.source,'node_modules'),'dir');
  const steps=[['run','docs:sync'],['run','build'],['run','skills:gen'],['run','docs:sync'],['run','skills:check'],['run','docs:check']];
  for(const args of steps){const output=run(prepared.source,'npm',args,{env});await writeFile(join(prepared.destination,args[1].replace(':','-')+'.log'),output);}
  const packed=JSON.parse(run(prepared.source,'npm',['pack','--ignore-scripts','--json','--pack-destination',prepared.destination],{env}))[0];
  const packagePath=join(prepared.destination,packed.filename),bytes=await readFile(packagePath);
  const manifest=JSON.parse(run(prepared.source,'tar',['-xOf',packagePath,'package/package.json']));
  if(manifest.version!==options.version||manifest.agentmemoryCompatibility?.automaticMemoryRecovery!==false||manifest.agentmemoryCompatibility?.backgroundControlVersion!==2)throw Error('recovery_package_profile_invalid');
  const result={...prepared.provenance,packageFile:packed.filename,packageSha256:digest(bytes),node:process.version,registered:false,activated:false};
  await writeFile(join(prepared.destination,'recovery-build.json'),JSON.stringify(result,null,2)+'\n');
  return result;
 }finally{await rm(home,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [sourceRoot,destination,version,...extra]=process.argv.slice(2);
 if(!sourceRoot||!destination||!version||extra.length)throw Error('usage: prepare-recovery-build.mjs SOURCE OUTPUT VERSION');
 console.log(JSON.stringify(await buildRecoveryArtifact({sourceRoot,destination,version}),null,2));
}
