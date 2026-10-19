import {execFile} from 'node:child_process';
import {homedir} from 'node:os';
import {createFeedbackStore,fault} from './feedback-store.mjs';
import {createFeedbackAnalysis,importInspectionCandidates} from './feedback-analysis.mjs';
import {registerFeedbackApi} from './feedback-api.mjs';
import {createFeedbackHistory,createReceiptVerifier} from './feedback-history.mjs';

export function createCodexExecutor({codex='codex',root=process.cwd(),secret,args}){
 const clean=s=>String(s).replaceAll(secret||'\0','[redacted]').replace(/Bearer\s+\S+/gi,'Bearer [redacted]').replace(/sk-[A-Za-z0-9_-]{16,}/g,'[redacted]');
 return async({prompt,context,signal,timeoutMs})=>{
  const output=await new Promise((resolve,reject)=>{const child=execFile(codex,args(context,root),{env:{HOME:homedir(),PATH:process.env.PATH||'/usr/bin:/bin',LANG:'C.UTF-8'},timeout:timeoutMs,killSignal:'SIGTERM',signal,maxBuffer:2*1024*1024},(err,out)=>err?reject(fault(err.killed?'codex_timeout':'codex_execution_failed')):resolve(out));child.stdin.on('error',()=>{});child.stdin.end(clean(prompt));});
  let final='',completed=false,failed=false;for(const line of output.split('\n')){if(!line.trim())continue;const e=JSON.parse(line);if(e.type==='item.completed'&&e.item?.type==='agent_message')final=e.item.text;if(e.type==='turn.completed')completed=true;if(['turn.failed','error'].includes(e.type))failed=true;}
  if(!completed||failed||typeof final!=='string'||!final.trim())throw fault('codex_incomplete_response');if([...final].length>24000)throw fault('analysis_output_too_large');return JSON.parse(clean(final));
 };
}
export function registerFeedbackRuntime(sdk,secret,{root,collect,args,isPaused,version,receiptRoot,receipts={},clock,timers,execute}={}){
 const store=createFeedbackStore({root,clock,serverVersion:version});
 const verifyReceipt=receiptRoot?createReceiptVerifier({root:receiptRoot,receipts}):async()=>{throw fault('receipt_not_allowed');};
 const history=createFeedbackHistory({store,verifyReceipt});
 const analysis=createFeedbackAnalysis({store,collect,execute:execute||createCodexExecutor({secret,args}),isPaused,clock,timers});
 registerFeedbackApi(sdk,secret,{store,analysis,history});
 return {store,analysis,history,ready:analysis.ready,onSnapshot:job=>importInspectionCandidates(store,job),async stop(){await analysis.stop();},async drain(){await analysis.drain();await store.flush();}};
}
