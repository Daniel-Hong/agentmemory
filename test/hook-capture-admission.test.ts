import {afterEach, beforeEach, expect, it} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
let root:string;
let retainRoot=false;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'am-hook-admission-'));});
afterEach(()=>{if(!retainRoot)rmSync(root,{recursive:true,force:true});});
async function runHook(name:string,body:Record<string,unknown>,extra:Record<string,string>={}){
 const log=join(root,'fetch-count.json');const preload=join(root,'fake-fetch.mjs');
 writeFileSync(preload,`import {writeFileSync} from 'node:fs';const paths=[];globalThis.fetch=async(url,options)=>{if(process.env.SYNTHETIC_FETCH_STALL==='1'){setTimeout(()=>{},10000);return new Promise(()=>{})}const b=JSON.parse(options.body||'{}');paths.push(new URL(url).pathname);return new Response(JSON.stringify({eventId:b.eventId,status:'accepted',completion:'sdk',completed:true,durable:false}),{status:201})};process.on('exit',()=>writeFileSync(process.env.SYNTHETIC_FETCH_LOG,JSON.stringify(paths)));`);
 const env={PATH:'/usr/bin:/bin',HOME:root,TMPDIR:root,AGENTMEMORY_URL:'http://127.0.0.1:63000',AGENTMEMORY_SECRET:'synthetic-only',AGENTMEMORY_CAPTURE_SPOOL_DIR:join(root,'spool'),SYNTHETIC_FETCH_LOG:log,...extra};
 const child=spawn('/usr/bin/node',['--max-old-space-size=192','--import',preload,resolve('dist/hooks/'+name+'.mjs')],{cwd:root,env,stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(body));
 const result=await new Promise<{code:number|null,signal:NodeJS.Signals|null}>((resolve,reject)=>{let uncertain:ReturnType<typeof setTimeout>|undefined;const deadline=setTimeout(()=>{child.kill('SIGTERM');uncertain=setTimeout(()=>{retainRoot=true;child.unref();child.stdout.destroy();child.stderr.destroy();reject(new Error('synthetic child unreaped; inspect retained '+root));},2000);},8000);child.once('error',e=>{clearTimeout(deadline);if(uncertain)clearTimeout(uncertain);reject(e)});child.once('close',(code,signal)=>{clearTimeout(deadline);if(uncertain)clearTimeout(uncertain);resolve({code,signal})});});
 return {...result,stdout,stderr,paths:existsSync(log)?JSON.parse(readFileSync(log,'utf8')) as string[]:[],startupError:existsSync(log)?'':stderr};
}
function image(n:number){return {session_id:'synthetic-session',cwd:root,tool_name:'Read',tool_input:{file_path:'synthetic.png'},tool_response:'data:image/png;base64,'+'A'.repeat(n)};}
function expectNotRetained(r:Awaited<ReturnType<typeof runHook>>){expect(r.startupError).toBe('');expect(r.signal).toBeNull();expect(r.code).toBe(1);expect(r.stdout).toBe('');expect(r.stderr).toContain('CAPTURE_LOCAL_HANDOFF_FAILED');expect(r.stderr).not.toContain('data:image');expect(r.stderr).not.toContain('synthetic-only');}
it('reports oversized native image admission failure instead of exiting successfully',async()=>{const r=await runHook('post-tool-use',image(300*1024));expectNotRetained(r);expect(r.paths).toEqual([]);});
it('reports disabled preservation without POST or silently successful exit',async()=>{const r=await runHook('post-tool-use',image(1024),{AGENTMEMORY_CAPTURE_SPOOL:'false'});expectNotRetained(r);expect(r.paths).toEqual([]);});
it('reports original I/O failure without POST and leaves original marker intact',async()=>{const f=join(root,'file');writeFileSync(f,'unchanged');const r=await runHook('post-tool-use',image(1024),{AGENTMEMORY_CAPTURE_SPOOL_DIR:join(f,'child')});expectNotRetained(r);expect(r.paths).toEqual([]);expect(readFileSync(f,'utf8')).toBe('unchanged');});
it('reports full preservation quota and keeps existing protected spool untouched',async()=>{const d=join(root,'spool');mkdirSync(d);const f=join(d,'local-63000.jsonl');const prior=JSON.stringify({v:1,eventId:'prior',spooledAt:new Date().toISOString(),requireReceipt:true,attempts:0,reason:'prior',body:{text:'x'.repeat(65536)}})+'\n';writeFileSync(f,prior);const r=await runHook('post-tool-use',image(1024),{AGENTMEMORY_CAPTURE_SPOOL_MAX_BYTES:'65536'});expectNotRetained(r);expect(r.paths).toEqual([]);expect(readFileSync(f,'utf8')).toBe(prior);});
it('preserves small native image delivery and successful exit',async()=>{const r=await runHook('post-tool-use',image(1024));expect(r.code).toBe(0);expect(r.stderr).toBe('');expect(r.stdout).toBe('');expect(r.paths).toEqual(['/agentmemory/observe']);});
it('keeps Stop session end even when its capture cannot be retained and preserves failure exit',async()=>{const r=await runHook('stop',{session_id:'synthetic-session',cwd:root,last_assistant_message:'synthetic answer'},{AGENTMEMORY_CAPTURE_SPOOL:'false'});expectNotRetained(r);expect(r.paths).toEqual(['/agentmemory/session/end']);});

it('reports unconfirmed exit when hook cap fires before capture completes',async()=>{const r=await runHook('post-tool-use',image(1024),{SYNTHETIC_FETCH_STALL:'1'});expect(r.code).toBe(1);expect(r.stdout).toBe('');expect(r.stderr).toContain('CAPTURE_LOCAL_HANDOFF_UNCONFIRMED');expect(r.paths).toEqual([]);});
