import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mockKV,mockSdk} from './helpers/mocks.js';
import {registerCaptureReceipts} from '../src/capture/receipts.js';
import {captureEventScope} from '../src/capture/event-record.js';
import {KV} from '../src/state/schema.js';
import {createStateDurabilityFence} from '../src/ops/state-durability.mjs';

let dir:string;
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'am-receipt-handoff-'));vi.resetModules();vi.stubEnv('AGENTMEMORY_HOME',dir);vi.stubEnv('AGENTMEMORY_SECRET','synthetic-secret');vi.stubEnv('AGENTMEMORY_URL','http://127.0.0.1:45679');vi.stubEnv('AGENTMEMORY_CAPTURE_SPOOL_DIR',join(dir,'managed'));vi.stubEnv('AGENTMEMORY_CAPTURE_DRAIN_CHILD','1');});
afterEach(async()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();await rm(dir,{recursive:true,force:true});});
async function setup(){
 const body={project:'synthetic',sessionId:'synthetic-session',eventId:'synthetic-event',hookType:'post_tool_use',timestamp:'2026-10-21T00:00:00Z',cwd:'/synthetic',data:{tool_output:'synthetic '.repeat(40000)}};
 const key='cap_'+createHash('sha256').update(`${body.project}\u0000${body.sessionId}\u0000${body.eventId}`).digest('hex').slice(0,40);
 const done={key,project:body.project,sessionId:body.sessionId,eventId:body.eventId,observationId:'synthetic-obs',acceptedAt:body.timestamp,completedAt:body.timestamp,attempts:1};
 const obs={id:done.observationId,sessionId:body.sessionId,captureKey:key,sourceRaw:{id:done.observationId,sessionId:body.sessionId,captureKey:key,eventId:body.eventId,hookType:body.hookType,timestamp:body.timestamp,raw:body.data}};
 const kv=mockKV();await kv.set(captureEventScope(key),key,done);await kv.set(KV.observations(body.sessionId),obs.id,obs);
 const eventFile=join(dir,encodeURIComponent(captureEventScope(key))+'.bin'),obsFile=join(dir,encodeURIComponent(KV.observations(body.sessionId))+'.bin');
 await writeFile(eventFile,JSON.stringify({[key]:done}));await writeFile(obsFile,Buffer.concat([Buffer.from(JSON.stringify({[obs.id]:obs})),Buffer.from([255,0,123])]));
 const fence=createStateDurabilityFence({storePath:dir});Object.assign(kv,{durability:fence});const sdk=mockSdk();registerCaptureReceipts(sdk as never,kv as never);
 let postStatus=503,posts=0;
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,options:RequestInit={})=>{
  const u=new URL(String(input));if(options.method==='POST'){posts++;return new Response('{}',{status:postStatus});}
  expect(u.pathname).toBe('/agentmemory/capture/receipts');const result=await sdk.fns.get('mem::capture-receipt')!({key:u.searchParams.get('key'),digest:u.searchParams.get('digest'),budgetMs:Number(u.searchParams.get('budgetMs'))});return new Response(JSON.stringify(result),{status:200});
 }));
 const clientDir=join(dir,'client');await mkdir(clientDir);
 for(const name of ['_capture.mjs','long-session-hook-client.mjs']){const source=await readFile(new URL('../plugin/scripts/codex-compat/'+name,import.meta.url),'utf8');await writeFile(join(clientDir,name),source.replace(/^\/\/# sourceMappingURL=.*$/gm,''));}
 const {HookClient}=await import(pathToFileURL(join(clientDir,'long-session-hook-client.mjs')).href);
 const outbox=join(dir,'outbox'),client=()=>new HookClient({dir:outbox,url:'http://127.0.0.1:45679',timeoutMs:1000,secret:'synthetic-secret'});
 await client().enqueue('/agentmemory/observe',body);
 const pending=async()=>{const files=(await readdir(outbox)).filter(x=>x.endsWith('.json'));return Promise.all(files.map(async name=>JSON.parse(await readFile(join(outbox,name),'utf8'))));};
 return {body,key,done,obs,kv,fence,eventFile,obsFile,client,pending,outbox,clientDir,get posts(){return posts;},reject:()=>{postStatus=413;}};
}
describe('actual compatibility collector and body-free durable receipt with file fence',()=>{
 it('removes only an already durable matching duplicate and never resends it',async()=>{
  const f=await setup();expect(await f.client().flush()).toBe(true);expect(await f.pending()).toEqual([]);expect(f.posts).toBe(0);expect(f.fence.snapshot().measurements.recent.at(-1)?.outcome).toBe('verified');
 });
 it.each(['disk-mismatch','missing','deleted','payload-mismatch','invalid-json'])('retains complete original data across rejected proof and worker recreation: %s',async mode=>{
  const f=await setup();if(mode==='disk-mismatch')await writeFile(f.obsFile,JSON.stringify({[f.obs.id]:{...f.obs,sourceRaw:{...f.obs.sourceRaw,raw:{tool_output:'different'}}}}));
  if(mode==='missing')await f.kv.delete(KV.observations(f.body.sessionId),f.obs.id);
  if(mode==='deleted')await f.kv.set(captureEventScope(f.key),f.key,{...f.done,state:'deleted'});
  if(mode==='payload-mismatch')await f.kv.set(KV.observations(f.body.sessionId),f.obs.id,{...f.obs,sourceRaw:{...f.obs.sourceRaw,raw:{tool_output:'different'}}});
  if(mode==='invalid-json')await writeFile(f.obsFile,'{"broken":');
  expect(await f.client().flush()).toBe(false);const first=await f.pending();expect(first).toHaveLength(1);expect(first[0].body).toEqual(f.body);
  expect(await f.client().flush()).toBe(false);expect((await f.pending())[0].body).toEqual(f.body);await f.fence.drain();
 });
 it('retains rejected unknown observations rather than deleting or truncating them',async()=>{
  const f=await setup();await f.kv.delete(captureEventScope(f.key),f.key);f.reject();expect(await f.client().flush()).toBe(false);expect(f.posts).toBe(1);expect((await f.pending())[0].body).toEqual(f.body);
 });
 it('can exhaust a legacy caller budget checking mismatched disk state before any POST, without losing the original',async()=>{
  const f=await setup();await writeFile(f.obsFile,JSON.stringify({[f.obs.id]:{...f.obs,sourceRaw:{...f.obs.sourceRaw,raw:{tool_output:'not yet published'}}}}));
  expect(await f.client().flush()).toBe(false);expect(f.posts).toBe(0);
  const records=await f.pending();expect(records).toHaveLength(1);expect(records[0].body).toEqual(f.body);expect(records[0].attempts).toBe(1);await f.fence.drain();
 });
 it('preserves the exact pending original across a new worker process while retry backoff is active',async()=>{
  const f=await setup();await f.kv.delete(captureEventScope(f.key),f.key);expect(await f.client().flush()).toBe(false);
  const file=join(f.outbox,(await readdir(f.outbox)).find(x=>x.endsWith('.json'))!);const record=JSON.parse(await readFile(file,'utf8'));record.nextAttemptAt=Date.now()+60000;await writeFile(file,JSON.stringify(record));
  const marker=join(dir,'worker-result.json');const code=`import {writeFile} from 'node:fs/promises';const {HookClient}=await import(${JSON.stringify(pathToFileURL(join(f.clientDir,'long-session-hook-client.mjs')).href)});const result=await new HookClient({dir:${JSON.stringify(f.outbox)},url:'http://127.0.0.1:45679'}).flush();await writeFile(${JSON.stringify(marker)},JSON.stringify({complete:result,pid:process.pid}));`;
  const result=await promisify(execFile)(process.execPath,['--input-type=module','-e',code],{env:{PATH:'/usr/bin:/bin',HOME:dir,AGENTMEMORY_HOME:dir,AGENTMEMORY_SECRET:'synthetic-secret',AGENTMEMORY_CAPTURE_DRAIN_CHILD:'1',AGENTMEMORY_CAPTURE_SPOOL_DIR:join(dir,'managed')},timeout:5000});
  const saved=JSON.parse(await readFile(marker,'utf8'));expect(saved.complete).toBe(false);expect(saved.pid).not.toBe(process.pid);expect((await f.pending())[0].body).toEqual(f.body);
 });
 it('does not accept a receipt if the observation disappears after the real file fence',async()=>{
  const f=await setup(),actual=f.fence.waitForKeys;vi.spyOn(f.fence,'waitForKeys').mockImplementation(async(...args:any[])=>{const result=await actual(...args);await f.kv.delete(KV.observations(f.body.sessionId),f.obs.id);return result;});
  expect(await f.client().flush()).toBe(false);expect((await f.pending())[0].body).toEqual(f.body);
 });
});
