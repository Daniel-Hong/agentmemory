import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,readFileSync,readdirSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {pathToFileURL} from 'node:url';
const clean:(()=>void)[]=[];afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();for(const f of clean.splice(0))f();});
it('marks only newly enqueued ordinary captures and retains accepted originals outside replay across client recreation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'am-sdk-compat-'));clean.push(()=>rmSync(dir,{recursive:true,force:true}));vi.stubEnv('AGENTMEMORY_CAPTURE_SPOOL_DIR',join(dir,'spool'));vi.stubEnv('AGENTMEMORY_CAPTURE_DRAIN_CHILD','1');
 const {HookClient}=await import(pathToFileURL(join(process.cwd(),'integrations/codex-compat/long-session-hook-client.mjs')).href);
 // Source wrapper resolves its packaged sibling only during flush.
 const b={eventId:'synthetic_compat_001',hookType:'post_tool_use',sessionId:'synthetic',project:'synthetic',cwd:'/synthetic',timestamp:'2026-10-27T00:00:00Z',data:{tool_output:'original'}};
 const client=new HookClient({dir:join(dir,'outbox'),url:'http://127.0.0.1:63000'});const path=await client.enqueue('/agentmemory/observe',b);
 expect(JSON.parse(readFileSync(path,'utf8')).completionPolicy).toBe('sdk-v1');
 const fetcher=vi.fn(async(_url:any,options:any)=>{const sent=JSON.parse(options.body);expect(sent.captureCompletion).toBe('sdk-v1');return Response.json({status:'accepted',state:'sdk_completed',eventId:b.eventId,completed:true,completion:'sdk',durable:false},{status:201});});vi.stubGlobal('fetch',fetcher);
 expect(await client.flush()).toBe(true);
 expect(readdirSync(join(dir,'outbox')).filter(n=>n.endsWith('.json'))).toEqual([]);
 const archive=join(dir,'outbox','accepted-originals');expect(readdirSync(archive)).toHaveLength(1);expect(JSON.parse(readFileSync(join(archive,readdirSync(archive)[0]),'utf8')).body).toEqual(b);
 expect(await new HookClient({dir:join(dir,'outbox'),url:'http://127.0.0.1:63000'}).flush()).toBe(true);expect(fetcher).toHaveBeenCalledTimes(1);
});
it('parks an SDK-tagged but unconfirmed original instead of retrying forever or blocking a new row',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'am-sdk-compat-held-'));clean.push(()=>rmSync(dir,{recursive:true,force:true}));
 const {HookClient}=await import(pathToFileURL(join(process.cwd(),'integrations/codex-compat/long-session-hook-client.mjs')).href);
 const b={eventId:'synthetic_held_001',sessionId:'same',data:{text:'original'}};const client=new HookClient({dir,url:'http://127.0.0.1:63000'});
 await client.enqueue('/agentmemory/observe',b);await client.enqueue('/agentmemory/observe',{...b,eventId:'synthetic_next_002'});
 const post=vi.fn(async(_u:any,o:any)=>{const sent=JSON.parse(o.body);return sent.eventId===b.eventId?Response.json({completion:'sdk',reason:'SDK_COMPLETION_ONLY',durable:false},{status:503}):Response.json({status:'accepted',state:'sdk_completed',eventId:sent.eventId,completed:true,completion:'sdk',durable:false},{status:201});});vi.stubGlobal('fetch',post);
 expect(await client.flush()).toBe(true);expect(readdirSync(dir).filter(n=>n.endsWith('.held'))).toHaveLength(1);expect(readdirSync(join(dir,'accepted-originals'))).toHaveLength(1);
 expect(await client.flush()).toBe(true);expect(post).toHaveBeenCalledTimes(2);
});
it('applies retained-original admission backpressure without deleting existing accepted sources',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'am-sdk-compat-full-'));clean.push(()=>rmSync(dir,{recursive:true,force:true}));vi.stubEnv('AGENTMEMORY_CAPTURE_SPOOL_MAX_BYTES','900');
 const {HookClient}=await import(pathToFileURL(join(process.cwd(),'integrations/codex-compat/long-session-hook-client.mjs')).href);
 mkdirSync(join(dir,'accepted-originals'),{recursive:true});writeFileSync(join(dir,'accepted-originals','old.json'),'x'.repeat(850));
 const client=new HookClient({dir,url:'http://127.0.0.1:63000'});
 await expect(client.enqueue('/agentmemory/observe',{eventId:'synthetic_full',data:'original'})).rejects.toThrow('capture_originals_full');
 expect(readFileSync(join(dir,'accepted-originals','old.json'),'utf8')).toBe('x'.repeat(850));expect(readdirSync(dir).filter(n=>n.endsWith('.json'))).toEqual([]);
});
it('counts interrupted own temp files against admission and cleans a failed enqueue temp',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'am-sdk-compat-temp-'));clean.push(()=>rmSync(dir,{recursive:true,force:true}));vi.stubEnv('AGENTMEMORY_CAPTURE_SPOOL_MAX_BYTES','900');
 const {HookClient}=await import(pathToFileURL(join(process.cwd(),'integrations/codex-compat/long-session-hook-client.mjs')).href);
 writeFileSync(join(dir,'old.json.00000000-0000-4000-8000-000000000000.tmp'),'x'.repeat(850));
 const client=new HookClient({dir,url:'http://127.0.0.1:63000'});
 await expect(client.enqueue('/agentmemory/observe',{eventId:'synthetic_temp',data:'original'})).rejects.toThrow('capture_originals_full');
 vi.stubEnv('AGENTMEMORY_CAPTURE_SPOOL_MAX_BYTES','9000');client.onPhase=(phase:string)=>{if(phase==='queue_rename')throw Error('synthetic_queue_rename');};
 await expect(client.enqueue('/agentmemory/observe',{eventId:'synthetic_temp',data:'original'})).rejects.toThrow('synthetic_queue_rename');
 expect(readdirSync(dir).filter(n=>n.endsWith('.tmp'))).toEqual(['old.json.00000000-0000-4000-8000-000000000000.tmp']);
});
