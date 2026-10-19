import * as fs from 'node:fs';
import {join,resolve,parse} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';

export function fault(code,status=400){return Object.assign(new Error(code),{code,status});}
export const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const clone=value=>structuredClone(value);
export function fields(value,allowed){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw fault('invalid_fields');}
export function text(value,max,required=false){if(typeof value!=='string'||[...value].length>max||(required&&!value.trim()))throw fault('invalid_text');return value;}
const transitions={received:['planned','deferred','duplicate'],planned:['implementing','deferred'],implementing:['verified','planned','deferred'],verified:['applied','implementing','deferred'],applied:['rolled_back'],deferred:['planned']};
const pendingRelations=r=>r.events.filter(e=>{
 if(e.type!=='relation'||!['conflicts_with','corrects'].includes(e.relationType))return false;
 const latest=[...r.events].reverse().find(d=>d.type==='relation_decision'&&d.relationId===e.id);
 return !latest||!['keep','reject'].includes(latest.decision);
});
const metadata=r=>({id:r.id,requestId:r.requestId,kind:r.kind,state:r.state,createdAt:r.createdAt,updatedAt:r.updatedAt,summary:[...r.content].slice(0,100).join(''),origin:r.origin,revision:r.revision,analysisIds:r.analysisIds,discovery:r.discovery,analysis:r.analysis,reviewRequired:pendingRelations(r).length});

