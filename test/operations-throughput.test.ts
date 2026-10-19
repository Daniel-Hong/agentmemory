import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {describe,it,expect} from 'vitest';
const html=readFileSync('src/viewer/index.html','utf8');
function setup(){
 const ctx:any={operations:{progressSamples:{}},autoRefresh:{seconds:30},Number,Date};
 for(const name of ['progressDuration','operationsStages','recordOperationsProgress','stageProgress']){
  const start=html.indexOf('function '+name+'(');if(start<0)continue;
  let depth=0;for(let n=html.indexOf('{',start);n<html.length;n++){if(html[n]==='{')depth++;if(html[n]==='}'&&--depth===0){runInNewContext(html.slice(start,n+1),ctx);break;}}
 }
 return ctx;
}
const stage=(extra:any={})=>({key:'embedding',pending:100,completed:10,epoch:'boot',counters:{worker:10},background:true,running:false,waiting:false,blocked:0,error:null,...extra});
const running={status:'running',pausedRequested:false};
function samples(c:any){for(const [at,completed,pending]of [[1000,10,120],[31000,15,110],[61000,20,100]])c.recordOperationsProgress([stage({completed,pending,counters:{worker:completed}})],at,running);}
describe('observed operations throughput',()=>{
 it('measures confirmed completion rather than pending-count reduction',()=>{const c=setup();samples(c);const r=c.stageProgress(stage({completed:20}),61000,running,true);expect(r.rate).toBe(10);expect(r.recent).toBe(10);expect(r.etaSeconds).toBe(600);});
 it('does not invent an ETA during initial measurement, missing counts or stale reads',()=>{const c=setup();c.recordOperationsProgress([stage()],1000,running);expect(c.stageProgress(stage(),1000,running,true).etaSeconds).toBeNull();samples(c);expect(c.stageProgress(stage(),61000,running,false).status).toContain('조회');expect(c.stageProgress(stage(),999999,running,true).etaSeconds).toBeNull();expect(c.stageProgress(stage({pending:null}),61000,running,true).status).toContain('미확인');});
 it('resets on worker epochs, cohort changes and any local counter decrease',()=>{const c=setup();samples(c);c.recordOperationsProgress([stage({completed:21,epoch:'new',counters:{worker:21}})],91000,running);expect(c.operations.progressSamples.embedding).toHaveLength(1);c.recordOperationsProgress([stage({completed:22,epoch:'new',counters:{worker:20,other:2}})],121000,running);expect(c.operations.progressSamples.embedding).toHaveLength(1);});
 it('never presents an ETA for held background work while capture may continue',()=>{const c=setup();samples(c);expect(c.stageProgress(stage(),61000,{status:'paused',pausedRequested:true},true).etaSeconds).toBeNull();const capture=stage({key:'capture',background:false});for(const [at,n]of [[1000,10],[31000,15],[61000,20]])c.recordOperationsProgress([stage({...capture,completed:n,counters:{worker:n}})],at,{status:'paused',pausedRequested:true});expect(c.stageProgress(capture,61000,{status:'paused',pausedRequested:true},true).rate).toBe(10);});
 it('distinguishes incoming work from a stalled worker and withholds completion time',()=>{const c=setup();for(const [at,n,p]of [[1000,10,90],[31000,15,95],[61000,20,100]])c.recordOperationsProgress([stage({completed:n,pending:p,counters:{worker:n}})],at,running);const r=c.stageProgress(stage(),61000,running,true);expect(r.status).toContain('유입');expect(r.rate).toBe(10);expect(r.etaSeconds).toBeNull();});
 it('marks no recent progress without claiming that an active provider request has stopped',()=>{const c=setup();for(const at of [1000,31000,61000])c.recordOperationsProgress([stage()],at,running);expect(c.stageProgress(stage({running:true}),61000,running,true).status).toContain('진행 중');expect(c.stageProgress(stage(),61000,running,true).status).toContain('완료 없음');expect(c.stageProgress(stage({error:'VECTOR_PUBLICATION_UNVERIFIED'}),61000,running,true).status).toContain('재시도');});
 it('keeps blocked, unavailable and finishing stages distinct from completion',()=>{const c=setup();expect(c.stageProgress(stage({pending:2,blocked:2}),61000,running,true).status).toContain('점검');expect(c.stageProgress(stage({pending:0,running:true}),61000,running,true).status).toContain('마무리');expect(c.stageProgress(stage({pending:0}),61000,running,true).status).toContain('대기 없음');});
 it('works with the supported five-minute polling interval',()=>{const c=setup();c.autoRefresh.seconds=300;c.recordOperationsProgress([stage()],1000,running);c.recordOperationsProgress([stage({completed:20,pending:100,counters:{worker:20}})],301000,running);expect(c.stageProgress(stage(),301000,running,true).rate).toBe(2);});
 it('withholds ETA for a new error even when earlier work completed',()=>{const c=setup();samples(c);const r=c.stageProgress(stage({error:'VECTOR_PUBLICATION_UNVERIFIED'}),61000,running,true);expect(r.etaSeconds).toBeNull();expect(r.status).toContain('재시도');});
 it('withholds ETA while a pause request has an uncertain outcome',()=>{const c=setup();samples(c);c.operations.controlBusy=true;c.operations.controlAction='pause';expect(c.stageProgress(stage(),61000,running,true).etaSeconds).toBeNull();});

 it('keeps initialization and invalid server counts unknown rather than empty',()=>{const c=setup();const rows=c.operationsStages({totals:{summary:0,compress:0,graph:0,embedding:0,features:null}},[],{captureProgress:{pending:-1},embeddingRecovery:{initialized:false,pendingCount:0}},true);expect(rows[0].pending).toBeNull();expect(rows.find((r:any)=>r.key==='embedding').pending).toBeNull();});

 it('resets persistent stage rates when a worker restarts with the same sessions',()=>{const c=setup();for(const [at,n]of [[1000,10],[31000,15],[61000,20]])c.recordOperationsProgress([stage({key:'capture',background:false,epoch:'boot-a'}),stage({key:'summary',epoch:'same-sessions',completed:n,counters:{s:n}})],at,running);c.recordOperationsProgress([stage({key:'capture',background:false,epoch:'boot-b'}),stage({key:'summary',epoch:'same-sessions',completed:21,counters:{s:21}})],91000,running);expect(c.operations.progressSamples.summary).toHaveLength(1);});

 it('explains unsupported completion counters rather than measuring forever',()=>{const c=setup();const r=c.stageProgress(stage({completed:null,epoch:null}),61000,running,true);expect(r.etaSeconds).toBeNull();expect(r.reason).toContain('근거 없음');});

 it('keeps five-minute polling samples when API latency pushes them past five minutes',()=>{const c=setup();c.autoRefresh.seconds=300;c.recordOperationsProgress([stage()],1000,running);c.recordOperationsProgress([stage({completed:20,pending:100,counters:{worker:20}})],301001,running);expect(c.operations.progressSamples.embedding).toHaveLength(2);expect(c.stageProgress(stage(),301001,running,true).rate).toBeCloseTo(2);});

 it('uses the explicit server stall verdict without a fabricated ETA',()=>{const c=setup();const r=c.stageProgress(stage({key:'capture',background:false,error:'CAPTURE_STALLED'}),61000,running,true);expect(r.status).toContain('정체');expect(r.etaSeconds).toBeNull();});

});
