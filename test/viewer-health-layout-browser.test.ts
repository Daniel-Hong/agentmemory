import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

const source = readFileSync(process.env.HEALTH_LAYOUT_SOURCE || 'src/viewer/index.html', 'utf8');
const evidence = process.env.HEALTH_LAYOUT_EVIDENCE;
const scenarios = ['normal', 'manual', 'memory', 'recovery', 'storage-error', 'unknown', 'critical'];
const stub = (scenario: string) => `<script>
window.fixtureErrors=[];addEventListener('error',e=>fixtureErrors.push(e.message));addEventListener('unhandledrejection',e=>fixtureErrors.push(String(e.reason)));
window.requests=[];localStorage.clear();
var fixtureControl={status:'${scenario === 'normal' ? 'running' : scenario === 'unknown' ? 'unknown' : scenario === 'storage-error' ? 'error' : 'paused'}',holds:${JSON.stringify(scenario === 'manual' ? ['manual','deployment','legacy_unknown'] : scenario === 'memory' || scenario === 'recovery' ? ['memory'] : scenario === 'storage-error' ? ['storage_error'] : [])},activeOperations:0};
var fixtureHealth={status:'${scenario === 'storage-error' || scenario === 'critical' ? 'critical' : 'healthy'}',health:{connectionState:'connected',memory:{heapUsed:90000000,heapLimit:1000000000,rss:300000000}},memoryPressure:{level:'${scenario === 'critical' ? 'critical' : scenario === 'memory' ? 'high' : 'normal'}',availableBytes:4000000000,recoveryStatus:'${scenario === 'recovery' ? 'attempt_limit' : scenario === 'memory' ? 'stabilizing' : 'recovered'}'},snapshotRecovery:{enabled:true,status:'current'},captureProgress:{pending:0,completedCount:10,counterEpoch:'synthetic'},embeddingRecovery:{initialized:true,pendingCount:0},featureLifecycle:{enabled:false},providerReadiness:{status:'${scenario === 'normal' ? 'ready' : 'waiting'}',lastCheckedAt:Date.now(),nextCheckAt:Date.now()+30000}};
var fixtureSession={id:'synthetic-session',project:'Synthetic fixture',observationCount:1,summaryProgress:{status:'${scenario === 'manual' ? 'blocked' : 'current'}',pendingCount:${scenario === 'manual' ? 1 : 0},blockedObservations:${scenario === 'manual' ? "{one:{status:'blocked',diagnostics:{category:'output_truncated',field:'title'}}}" : '{}'}},enrichmentProgress:{compress:{pendingCount:0,status:'current'},graph:{pendingCount:0,status:'current'}}};
window.fetch=async(url,opts={})=>{requests.push({method:opts.method||'GET',path:String(url)});var path=String(url),payload={};if(path.includes('/viewer/snapshot'))payload={version:'synthetic',provider:'openai',health:fixtureHealth.health,report:{status:'${scenario === 'storage-error' || scenario === 'critical' ? 'error' : 'ok'}',headline:'Synthetic ${scenario} health',checkedAt:new Date().toISOString(),problems:${scenario === 'storage-error' ? "[{level:'error',message:'Synthetic storage verification failed',fix:'Review storage status.'}]" : '[]'},service:{ports:{},version:'synthetic'},provider:{llm:'openai',embeddings:'none'},capture:${scenario === 'manual' ? '{inbox:{pending:0,dead:1,retrying:2},sinceStart:{},spool:[],policy:{retryIntervalMs:30000,maxAttempts:5}}' : 'null'},flags:[],functions:[],counts:{}},counts:{},flags:[]};else if(path.includes('/background/control'))payload={success:true,control:fixtureControl};else if(path.includes('/health'))payload=fixtureHealth;else if(path.includes('/sessions'))payload={sessions:[fixtureSession]};return new Response(JSON.stringify(payload),{status:200,headers:{'Content-Type':'application/json'}});};
window.WebSocket=class {static OPEN=1;static CONNECTING=0;constructor(){this.readyState=1;setTimeout(()=>this.onopen&&this.onopen(),0);}send(){}close(){this.readyState=3;}};
</script>`;
const exercise = `<script>
setTimeout(async()=>{var proof={};try{await loadSnapshot();await loadOperations();switchTab('health');await showTab('health');conn.state='live';renderHealth();
var root=document.getElementById('view-health'),technical=root.querySelector('#health-diagnostics'),attention=root.querySelector('#health-attention');
proof.first=root.firstElementChild?.id;proof.technicalCollapsed=!!technical&&!technical.open;proof.attention=attention?.innerText||'';proof.attentionVisible=!!attention&&attention.getBoundingClientRect().height>0&&!attention.closest('details:not([open])');proof.text=root.innerText;proof.actions=Array.from(root.querySelectorAll('[data-action]')).map(e=>e.getAttribute('data-action'));proof.overflow=document.documentElement.scrollWidth>innerWidth;proof.errors=fixtureErrors;proof.getOnly=requests.every(r=>r.method==='GET');
if(technical){technical.open=true;technical.dispatchEvent(new Event('toggle'));var summary=technical.querySelector('summary');summary.focus();renderHealth();proof.technicalKept=root.querySelector('#health-diagnostics').open;proof.focusKept=document.activeElement===root.querySelector('#health-diagnostics>summary');root.querySelector('#health-diagnostics').open=false;root.querySelector('#health-diagnostics').dispatchEvent(new Event('toggle'));renderHealth();proof.technicalClosedKept=!root.querySelector('#health-diagnostics').open;state.health.reveal='consolidation';renderHealth();proof.revealOpens=root.querySelector('#health-diagnostics').open;root.querySelector('#health-diagnostics').open=false;}
var op=root.querySelector('#operations-details');op.open=true;op.dispatchEvent(new Event('toggle'));op.querySelector('summary').focus();renderHealth();proof.operationsFocusKept=document.activeElement===root.querySelector('#operations-details>summary');proof.operationsKept=root.querySelector('#operations-details').open;root.querySelector('#operations-details').open=false;root.querySelector('#operations-details').dispatchEvent(new Event('toggle'));renderHealth();document.activeElement.blur();root.scrollTop=0;window.scrollTo(0,0);
}catch(e){proof.error=String(e.stack||e);}document.getElementById('health-layout-proof').textContent=JSON.stringify(proof);},150);
</script>`;