export function createFeedbackStore({root='/srv/agentmemory/feedback',clock=()=>Date.now(),io=fs,serverVersion='unknown'}={}){
 root=resolve(root);const index=new Map(),requests=new Map(),errors=[];let chain=Promise.resolve(),uncertain=false;
 const time=()=>new Date(clock()).toISOString();
 function safe(path){let cur=parse(path).root;for(const part of path.slice(cur.length).split('/').filter(Boolean)){cur=join(cur,part);if(io.existsSync(cur)&&io.lstatSync(cur).isSymbolicLink())throw fault('symlink_refused');}}
 safe(root);io.mkdirSync(root,{recursive:true,mode:0o700});io.chmodSync(root,0o700);
 for(const name of ['reports','jobs']){safe(join(root,name));io.mkdirSync(join(root,name),{recursive:true,mode:0o700});io.chmodSync(join(root,name),0o700);}
 const pathFor=(kind,id)=>{if(!uuid(id))throw fault('invalid_id');const path=join(root,kind,id+'.json');safe(path);return path;};
 function read(path){safe(path);try{return JSON.parse(io.readFileSync(path,'utf8'));}catch(e){if(e.code==='ENOENT')throw fault('not_found',404);throw fault('record_unreadable',503);}}
 function write(path,data){safe(path);const tmp=path+'.'+randomUUID()+'.tmp';let fd;try{fd=io.openSync(tmp,'wx',0o600);io.writeFileSync(fd,JSON.stringify(data)+'\n');io.fsyncSync(fd);io.closeSync(fd);fd=undefined;io.renameSync(tmp,path);const dir=io.openSync(resolve(path,'..'),'r');try{io.fsyncSync(dir);}finally{io.closeSync(dir);}}catch{uncertain=true;throw fault('persistence_unavailable',503);}finally{if(fd!==undefined)io.closeSync(fd);if(io.existsSync(tmp))io.unlinkSync(tmp);}}
 function serial(fn){const p=chain.then(fn);chain=p.catch(()=>{});return p;}
 function report(id){return read(pathFor('reports',id));}
 function saveReport(r){write(pathFor('reports',r.id),r);index.set(r.id,metadata(r));requests.set(r.requestId,r.id);return clone(r);}
 for(const file of io.readdirSync(join(root,'reports'))){if(!file.endsWith('.json'))continue;try{const r=read(join(root,'reports',file));if(!uuid(r.id)||!uuid(r.requestId)||r.schemaVersion!==1||typeof r.content!=='string'||typeof r.createdAt!=='string'||!Number.isFinite(Date.parse(r.createdAt))||!Number.isInteger(r.revision)||!Array.isArray(r.analysisIds)||!['received','planned','implementing','verified','applied','deferred','duplicate','rolled_back'].includes(r.state)||file!==r.id+'.json'||!Array.isArray(r.events))throw Error();index.set(r.id,metadata(r));requests.set(r.requestId,r.id);}catch{errors.push({file:/^[a-zA-Z0-9.-]+$/.test(file)?file:'invalid_name',error:'record_unreadable'});}}
 const initial={revision:1,scheduleEnabled:false,intervalHours:24,lastRunAt:null,nextRunAt:null};
 function settings(){const p=join(root,'settings.json');if(!io.existsSync(p))return clone(initial);try{const s=read(p);if(!Number.isInteger(s.revision)||typeof s.scheduleEnabled!=='boolean'||![6,12,24,48].includes(s.intervalHours))throw Error();return s;}catch{return {...clone(initial),revision:0,settingsReadError:'record_unreadable'};}}
 function pageLimit(value){const n=value===undefined?20:Number(value);if(!Number.isInteger(n)||n<1||n>50)throw fault('invalid_limit');return n;}
 return {
  createReport(input,{discovery}={}){return serial(()=>{fields(input,['requestId','kind','content','reproduction','expected','pageId']);if(!uuid(input.requestId)||!['bug','improvement','feature'].includes(input.kind))throw fault('invalid_report');const source={requestId:input.requestId,kind:input.kind,content:text(input.content,4000,true),reproduction:text(input.reproduction??'',2000),expected:text(input.expected??'',2000),pageId:text(input.pageId??'',80)};if(!/^[A-Za-z0-9_/-]*$/.test(source.pageId))throw fault('invalid_page');if(uncertain){for(const file of io.readdirSync(join(root,'reports'))){if(!file.endsWith('.json'))continue;try{const r=read(join(root,'reports',file));if(uuid(r.id)&&uuid(r.requestId)&&file===r.id+'.json'){index.set(r.id,metadata(r));requests.set(r.requestId,r.id);}}catch{}}uncertain=false;}const prior=requests.get(input.requestId);if(prior){const r=report(prior);if(r.inputHash!==digest(source))throw fault('request_conflict',409);write(pathFor('reports',r.id),r);return {...clone(r),replayed:true};}return saveReport({schemaVersion:1,id:randomUUID(),requestId:input.requestId,inputHash:digest(source),createdAt:time(),updatedAt:time(),origin:discovery?'inspection':'user',...(discovery?{discovery:clone(discovery)}:{}),kind:source.kind,content:source.content,reproduction:source.reproduction,expected:source.expected,context:{serverVersion,pageId:source.pageId},state:'received',duplicateOf:null,revision:1,analysisIds:[],events:[]});});},
  async listReports(q={}){const limit=pageLimit(q.limit);let after;try{after=q.cursor?JSON.parse(Buffer.from(q.cursor,'base64url').toString()):null;if(after&&(!Array.isArray(after)||after.length!==2||!uuid(after[1])))throw Error();}catch{throw fault('invalid_cursor');}const rows=[...index.values()].filter(r=>(!q.review||q.review==='required'&&r.reviewRequired>0)&&(!q.state||r.state===q.state)&&(!q.kind||r.kind===q.kind)&&(!q.requestId||r.requestId===q.requestId)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id)).filter(r=>!after||r.createdAt>after[0]||r.createdAt===after[0]&&r.id>after[1]);const selected=rows.slice(0,limit);return {reports:clone(selected),nextCursor:rows.length>limit?Buffer.from(JSON.stringify([selected.at(-1).createdAt,selected.at(-1).id])).toString('base64url'):null,readErrors:clone(errors.slice(0,50))};},
  async getReport(id,q={}){const r=report(id),limit=pageLimit(q.limit);const end=q.eventCursor===undefined?r.events.length:Number(q.eventCursor);if(!Number.isInteger(end)||end<0||end>r.events.length)throw fault('invalid_cursor');const out={...clone(r),events:[],nextEventCursor:null};let start=end;while(start>0&&out.events.length<limit){const candidate=[r.events[start-1],...out.events];if(Buffer.byteLength(JSON.stringify({...out,events:candidate,nextEventCursor:String(start-1)}))>131072)break;out.events=candidate;start--;}if(start===end&&end>0)throw fault('event_too_large',413);out.nextEventCursor=start>0?String(start):null;return out;},
  appendEvent(id,event,expectedRevision){return serial(()=>{const r=report(id);if(!uuid(event.requestId))throw fault('invalid_request_id');const prior=r.events.find(e=>e.requestId===event.requestId);if(prior){if(prior.inputHash!==digest(event))throw fault('request_conflict',409);return {...clone(r),replayed:true};}if(r.revision!==expectedRevision)throw fault('revision_conflict',409);if(!transitions[r.state]?.includes(event.type))throw fault('invalid_transition',409);text(event.reason,2000,true);if(event.type==='duplicate'){if(!uuid(event.evidence?.duplicateOf)||event.evidence.duplicateOf===id)throw fault('invalid_duplicate');report(event.evidence.duplicateOf);r.duplicateOf=event.evidence.duplicateOf;}r.state=event.type;r.events.push({...clone(event),id:randomUUID(),at:time(),actor:'operator',inputHash:digest(event),...((event.type==='applied'||event.type==='verified'&&event.evidence?.lesson)?{memoryReview:'required'}:{})});r.revision++;r.updatedAt=time();return saveReport(r);});},
  appendRelation(jobId,input){return serial(()=>{
   fields(input,['sourceReportId','targetReportId','type','evidence','level']);
   const {sourceReportId,targetReportId}=input;
   if(!uuid(jobId)||!uuid(sourceReportId)||!uuid(targetReportId)||sourceReportId===targetReportId||!['related','additional_evidence','conflicts_with','corrects'].includes(input.type)||input.level!=='candidate')throw fault('invalid_relation');
   text(input.evidence,2000,true);
   const job=read(pathFor('jobs',jobId));
   if(job.status!=='completed'||!job.reportIds?.includes(sourceReportId)||![sourceReportId,targetReportId].every(id=>[...job.reportIds,...job.candidateIds||[]].includes(id)&&Number.isInteger(job.reportRevisions?.[id])))throw fault('relation_outside_analysis');
   const source=report(sourceReportId),target=report(targetReportId);
   const key=digest([jobId,sourceReportId,targetReportId,input.type,job.reportRevisions[sourceReportId],job.reportRevisions[targetReportId]]);
   const prior=source.events.find(e=>e.relationKey===key);
   if(prior){if(prior.inputHash!==digest(input))throw fault('request_conflict',409);return {...clone(source),replayed:true};}
   // Our own relations advance revision but do not invalidate this batch's evidence.
   const originalRevision=r=>r.revision-r.events.filter(e=>e.type==='relation'&&e.analysisJobId===jobId).length;
   if(originalRevision(source)!==job.reportRevisions[sourceReportId]||originalRevision(target)!==job.reportRevisions[targetReportId])throw fault('revision_conflict',409);
   source.events.push({id:randomUUID(),type:'relation',relationType:input.type,sourceReportId,targetReportId,sourceRevision:job.reportRevisions[sourceReportId],targetRevision:job.reportRevisions[targetReportId],evidence:input.evidence,level:'candidate',analysisJobId:jobId,relationKey:key,inputHash:digest(input),actor:'analysis',at:time()});
   source.revision++;source.updatedAt=time();return saveReport(source);
  });},
  decideRelation(id,input,expectedRevision){return serial(()=>{
   fields(input,['requestId','relationId','decision','reason']);
   if(!uuid(input.requestId)||!uuid(input.relationId)||!['keep','reject','request_evidence','defer'].includes(input.decision))throw fault('invalid_relation_decision');
   text(input.reason,2000,true);const r=report(id),prior=r.events.find(e=>e.requestId===input.requestId);
   if(prior){if(prior.inputHash!==digest(input))throw fault('request_conflict',409);return {...clone(r),replayed:true};}
   if(r.revision!==expectedRevision)throw fault('revision_conflict',409);
   if(!r.events.some(e=>e.id===input.relationId&&e.type==='relation'))throw fault('relation_not_found',404);
   r.events.push({...clone(input),id:randomUUID(),type:'relation_decision',actor:'operator',at:time(),inputHash:digest(input)});r.revision++;r.updatedAt=time();return saveReport(r);
  });},
  updateReport(id,fn){return serial(()=>{const r=report(id);fn(r);r.revision++;r.updatedAt=time();return saveReport(r);});},
  async readReport(id){return clone(report(id));},
  async allMetadata(){return clone([...index.values()]);},
  saveJob(job){return serial(()=>{write(pathFor('jobs',job.id),job);return clone(job);});},
  async getJob(id){return read(pathFor('jobs',id));},
  async listJobs(){const jobs=[];for(const n of io.readdirSync(join(root,'jobs')).filter(n=>n.endsWith('.json'))){try{const j=read(join(root,'jobs',n));if(!uuid(j.id)||!['queued','running','completed','failed','interrupted'].includes(j.status)||n!==j.id+'.json')throw Error();jobs.push(j);}catch{if(!errors.some(e=>e.file==='jobs/'+n))errors.push({file:'jobs/'+n,error:'record_unreadable'});}}return jobs;},
  async getSettings(){return settings();},
  putSettings(input){return serial(()=>{fields(input,['revision','scheduleEnabled','intervalHours']);const p=join(root,'settings.json'),old=settings();if(input.revision!==old.revision)throw fault('revision_conflict',409);if(typeof input.scheduleEnabled!=='boolean'||![6,12,24,48].includes(input.intervalHours))throw fault('invalid_settings');if(old.settingsReadError){safe(p);const backup=join(root,'settings.corrupt-'+randomUUID()+'.json');io.copyFileSync(p,backup);io.chmodSync(backup,0o600);}const {settingsReadError,...valid}=old;const value={...valid,...input,revision:old.revision+1,nextRunAt:input.scheduleEnabled?new Date(clock()+input.intervalHours*3600000).toISOString():null};write(p,value);return value;});},
  scheduleUpdate(patch){return serial(async()=>{const p=join(root,'settings.json'),old=io.existsSync(p)?read(p):initial;const s={...old,...patch};write(p,s);return s;});},
  async flush(){await chain;}
 };
}
