import {timingSafeEqual} from 'node:crypto';
import {fault,fields,uuid} from './feedback-store.mjs';
export function feedbackViewerRequestAllowed(req){return req.headers?.['x-agentmemory-feedback']==='1'&&/^application\/json(?:;|$)/i.test(req.headers?.['content-type']||'')&&req.headers?.['sec-fetch-site']!=='cross-site';}
export function registerFeedbackApi(sdk,secret,{store,analysis,history}){
 const routes=[
  ['POST','/reports','reports-create',async r=>{const report=await store.createReport(r.body);return {status_code:report.replayed?200:201,body:report};}],
  ['GET','/reports','reports-list',async r=>({body:await store.listReports(query(r))})],
  ['GET','/reports/:id','reports-get',async r=>({body:await store.getReport(id(r),query(r))})],
  ['POST','/analysis','analysis',async r=>{fields(r.body,['requestId','reportIds']);if(!uuid(r.body.requestId)||r.body.reportIds!==undefined&&(!Array.isArray(r.body.reportIds)||r.body.reportIds.length>10||r.body.reportIds.some(x=>!uuid(x))))throw fault('invalid_analysis');const job=await analysis.start({...r.body,trigger:'manual'});return {status_code:job.replayed||job.status==='idle'?200:202,body:job};}],
  ['GET','/jobs/:id','jobs-get',async r=>({body:await store.getJob(id(r))})],
  ['GET','/settings','settings-get',async()=>({body:await store.getSettings()})],
  ['PUT','/settings','settings-put',async r=>({body:await store.putSettings(r.body)})],
  ['POST','/reports/:id/events','events',async r=>{fields(r.body,['requestId','expectedRevision','type','reason','evidence']);const {expectedRevision,...event}=r.body;return {body:await history.recordEvent(id(r),event,expectedRevision)};}],
  ['POST','/reports/:id/relations/decisions','relation-decision',async r=>{fields(r.body,['requestId','expectedRevision','relationId','decision','reason']);const {expectedRevision,...decision}=r.body;return {body:await store.decideRelation(id(r),decision,expectedRevision)};}],
  ['GET','/reports/:id/work-order','work-order',async r=>({body:{text:await history.exportWorkOrder(id(r))}})]
 ];
 function query(r){return r.query_params||r.query||{};}
 function id(r){const value=r.path_params?.id||r.params?.id||query(r).id;if(!uuid(value))throw fault('invalid_id');return value;}
 for(const [method,path,name,handler]of routes){
  const function_id='api::feedback-'+name;
  sdk.registerFunction(function_id,async req=>{try{
   if(!secret)throw fault('authentication_required',503);const a=Buffer.from(req.headers?.authorization||req.headers?.Authorization||''),b=Buffer.from('Bearer '+secret);if(a.length!==b.length||!timingSafeEqual(a,b))throw fault('unauthorized',401);
   if(method!=='GET'){if(!feedbackViewerRequestAllowed(req))throw fault('feedback_marker_required',403);if(JSON.stringify(req.body??null).includes(secret))throw fault('sensitive_input_refused');if(Buffer.byteLength(JSON.stringify(req.body??null))>32768)throw fault('body_too_large',413);}
   const value=await handler(req);const body=value.body;const encoded=JSON.stringify(body);if(Buffer.byteLength(encoded)>131072)throw fault('response_too_large',413);if(encoded.includes(secret))throw fault('sensitive_response_refused',503);return {status_code:value.status_code||200,body};
  }catch(e){return {status_code:e.status||503,body:{error:e.status?e.code:'feedback_unavailable'}};}});
  sdk.registerTrigger({type:'http',function_id,config:{api_path:'/agentmemory/feedback'+path,http_method:method,middleware_function_ids:['middleware::api-auth']}});
 }
}
