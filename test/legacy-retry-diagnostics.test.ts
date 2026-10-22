import {afterEach,beforeEach,expect,it,vi}from'vitest';
import {mkdtemp,readFile,readdir,rm,writeFile}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
import{HookClient,createLegacyRetryDiagnosticSink}from'../integrations/codex-compat/long-session-hook-client.mjs';
let dir:string;beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'am-retry-diag-'));});afterEach(async()=>{vi.unstubAllGlobals();await rm(dir,{recursive:true,force:true});});
it('reports head timeout and per-session blocking without content or policy changes',async()=>{
 const report=vi.fn();vi.stubGlobal('fetch',vi.fn(async()=>{throw new DOMException('PRIVATE_ERROR','TimeoutError');}));
 const client=new HookClient({dir,onRetryDiagnostics:report}as never);
 await client.enqueue('/agentmemory/session/end',{sessionId:'PRIVATE_SESSION',data:'PRIVATE_BODY'});await client.enqueue('/agentmemory/observe',{sessionId:'PRIVATE_SESSION',data:'PRIVATE_BODY'});
 expect(await client.flush()).toBe(false);expect(fetch).toHaveBeenCalledTimes(1);
 expect(report).toHaveBeenCalledTimes(1);expect(report.mock.calls[0]![0]).toMatchObject({listed:2,attempted:1,failed:1,blockedOrdered:1});
 expect(report.mock.calls[0]![0].operations[0]).toMatchObject({requestKind:'session_end',outcome:'timeout_or_abort',retained:true});expect(JSON.stringify(report.mock.calls)).not.toMatch(/PRIVATE_/);
 const names=(await readdir(dir)).filter(n=>n.endsWith('.json'));expect(names).toHaveLength(2);const first=JSON.parse(await readFile(join(dir,names.sort()[0]!), 'utf8'));expect(first.attempts).toBe(1);expect(first.body.data).toBe('PRIVATE_BODY');
});
it('diagnostic exceptions cannot turn an acknowledged record into a retained failure',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('{"success":true}')));const client=new HookClient({dir,onRetryDiagnostics:()=>{throw Error('logging unavailable');}}as never);
 await client.enqueue('/agentmemory/session/end',{sessionId:'PRIVATE_SESSION'});expect(await client.flush()).toBe(true);expect((await readdir(dir)).filter(n=>n.endsWith('.json'))).toEqual([]);
});
it('reports backoff without sending and ignores asynchronous diagnostic failure',async()=>{
 await writeFile(join(dir,'000.json'),JSON.stringify({path:'/agentmemory/session/end',body:{sessionId:'PRIVATE_SESSION'},nextAttemptAt:Date.now()+60000}));vi.stubGlobal('fetch',vi.fn());const report=vi.fn(async()=>{throw Error('no log');});
 const client=new HookClient({dir,onRetryDiagnostics:report}as never);expect(await client.flush()).toBe(false);expect(fetch).not.toHaveBeenCalled();expect(report.mock.calls[0]![0]).toMatchObject({blockedBackoff:1,attempted:0});
});
it('bounds the private diagnostic file and excludes it from queue selection',async()=>{
 expect(createLegacyRetryDiagnosticSink).toBeTypeOf('function');let now=0;const sink=createLegacyRetryDiagnosticSink(dir,{clock:()=>now,intervalMs:1000});
 for(let i=0;i<12;i++){await sink({listed:i,attempted:1,operations:[{requestKind:'session_end',outcome:'http_error',httpStatus:401,private:'PRIVATE_BODY'}],private:'PRIVATE_SECRET'});now+=1000;}
 const files=await readdir(dir);expect(files.filter(n=>n.endsWith('.json'))).toHaveLength(0);expect(files).toEqual(['.legacy-retry-diagnostics']);const text=await readFile(join(dir,files[0]!), 'utf8');expect(text).not.toContain('PRIVATE');expect(Buffer.byteLength(text)).toBeLessThan(16384);expect(JSON.parse(text).recent).toHaveLength(8);
 now-=1000;expect(await sink({listed:999})).toBe(false);expect(JSON.parse(await readFile(join(dir,files[0]!), 'utf8')).recent).toHaveLength(8);
});
it('does not release another in-flight diagnostic write slot when suppressed',async()=>{
 const sink=createLegacyRetryDiagnosticSink(dir,{intervalMs:0});const results=await Promise.all([sink({listed:1}),sink({listed:2}),sink({listed:3})]);expect(results).toEqual([true,false,false]);
});
