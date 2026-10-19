import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';import { once } from 'node:events';import { mkdtempSync, rmSync } from 'node:fs';import { tmpdir } from 'node:os';import { join } from 'node:path';import { randomUUID } from 'node:crypto';
import { startViewerServer } from '../src/viewer/server.js';
import { createFeedbackStore } from '../src/feedback/feedback-store.mjs';import { registerFeedbackApi } from '../src/feedback/feedback-api.mjs';
let servers:Server[]=[];let roots:string[]=[];
afterEach(async()=>{for(const s of servers){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}servers=[];for(const root of roots)rmSync(root,{recursive:true,force:true});roots=[];});
it('real source Viewer proxy forwards bounded authenticated POST and PUT into feedback handlers',async()=>{
 const root=mkdtempSync(join(tmpdir(),'feedback-proxy-'));roots.push(root);const store=createFeedbackStore({root}),handlers=new Map();
 registerFeedbackApi({registerFunction:(id:string,handler:unknown)=>handlers.set(id,handler),registerTrigger(){}},'fixture-feedback-secret',{store,analysis:{},history:{}});
 const rest=createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;const id=req.method==='PUT'?'settings-put':'reports-create';const result=await handlers.get('api::feedback-'+id)({headers:req.headers,body:JSON.parse(body)});res.writeHead(result.status_code,{'Content-Type':'application/json'});res.end(JSON.stringify(result.body));});servers.push(rest);rest.listen(0,'127.0.0.1');await once(rest,'listening');
 const viewer=startViewerServer(0,null,null,'fixture-feedback-secret',(rest.address() as {port:number}).port);servers.push(viewer);await once(viewer,'listening');const base='http://127.0.0.1:'+(viewer.address() as {port:number}).port;
 const input={requestId:randomUUID(),kind:'bug',content:'source-native proxy'};
 for(const [path,method,body] of [['reports','POST',input],['settings','PUT',{revision:1,scheduleEnabled:true,intervalHours:6}]] as const){const response=await fetch(base+'/agentmemory/feedback/'+path,{method,headers:{'Content-Type':'application/json','x-agentmemory-feedback':'1'},body:JSON.stringify(body)});expect(response.status).toBe(path==='reports'?201:200);}
 const denied=await fetch(base+'/agentmemory/feedback/reports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});expect(denied.status).toBe(403);
 expect((await store.listReports({})).reports).toHaveLength(1);
 const page=await fetch(base+'/');expect(page.status).toBe(200);const html=await page.text();expect(html).toContain('feedback-launch');expect(html).not.toContain('AGENTMEMORY_FEEDBACK_VIEWER -->');expect(page.headers.get('content-security-policy')).toContain('nonce-');
});
