import {expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
it('pure observer exercises freshness, absolute protection and bounded shadow proposal regressions',()=>{
 const script=fileURLToPath(new URL('../scripts/personal-release/test_live_memory_observer.py',import.meta.url));
 const p=spawnSync('/usr/bin/python3',['-I','-B',script],{encoding:'utf8',timeout:3000,maxBuffer:131072});
 expect(p.error).toBeUndefined();expect(p.status).toBe(0);expect(p.stderr).toMatch(/Ran \d+ tests/);expect(p.stderr).toMatch(/\nOK\n/);
});
