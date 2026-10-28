import {expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {assertIsolatedHookPaths,isolatedHookEnv} from './helpers/isolated-hook-env.js';

it('checks the actual child native home and every config/source path before capture may start',()=>{
 const root=mkdtempSync(join(tmpdir(),'am-child-isolation-'));
 try{
  const env=isolatedHookEnv(root),keys=Object.keys(env).filter(k=>k!=='PATH'&&k!=='AGENTMEMORY_SECRET'&&k!=='AGENTMEMORY_URL');
  const probe=spawnSync(process.execPath,['-e',`const out={nativeHome:require('node:os').homedir()};for(const key of ${JSON.stringify(keys)})out[key]=process.env[key];process.stdout.write(JSON.stringify(out));`],{env,cwd:root,encoding:'utf8'});
  expect(probe.error?.message).toBeUndefined();expect(probe.status).toBe(0);expect(()=>assertIsolatedHookPaths(root,JSON.parse(probe.stdout))).not.toThrow();
  expect(()=>isolatedHookEnv(root,{HOME:'/outside'})).toThrow('test_path_override_refused');
  expect(()=>assertIsolatedHookPaths(root,{...JSON.parse(probe.stdout),nativeHome:join(root,'..','outside')})).toThrow('test_child_path_escaped');
 }finally{rmSync(root,{recursive:true,force:true});}
});
