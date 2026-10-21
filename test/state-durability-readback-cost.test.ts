import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,writeFile,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const hooks=vi.hoisted(()=>({completed:null as null|(()=>void)}));
vi.mock('../src/ops/namespace-reader.mjs',async original=>{
 const actual=await original<any>();
 return {...actual,readNamespaceEntries:(path:string,options:any)=>actual.readNamespaceEntries(path,{...options,onRead:(info:any)=>{options.onRead?.(info);if(info.complete)hooks.completed?.();}})};
});
import {createStateDurabilityFence} from '../src/ops/state-durability.mjs';
const dirs:string[]=[];
afterEach(async()=>{hooks.completed=null;await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})));});
async function fixture(value:number){const dir=await mkdtemp(join(tmpdir(),'am-negative-read-'));dirs.push(dir);const path=join(dir,'synthetic.bin');await writeFile(path,JSON.stringify({key:value}));return{dir,path};}
function firstRead(){return new Promise<void>(resolve=>{hooks.completed=()=>{hooks.completed=null;resolve();};});}
const selected=[{scope:'synthetic',key:'key'}];
it('rejects an unchanged wrong disk value at the original deadline without repeatedly scanning it',async()=>{
 const {dir}=await fixture(2),fence=createStateDurabilityFence({storePath:dir,timeoutMs:120,pollIntervalMs:5});
 await expect(fence.waitForKeys({get:async()=>1},selected)).rejects.toMatchObject({code:'STATE_DURABILITY_TIMEOUT'});
 const sample=(fence.snapshot() as any).measurements.recent[0];
 expect(sample).toMatchObject({outcome:'failed',failedStage:'readback',scans:1});
 expect(sample.checkAttempts).toBeGreaterThan(1);expect(sample.unchangedMismatchSkips).toBeGreaterThan(0);expect(sample.phases.fsyncMs).toBe(0);
});
it('rescans a new file version and certifies a later matching publication',async()=>{
 const {dir,path}=await fixture(2),fence=createStateDurabilityFence({storePath:dir,timeoutMs:1000,pollIntervalMs:5});
 const read=firstRead(),waiting=fence.waitForKeys({get:async()=>1},selected);await read;
 await writeFile(path+'.next','{"key":1}');await rename(path+'.next',path);
 await expect(waiting).resolves.toMatchObject({synced:true});
 const sample=(fence.snapshot() as any).measurements.recent[0];expect(sample.scans).toBeGreaterThanOrEqual(2);expect(sample.outcome).toBe('verified');
});
it('invalidates a negative result when the captured expectation changes even if the file is unchanged',async()=>{
 const {dir}=await fixture(2),fence=createStateDurabilityFence({storePath:dir,timeoutMs:1000,pollIntervalMs:5});
 let value=1;await fence.mutate('synthetic','key',async()=>{});
 const read=firstRead(),waiting=fence.waitForKeys({get:async()=>value},selected);await read;
 await fence.mutate('synthetic','key',async()=>{value=2;});
 await expect(waiting).resolves.toMatchObject({synced:true});
 expect((fence.snapshot() as any).measurements.recent[0].scans).toBeGreaterThanOrEqual(2);expect(fence.keys()).toHaveLength(0);
});
it('does not retain negative results across independent certification calls',async()=>{
 const {dir,path}=await fixture(2),fence=createStateDurabilityFence({storePath:dir,timeoutMs:50,pollIntervalMs:5});
 await expect(fence.waitForKeys({get:async()=>1},selected)).rejects.toMatchObject({code:'STATE_DURABILITY_TIMEOUT'});
 await writeFile(path,'{"key":1}');
 await expect(fence.waitForKeys({get:async()=>1},selected)).resolves.toMatchObject({synced:true});
 expect((fence.snapshot() as any).measurements.recent[1]).toMatchObject({outcome:'verified',scans:1,unchangedMismatchSkips:0});
});
it('validates a changed corrupt version rather than reusing a previous mismatch or certifying it',async()=>{
 const {dir,path}=await fixture(2),fence=createStateDurabilityFence({storePath:dir,timeoutMs:120,pollIntervalMs:5});
 const read=firstRead(),waiting=fence.waitForKeys({get:async()=>1},selected);const assertion=expect(waiting).rejects.toMatchObject({code:'STATE_DURABILITY_TIMEOUT'});await read;
 await writeFile(path+'.next','{"key":invalid}');await rename(path+'.next',path);await assertion;
 expect((fence.snapshot() as any).measurements.recent[0].retryReasons.invalid_namespace).toBeGreaterThan(0);
});