describe.skipIf(spawnSync('google-chrome', ['--version'], {encoding:'utf8'}).status !== 0)('HEALTH hierarchy with synthetic data in real Chromium', () => {
  it.each(scenarios.flatMap(scenario=>[[scenario,1280,1000],[scenario,390,844]]))('%s at %ix%i', (scenario, width, height) => {
    const dir=mkdtempSync(join(tmpdir(),'am-health-layout-'));
    try {
      const name=`${scenario}-${width}`;
      if(evidence)mkdirSync(evidence,{recursive:true});
      const page=source.replace('<body>','<body>'+stub(String(scenario))).replace('</body>','<pre id="health-layout-proof" hidden></pre>'+exercise+'</body>');
      const path=join(dir,'fixture.html');writeFileSync(path,page);
      const screenshot=evidence?join(resolve(evidence),name+'.png'):join(dir,'preview.png');
      const run=spawnSync('google-chrome',['--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--no-first-run','--user-data-dir='+join(dir,'profile'),'--window-size='+width+','+height,'--virtual-time-budget=1200','--screenshot='+screenshot,'--dump-dom','file://'+path],{encoding:'utf8',timeout:25000,maxBuffer:3000000});
      expect(run.status,run.stderr.slice(-500)).toBe(0);
      const match=run.stdout.match(/<pre id="health-layout-proof"[^>]*>([\s\S]*?)<\/pre>/);expect(match).toBeTruthy();
      const proof=JSON.parse(match![1].replaceAll('&quot;','"').replaceAll('&amp;','&').replaceAll('&lt;','<').replaceAll('&gt;','>'));
      if(evidence)writeFileSync(join(evidence,name+'.json'),JSON.stringify(proof,null,2));
      expect(proof.error).toBeUndefined();expect(proof.errors).toEqual([]);expect(proof.getOnly).toBe(true);expect(proof.first).toBe('health-overview');expect(proof.technicalCollapsed).toBe(true);expect(proof.attentionVisible).toBe(true);expect(proof.overflow).toBe(false);
      expect(proof.revealOpens).toBe(true);expect(proof.technicalKept).toBe(true);expect(proof.technicalClosedKept).toBe(true);expect(proof.focusKept).toBe(true);expect(proof.operationsKept).toBe(true);expect(proof.operationsFocusKept).toBe(true);
      expect(proof.actions.filter((x:string)=>x==='refresh-health')).toHaveLength(1);expect(proof.actions.filter((x:string)=>x==='refresh-operations')).toHaveLength(1);expect(proof.actions.filter((x:string)=>x==='capture-review-open')).toHaveLength(1);
      if(scenario==='manual'){expect(proof.attention).toContain('수동 중지');expect(proof.attention).toContain('배포 중지');expect(proof.attention).toContain('원인 미상');expect(proof.attention).toContain('격리');expect(proof.attention).toContain('공급자');expect(proof.attention).toContain('수집 저장 전 실패');}
      if(scenario==='unknown'){expect(proof.attention).toContain('실행 상태 미확인');expect(proof.actions).not.toContain('resume-background');}
      if(scenario==='critical'){expect(proof.text).not.toContain('No problems found');expect(proof.text).toContain('상태 보고서의 세부 진단을 확인하세요');expect(proof.attention).toContain('서버 점검 필요');expect(proof.attention).toContain('메모리 위험');}
      if(scenario==='memory'){expect(proof.attention).toContain('백그라운드 보류');expect(proof.attention).toContain('안정 확인 중');}
      if(scenario==='recovery')expect(proof.attention).toContain('자동 회복 횟수 제한');
      if(scenario==='storage-error'){expect(proof.attention).toContain('저장');expect(proof.attention).toContain('재개할 수 없습니다');expect(proof.text).toContain('Synthetic storage verification failed');expect(proof.actions).not.toContain('resume-background');}
    } finally { rmSync(dir,{recursive:true,force:true}); }
  },30000);
});
