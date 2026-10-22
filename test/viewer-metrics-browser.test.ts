import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

const source=readFileSync(process.env.METRICS_UI_SOURCE || 'src/viewer/index.html','utf8');
const evidence=process.env.METRICS_UI_EVIDENCE;
const cases=['historical','recent','missing','legacy','reset','invalid','off'];
const fixture=(scenario:string,view:string)=>`<script>
window.fixtureErrors=[];addEventListener('error',e=>fixtureErrors.push(e.message));addEventListener('unhandledrejection',e=>fixtureErrors.push(String(e.reason)));localStorage.clear();window.requests=[];
var fixtureMetric={offWithoutLlm:'${scenario}'==='off',functionId:'mem::summary',totalCalls:200,failureCount:190,avgLatencyMs:12};
if(!['missing','legacy','reset'].includes('${scenario}'))fixtureMetric.recent={windowMs:60000,windowStartAt:'2026-10-22T00:01:00.000Z',windowEndAt:'2026-10-22T00:02:00.000Z',observedSince:'2026-10-22T00:00:00.000Z',attemptCount:'${scenario}'==='invalid'?1:10,failureCount:'${scenario}'==='historical'?0:2};
var fixtureHealth={status:'healthy',health:{connectionState:'connected'},functionMetrics:[fixtureMetric],memoryPressure:{level:'normal'},captureProgress:{pending:2},embeddingRecovery:{initialized:true,pendingCount:3,lastError:'EMBEDDING_PROVIDER_ERROR'},featureLifecycle:{enabled:false},providerReadiness:{status:'ready'}};
var fixtureReport={status:'ok',headline:'Synthetic metrics fixture',checkedAt:new Date().toISOString(),problems:[],service:{version:'synthetic',ports:{}},provider:{llm:'openai',embeddings:'none'},functions:[fixtureMetric],flags:[],capture:{inbox:{pending:2,retrying:3,dead:4},sinceStart:{},spool:[],policy:{retryIntervalMs:30000,maxAttempts:5}}};
window.fetch=async(url,opts={})=>{requests.push({path:String(url),method:opts.method||'GET'});var path=String(url),payload={};if(path.includes('/viewer/snapshot'))payload={version:'synthetic',health:fixtureHealth.health,report:fixtureReport,functionMetrics:[fixtureMetric],counts:{sessions:1,observations:1},flags:[]};else if(path.includes('/health'))payload=fixtureHealth;else if(path.includes('/background/control'))payload={success:true,control:{status:'running',holds:[],activeOperations:0}};else if(path.includes('/sessions'))payload={sessions:[{id:'synthetic',project:'Synthetic fixture',observationCount:1,summaryProgress:{status:'blocked',pendingCount:1,blockedObservations:{one:{status:'blocked',diagnostics:{category:'output_truncated'}}}},enrichmentProgress:{compress:{status:'current',pendingCount:0},graph:{status:'current',pendingCount:0}}}]};return new Response(JSON.stringify(payload),{status:200,headers:{'Content-Type':'application/json'}});};
window.WebSocket=class{static OPEN=1;static CONNECTING=0;constructor(){this.readyState=1;setTimeout(()=>this.onopen&&this.onopen(),0);}send(){}close(){this.readyState=3;}};
setTimeout(async()=>{var proof={};try{await loadSnapshot();await loadOperations();setAutoRefresh(false,30);operations.metrics={'mem::summary':{totalCalls:200,failureCount:190,observedAt:'2026-10-22T00:05:00.000Z'}};operations.metricPrevious='${scenario}'==='missing'?{}:{'mem::summary':{totalCalls:'${scenario}'==='reset'?250:195,failureCount:'${scenario}'==='reset'?195:190,observedAt:'2026-10-22T00:01:00.000Z'}};switchTab('${view}');await showTab('${view}');renderTab('${view}');var root=document.getElementById('view-${view}');root.querySelectorAll('details').forEach(e=>e.open=true);var fn=root.querySelector('.metric-fn'),table=fn.closest('table'),row=fn.closest('tr'),cells=Array.from(row.cells);proof.functionWidth=fn.getBoundingClientRect().width;proof.text=root.innerText;proof.metrics=table.innerText;proof.aggregate=Array.from(root.querySelectorAll('.stat-card')).find(e=>e.textContent.includes('누적 실행 시도'))?.innerText;proof.historicalCell=cells[2].innerText;proof.historicalColor=cells[2].style.color;proof.red=getComputedStyle(document.documentElement).getPropertyValue('--red').trim();proof.rateColor=cells.find(e=>e.textContent.trim()==='95%')?.style.color;proof.recentCell=cells.find(e=>e.textContent.includes('실패')&&e.textContent.includes('시도'))?.innerText;proof.attention=document.getElementById('health-attention')?.innerText;proof.errors=fixtureErrors;proof.getOnly=requests.every(r=>r.method==='GET');proof.overflow=root.scrollWidth>root.clientWidth;fn.closest('.card').scrollIntoView({block:'start'});}catch(e){proof.error=String(e.stack||e);}document.getElementById('metrics-proof').textContent=JSON.stringify(proof);},120);
</script>`;

