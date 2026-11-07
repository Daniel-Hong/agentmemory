import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';
import {createServer,type Server,type IncomingMessage,type ServerResponse} from 'node:http';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {SdkSpoolV2,drainSdkCapturesV2} from '../src/capture/sdk-delivery-v2.js';

let root:string,retainRoot=false;
const servers:Server[]=[];
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'am-v2-transport-'));retainRoot=false;});
afterEach(async()=>{
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(server=>new Promise<void>(done=>{server.closeAllConnections();server.close(()=>done());})));
  if(!retainRoot)rmSync(root,{recursive:true,force:true});
});
const target='http://127.0.0.1:63000';
const body={eventId:'synthetic-transport-backlog',hookType:'post_tool_use',sessionId:'synthetic-session',project:'synthetic',cwd:'/synthetic',timestamp:'2026-11-02T00:00:00Z',captureCompletion:'sdk-v1',data:{text:'synthetic backlog'}};
const ack=(b:Record<string,unknown>)=>({status:201,body:{eventId:b.eventId,status:'accepted',completion:'sdk',completed:true,durable:false}});
async function queued(){
  const store=new SdkSpoolV2({dir:join(root,'v2')});
  const {sourceId}=await store.retain(target,body.eventId,body);
  await store.enqueue(target,sourceId);
  return {store,sourceId};
}

it('does not POST when send-intent fsync consumes the monotonic drain budget; keeps a retryable source reference',async()=>{
  const {store,sourceId}=await queued();let clock=1000,calls=0;
  vi.spyOn(performance,'now').mockImplementation(()=>clock);
  const result=await drainSdkCapturesV2(target,async b=>{calls++;return ack(b);},{dir:join(root,'v2'),limit:1,budgetMs:250,storeOptions:{onPhase:phase=>{if(phase==='send_intent_fsynced')clock=1251;}}});
  expect(calls).toBe(0);
  expect(result).toMatchObject({attempted:1,delivered:0,held:0,remaining:1});
  expect((await store.pending(target))[0]).toMatchObject({sourceId,state:'pending',attempts:1});
  expect((await store.pending(target))[0].nextAttemptAt).toBeGreaterThan(Date.now());
  expect(await store.load(target,sourceId)).toEqual(body);
});

it('passes the original absolute deadline and fresh remaining budget after source readback',async()=>{
  await queued();let clock=1000,received:unknown;
  vi.spyOn(performance,'now').mockImplementation(()=>clock);
  const claim=SdkSpoolV2.prototype.claimForSend;
  vi.spyOn(SdkSpoolV2.prototype,'claimForSend').mockImplementation(async function(this:SdkSpoolV2,t,id,deadline){const value=await claim.call(this,t,id,deadline);clock+=30;return value;});
  const result=await drainSdkCapturesV2(target,async(b,...args:unknown[])=>{received=args[0];return ack(b);},{dir:join(root,'v2'),limit:1,budgetMs:250,storeOptions:{onPhase:phase=>{if(phase==='send_intent_fsynced')clock+=70;}}});
  expect(received).toEqual({deadline:1250,remainingMs:150});
  expect(result).toMatchObject({attempted:1,delivered:1,held:0,remaining:0});
});

