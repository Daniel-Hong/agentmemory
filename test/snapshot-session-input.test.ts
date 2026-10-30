import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { fileURLToPath } from 'node:url';

it('writes snapshot output and releases the prior session array before materializing the next session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'am-snapshot-input-result-'));
  try {
    await promisify(execFile)(process.execPath, [
    '--max-old-space-size=256', '--expose-gc', '--import', 'tsx',
    fileURLToPath(new URL('./helpers/snapshot-input-probe.ts', import.meta.url)), join(dir,'result.json'),
  ], {timeout:15000, env:{PATH:process.env.PATH, HOME:process.env.HOME, USERPROFILE:process.env.USERPROFILE}});
    const result = JSON.parse(await readFile(join(dir,'result.json'),'utf8'));
    expect(result).toMatchObject({success:true, outputStarted:true, previousReleased:true, stats:{sessions:3, observations:60}, counts:[20,20,20]});
  } finally {await rm(dir,{recursive:true,force:true});}
});
