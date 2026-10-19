import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {mkdtempSync,readdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {mockKV,mockSdk} from './helpers/mocks.js';
let dir:string;const url='http://127.0.0.1:48781';
const body={hookType:'post_tool_use',sessionId:'fixture',project:'fixture',cwd:'/tmp/fixture',timestamp:'2026-10-19T00:00:00Z',data:{tool_output:'preserve-raw'}};
const receipt={observationId:'fixture-obs',bootId:'fixtureboot000001',durableAfterMs:60000};
vi.mock('../src/logger.js',()=>({logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}}));
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'am-drain-owner-'));vi.resetModules();vi.stubEnv('AGENTMEMORY_URL',url);vi.stubEnv('AGENTMEMORY_CAPTURE_SPOOL_DIR',dir);vi.stubEnv('AGENTMEMORY_CAPTURE_SPOOL','true');vi.stubEnv('AGENTMEMORY_CAPTURE_DRAIN_CHILD','1');});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});});
function records(){return readdirSync(dir).filter(n=>n.endsWith('.jsonl')).flatMap(n=>readFileSync(join(dir,n),'utf8').trim().split('\n').filter(Boolean).map(l=>({name:n,...JSON.parse(l)})));}
async function prepare(){const {appendSpool}=await import('../src/capture/spool.js');expect(appendSpool(url,'fixture-owner-event',body,'fixture',{dir,requireReceipt:true,preserveImages:true}).spooled).toBe(true);}
async function drain(consumer:string,{status=201,ack:anyAck=receipt,retain=true,missing=false}={}){
 await prepare();if(!retain)vi.stubEnv('AGENTMEMORY_CAPTURE_SPOOL','false');
 vi.stubGlobal('fetch',vi.fn(async(_url,options)=>new Response(JSON.stringify(options?.method==='POST'?anyAck:{}),{status:options?.method==='POST'?status:200})));
 if(consumer==='hook')await (await import('../src/hooks/_capture.js')).runDrainChild();
 else if(consumer==='cli')await (await import('../src/cli/capture.js')).runCaptureCommand({base:url,args:['--drain','--json'],log:()=>{}});
 else{const sdk=mockSdk({looseTrigger:true}),kv=mockKV();sdk.registerFunction('mem::observe',async()=>missing?{deduplicated:true}:{observationId:'fixture-obs'});const c=(await import('../src/functions/capture.js')).registerCaptureFunctions(sdk as never,kv as never,{restPort:48781});try{await c.drainLocalSpool();}finally{c.stop();}}
}
it.each(['hook','cli'])('%s retains managed 401 until a receipt is possible',async consumer=>{await drain(consumer,{status:401});expect(records()).toEqual([expect.objectContaining({requireReceipt:true,eventId:'fixture-owner-event',body})]);expect(records()[0].name).not.toContain('.sent-');});
it.each(['hook','cli'])('%s retains malformed 2xx acknowledgement',async consumer=>{await drain(consumer,{ack:{...receipt,observationId:undefined}});expect(records()).toHaveLength(1);expect(records()[0].name).not.toContain('.sent-');});
it.each(['hook','cli','server'])('%s preserves ownership when retention cannot be saved',async consumer=>{await drain(consumer,{retain:false});expect(records()).toHaveLength(1);expect(records()[0].name).not.toContain('.sent-');});
it.each(['hook','cli','server'])('%s preserves managed flags after successful replay',async consumer=>{await drain(consumer);expect(records()).toHaveLength(1);expect(records()[0]).toMatchObject({requireReceipt:true,body});expect(records()[0].name).toContain('.sent-');});
it('server does not invent a receipt for a duplicate with no observation id',async()=>{await drain('server',{missing:true});expect(records()).toHaveLength(1);expect(records()[0].name).not.toContain('.sent-');});

it('keeps retry ownership while another drainer holds the lock',async()=>{
 await prepare();const {spoolPaths}=await import('../src/capture/spool.js');
 writeFileSync(spoolPaths(url,dir).drainLock,'fixture');
 const result=await (await import('../src/hooks/_capture.js')).runDrainChild();expect(result).toMatchObject({skipped:'locked',remaining:1});
});