async function listen(handler:(req:IncomingMessage,res:ServerResponse)=>void){
  const server=createServer(handler);servers.push(server);
  await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});
  const address=server.address();if(!address||typeof address==='string')throw Error('synthetic loopback address missing');
  return {server,url:`http://127.0.0.1:${address.port}`};
}
async function readBody(req:IncomingMessage){const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));return JSON.parse(Buffer.concat(chunks).toString()) as Record<string,any>;}
async function runNative(url:string){
  const image='data:image/png;base64,'+'A'.repeat(300*1024);
  const child=spawn('/usr/bin/node',['--max-old-space-size=256','--import',resolve('node_modules/tsx/dist/loader.mjs'),resolve('src/hooks/post-tool-use.ts'),'--agentmemory-sdk-capture-v2'],{
    cwd:root,env:{PATH:'/usr/bin:/bin',HOME:root,TMPDIR:root,AGENTMEMORY_URL:url,AGENTMEMORY_SECRET:'synthetic-only',AGENTMEMORY_SDK_CAPTURE_V2_DIR:join(root,'v2'),AGENTMEMORY_CAPTURE_SPOOL_DIR:join(root,'v1')},stdio:['pipe','pipe','pipe'],
  });
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.stdin.on('error',()=>{});
  child.stdin.end(JSON.stringify({event_id:'synthetic-transport-native',session_id:'synthetic-session',cwd:root,tool_name:'Read',tool_input:{file_path:'synthetic.png'},tool_response:image}));
  const result=await new Promise<{code:number|null,signal:NodeJS.Signals|null}>((done,reject)=>{
    let uncertain:ReturnType<typeof setTimeout>|undefined;
    const deadline=setTimeout(()=>{child.kill('SIGTERM');uncertain=setTimeout(()=>{retainRoot=true;child.unref();child.stdout.destroy();child.stderr.destroy();reject(Error('synthetic child unreaped; fixture retained at '+root));},2000);},10000);
    child.once('error',error=>{clearTimeout(deadline);if(uncertain)clearTimeout(uncertain);reject(error);});
    child.once('close',(code,signal)=>{clearTimeout(deadline);if(uncertain)clearTimeout(uncertain);done({code,signal});});
  });
  return {...result,stdout,stderr,imageHash:createHash('sha256').update(image).digest('hex')};
}
async function assertHeld(url:string,imageHash:string){
  const store=new SdkSpoolV2({dir:join(root,'v2')}),refs=await store.pending(url);
  expect(refs).toHaveLength(1);expect(refs[0].state).toBe('held');
  const stored=await store.load(url,refs[0].sourceId);
  expect(createHash('sha256').update((stored.data as any).image_data).digest('hex')).toBe(imageHash);
  expect((await store.usage()).originalBytes).toBeGreaterThan(300*1024);
  expect(existsSync(join(root,'v1'))).toBe(false);
}

it('native C refuses a real 307 redirect before a second endpoint receives the 300KiB body',async()=>{
  let aPosts=0,bPosts=0;
  const b=await listen((req,res)=>{void readBody(req).then(value=>{bPosts++;res.writeHead(201,{'Content-Type':'application/json'});res.end(JSON.stringify(ack(value).body));});});
  const a=await listen((req,res)=>{void readBody(req).then(()=>{aPosts++;res.writeHead(307,{Location:b.url+'/agentmemory/observe'});res.end();});});
  const result=await runNative(a.url);
  expect(aPosts).toBe(1);expect(bPosts).toBe(0);
  expect(result).toMatchObject({code:1,signal:null,stdout:''});
  expect(result.stderr).toContain('SDK_SEND_UNCERTAIN');
  await assertHeld(a.url,result.imageHash);
},15000);

it('does not classify a redirect toward a refused port as known-not-sent after the first POST',async()=>{
  const closed=await listen((_req,res)=>res.end());
  await new Promise<void>(done=>closed.server.close(()=>done()));
  let aPosts=0;
  const a=await listen((req,res)=>{void readBody(req).then(()=>{aPosts++;res.writeHead(307,{Location:closed.url+'/agentmemory/observe'});res.end();});});
  const result=await runNative(a.url);
  expect(aPosts).toBe(1);expect(result).toMatchObject({code:1,signal:null,stdout:''});
  expect(result.stderr).toContain('SDK_SEND_UNCERTAIN');
  await assertHeld(a.url,result.imageHash);
},15000);

it('native C still sends and acknowledges the exact 300KiB image on a nonredirecting endpoint',async()=>{
  let posts=0,imageHash='',eventId='';
  const endpoint=await listen((req,res)=>{void readBody(req).then(value=>{posts++;imageHash=createHash('sha256').update(value.data.image_data).digest('hex');eventId=value.eventId;res.writeHead(201,{'Content-Type':'application/json'});res.end(JSON.stringify(ack(value).body));});});
  const result=await runNative(endpoint.url);
  expect(result).toMatchObject({code:0,signal:null,stdout:'',stderr:''});expect(posts).toBe(1);expect(imageHash).toBe(result.imageHash);
  const store=new SdkSpoolV2({dir:join(root,'v2')});expect(await store.pending(endpoint.url)).toEqual([]);
  expect((await store.usage()).originalBytes).toBeGreaterThan(300*1024);expect(eventId).not.toBe('');
  expect(existsSync(join(root,'v1'))).toBe(false);
},15000);
