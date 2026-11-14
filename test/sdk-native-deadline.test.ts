import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {isolatedHookEnv} from './helpers/isolated-hook-env.js';
const roots:string[]=[];
afterEach(()=>{for(const dir of roots.splice(0))rmSync(dir,{recursive:true,force:true});});
async function run(localMs:number,replyMs:number){
 const root=mkdtempSync(join(tmpdir(),'native-sdk-deadline-'));roots.push(root);const dir=join(root,'spool-v2'),trace=join(root,'trace.jsonl');
 const env=isolatedHookEnv(root,{AGENTMEMORY_URL:'http://127.0.0.1:43111',AGENTMEMORY_SECRET:'synthetic-only',AGENTMEMORY_PROJECT_NAME:'synthetic',AGENTMEMORY_SDK_CAPTURE_V2_DIR:dir,TMPDIR:root,TMP:root,TEMP:root,FIXTURE_TRACE:trace,FIXTURE_LOCAL_DELAY_MS:String(localMs),FIXTURE_REPLY_DELAY_MS:String(replyMs)});
 const entry=process.env.SDK_NATIVE_FIXTURE_ENTRY??resolve('src/hooks/post-tool-use.ts');
 const child=spawn(process.execPath,['--import',resolve('test/helpers/sdk-native-deadline-preload.mjs'),'--import',resolve('node_modules/tsx/dist/loader.mjs'),entry,'--agentmemory-sdk-capture-v2'],{cwd:root,env,stdio:['pipe','pipe','pipe']});
 let stderr='',stdout='';child.stderr.on('data',v=>stderr+=v);child.stdout.on('data',v=>stdout+=v);
 const watchdog=setTimeout(()=>child.kill(),8000);
 child.stdin.end(JSON.stringify({session_id:'synthetic',tool_name:'fixture_tool',tool_input:{synthetic:true},tool_response:'synthetic',cwd:root}));
 const exit=await new Promise<number|null>((done,reject)=>{child.once('exit',done);child.once('error',reject);});clearTimeout(watchdog);
 const ids=readdirSync(join(dir,'originals'));expect(ids).toHaveLength(1);
 const manifest=JSON.parse(readFileSync(join(dir,'originals',ids[0],'manifest.json'),'utf8'));
 const refs=readdirSync(join(dir,'queue')).filter(v=>v.endsWith('.ref')).map(v=>JSON.parse(readFileSync(join(dir,'queue',v),'utf8')));
 return {exit,stderr,stdout,manifest,refs,trace:readFileSync(trace,'utf8').trim().split('\n').map(v=>JSON.parse(v))};
}
for(const [localMs,replyMs] of [[0,20],[900,1000]])it(`native shared deadline completes ACK after local ${localMs}ms and reply ${replyMs}ms`,async()=>{
 const r=await run(localMs,replyMs);expect(r.exit).toBe(0);expect(r.stderr).toBe('');expect(r.stdout).toBe('');expect(r.manifest.completed).toBe(true);expect(r.refs).toEqual([]);expect(r.trace.filter(v=>v.event==='mock_ack_returned')).toHaveLength(1);
},10000);
it('native shared deadline aborts a late POST and durably parks before the hard exit cap',async()=>{
 const r=await run(1000,2800);expect(r.exit).toBe(1);expect(r.stdout).toBe('');expect(r.stderr).toContain('SDK_SEND_UNCERTAIN');expect(r.stderr).not.toContain('CAPTURE_LOCAL_HANDOFF_UNCONFIRMED');
 expect(r.manifest.completed).toBe(false);expect(r.refs).toHaveLength(1);expect(r.refs[0]).toMatchObject({state:'held',reason:'HELD',attempts:0});expect(r.refs[0].owner).toBeUndefined();
 expect(r.trace.filter(v=>v.event==='mock_ack_returned')).toHaveLength(0);expect(r.trace.filter(v=>v.event==='mock_post_aborted')).toHaveLength(1);
 const start=r.trace.find(v=>v.event==='native_cap_armed').atMs,end=r.trace.find(v=>v.event==='process_exit').atMs;
 expect(end-start).toBeLessThan(3500);console.log(JSON.stringify({syntheticNativeDeadline:true,localDelayMs:1000,mockReplyMs:2800,state:r.refs[0].state,attempts:r.refs[0].attempts,elapsedAfterCapArmedMs:end-start,networkCalls:0}));
},10000);