describe.skipIf(spawnSync('google-chrome',['--version'],{encoding:'utf8'}).status!==0)('honest cumulative, observed and current metrics in real Chromium',()=>{
  it.each(cases.flatMap(s=>[1280,390].flatMap(w=>['health','dashboard'].map(v=>[s,w,v]))))('%s at %i/%s',(scenario,width,view)=>{
    const dir=mkdtempSync(join(tmpdir(),'am-metrics-browser-'));
    try{
      if(evidence)mkdirSync(evidence,{recursive:true});
      const name=`${scenario}-${width}-${view}`,path=join(dir,'fixture.html');
      writeFileSync(path,source.replace('<body>','<body>'+fixture(String(scenario),String(view))).replace('</body>','<pre id="metrics-proof" hidden></pre></body>'));
      const run=spawnSync('google-chrome',['--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--no-first-run','--user-data-dir='+join(dir,'profile'),'--window-size='+width+',1000','--virtual-time-budget=1100','--screenshot='+(evidence?join(resolve(evidence),name+'.png'):join(dir,'preview.png')),'--dump-dom','file://'+path],{encoding:'utf8',timeout:25000,maxBuffer:3000000});
      expect(run.status,run.stderr.slice(-500)).toBe(0);
      const match=run.stdout.match(/<pre id="metrics-proof"[^>]*>([\s\S]*?)<\/pre>/);expect(match).toBeTruthy();
      const proof=JSON.parse(match![1].replaceAll('&quot;','"').replaceAll('&amp;','&').replaceAll('&lt;','<').replaceAll('&gt;','>'));
      if(evidence)writeFileSync(join(evidence,name+'.json'),JSON.stringify(proof,null,2));
      expect(proof.error).toBeUndefined();expect(proof.functionWidth).toBeGreaterThanOrEqual(120);expect(proof.errors).toEqual([]);expect(proof.getOnly).toBe(true);expect(proof.overflow).toBe(false);expect(proof.historicalCell).toBe('190');expect(proof.historicalColor).not.toBe('var(--red)');expect(proof.rateColor).not.toBe('var(--red)');expect(proof.text).toContain('집계 시작 미확인');expect(proof.metrics).toContain('실행 시도');
      if(scenario==='off'&&view==='dashboard'){expect(proof.aggregate).toContain('200');expect(proof.aggregate).toContain('190');}
      if(scenario==='historical'){expect(proof.metrics).toContain('실패 0건 / 시도 10건');expect(proof.metrics).toContain('2026-10-22T00:01:00.000Z');expect(proof.metrics).not.toContain('회복');}
      if(scenario==='recent')expect(proof.metrics).toContain('실패 2건 / 시도 10건');
      if(scenario==='missing')expect(proof.metrics).toContain('다음 조회');
      if(scenario==='legacy'){expect(proof.metrics).toContain('성공 조회 사이');expect(proof.metrics).toContain('2026-10-22T00:05:00.000Z');}
      if(scenario==='reset')expect(proof.metrics).toContain('집계 기준 변경');
      if(scenario==='invalid')expect(proof.metrics).toContain('서버 관측 집계 확인 불가');
      if(view==='health'){expect(proof.attention).toContain('격리 1건');expect(proof.attention).toContain('격리 4건');expect(proof.attention).toContain('재시도 3건');expect(proof.text).toContain('현재 대기·재시도·격리');expect(proof.text).not.toContain('임베딩: 최근 실패');}
    }finally{rmSync(dir,{recursive:true,force:true});}
  },30000);
});
