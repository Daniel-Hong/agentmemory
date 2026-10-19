import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

const source=readFileSync('src/viewer/index.html','utf8');
const stub=`<script>
window.fixtureErrors=[];window.addEventListener('error',e=>fixtureErrors.push(e.message));window.addEventListener('unhandledrejection',e=>fixtureErrors.push(String(e.reason && e.reason.stack || e.reason)));
localStorage.removeItem('agentmemory-refresh');window.requests=[];window.pauses=0;window.resumes=0;
var fixtureControl={status:'running'},fixtureJob={status:'idle'};
var fixtureSession={id:'fixture-session',project:'<script>bad<'+ '/script>',observationCount:5,summaryProgress:{status:'blocked',pendingCount:3,blockedObservations:{'obs-1':{status:'blocked',attempts:8,lastError:'PRIVATE_SECRET',diagnostics:{category:'output_truncated',field:'title'}}}},enrichmentProgress:{compress:{pendingCount:0},graph:{pendingCount:1,status:'blocked'}}};
var fixtureHealth={status:'healthy',health:{memory:{heapUsed:96000000,heapTotal:100000000,heapLimit:1000000000,rss:800000000},cpu:{percent:116.7,capacityCores:16,capacityPercent:7.29},alerts:[],notes:[]},memoryPressure:{level:'high',availableBytes:100000000},snapshotRecovery:{enabled:true,status:'queued',nextCheckAt:1700000000000,format:'partial-application-export'},functionMetrics:[{functionId:'mem::compress',totalCalls:100,successCount:10,failureCount:90,avgLatencyMs:2,avgQualityScore:0,qualitySampleCount:3,qualityEpochAt:1700000000000}],embeddingRecovery:{pendingCount:0},featureLifecycle:{enabled:false},providerReadiness:{status:'waiting',lastCheckedAt:Date.now()-600000,nextCheckAt:Date.now()-300000,errorCode:'OLLAMA_TIMEOUT'}};
window.fetch=async(url,opts)=>{var path=String(url),method=(opts||{}).method||'GET';requests.push({path:path,method:method,body:opts&&opts.body});
 var payload={};
 if(path.includes('/sessions?') && !path.includes('includeSummary=false') && !path.includes('&q='))return new Response(JSON.stringify({error:'synthetic_oversized_summary_response'}),{status:500});
 if(path.includes('/viewer/snapshot'))payload={version:'fixture',provider:'openai',health:fixtureHealth.health,report:{status:'ok',headline:'Synthetic fixture',problems:[],service:{ports:{},version:'fixture'},provider:{llm:'openai',embeddings:'none'},flags:[],functions:[],counts:{}},counts:{},flags:[],functionMetrics:fixtureHealth.functionMetrics};
 else if(path.includes('/background/control')){if(method==='POST'){if(JSON.parse(opts.body).action==='resume'){resumes++;fixtureControl={status:'resuming',transition:{stage:'storage',stageElapsedMs:20}};await new Promise(r=>setTimeout(r,80));fixtureControl={status:'running'};}else{pauses++;fixtureControl={status:'pausing',transition:{stage:'active_work',stageElapsedMs:20}};await new Promise(r=>setTimeout(r,80));}}payload={success:true,control:fixtureControl};}
 else if(path.includes('/diagnostics/codex-inspection')){if(method==='POST')fixtureJob={id:'fixture-job',status:'queued'};payload=fixtureJob;}
 else if(path.includes('/health'))payload=fixtureHealth;
 else if(path.includes('/sessions'))payload={sessions:[fixtureSession,{id:'unknown-session',observationCount:10},{id:'mixed-session',summaryProgress:{pendingCount:2,status:'waiting_provider'},enrichmentProgress:{compress:{pendingCount:1,status:'running'},graph:{pendingCount:0,status:'current'}}}]};
 else if(path.includes('/memories'))payload={memories:[]};
 else if(path.includes('/lessons'))payload={lessons:[]};
 else if(path.includes('/crystals'))payload={crystals:[]};
 else if(path.includes('/semantic'))payload={facts:[]};
 else if(path.includes('/procedural'))payload={procedures:[]};
 return new Response(JSON.stringify(payload),{status:200,headers:{'Content-Type':'application/json'}});};
window.WebSocket=class {static OPEN=1;static CONNECTING=0;constructor(){this.readyState=1;setTimeout(()=>this.onopen&&this.onopen(),0);}send(){}close(){this.readyState=3;this.onclose&&this.onclose();}};
</script>`;
const exercise=`<script>
setTimeout(async()=>{try {
 await loadSnapshot();await loadOperations();switchTab('health');await showTab('health');
 var report={errors:fixtureErrors};
 conn.state='reconnecting';renderConnection();report.httpStatus=document.getElementById('ws-status').textContent;report.httpBanner=document.getElementById('offline-banner').textContent;
 store.snapshotError=true;renderConnection();report.failedHttpStatus=document.getElementById('ws-status').textContent;
 store.snapshotError=false;conn.state='live';renderConnection();
 report.getOnly=requests.every(r=>r.method==='GET');report.sessionListsSafe=requests.filter(r=>r.path.includes('/sessions?') && !r.path.includes('&q=')).every(r=>r.path.includes('includeSummary=false'));report.initial=document.getElementById('view-health').textContent;report.initialHistoryRequests=requests.filter(r=>r.path.includes('/codex-inspection')).length;report.stageRows=document.querySelectorAll('#health-operations .operations-progress tbody tr').length;report.summaryCards=document.querySelectorAll('#health-operations .operations-summary>div').length;
 var details=document.getElementById('operations-details');details.focus();details.open=true;details.dispatchEvent(new Event('toggle'));report.detailsFocusable=details.querySelector('summary').tabIndex===0;report.noModal=!document.getElementById('modal-overlay').classList.contains('open');
 report.horizontalOverflow=document.documentElement.scrollWidth>window.innerWidth;
 var select=document.getElementById('auto-refresh-interval');select.value='60';select.dispatchEvent(new Event('change'));report.interval=autoRefresh.seconds;
 var toggle=document.getElementById('auto-refresh-toggle');toggle.checked=false;toggle.dispatchEvent(new Event('change'));report.off=!autoRefresh.enabled&&operations.refreshTimer===null&&state.ws===null;report.saved=JSON.parse(localStorage.getItem('agentmemory-refresh'));report.banner=document.getElementById('offline-banner').textContent;
 var before=requests.length;connectWs();scheduleOperationsRefresh();report.offRequests=requests.length-before;
 document.querySelector('[data-action="refresh-operations"]').click();await new Promise(r=>setTimeout(r,40));report.manualRequests=requests.length-before;
 document.querySelector('[data-action="pause-background"]').focus();document.querySelector('[data-action="pause-background"]').click();report.focusAfterPause=!!document.activeElement.closest('#health-operations');document.querySelector('[data-action="pause-background"]').click();await new Promise(r=>setTimeout(r,100));report.pauseCount=pauses;report.pausing=document.getElementById('view-health').textContent;
 fixtureControl={status:'paused'};await checkBackgroundControl();report.resume=document.querySelector('[data-action="resume-background"]').disabled===false;
 document.querySelector('[data-action="resume-background"]').focus();document.querySelector('[data-action="resume-background"]').click();report.resuming=document.getElementById('health-operations').textContent.includes('재개 중');document.querySelector('[data-action="resume-background"]').click();await new Promise(r=>setTimeout(r,100));report.resumeCount=resumes;report.resumed=operations.control.status==='running';
 fixtureControl={status:'error'};await checkBackgroundControl();report.noResume=!document.querySelector('[data-action="resume-background"]');
 report.noAnalysisActions=!document.querySelector('[data-action="submit-codex-inspection"], [data-action="copy-inspection-request"]');
 fixtureJob={id:'fixture-job',status:'completed',result:'<img src=x onerror="window.fixtureUnsafe=true">safe result'};var historyBefore=requests.filter(r=>r.path.includes('/codex-inspection')).length;document.querySelector('[data-action="refresh-codex-inspection"]').click();await new Promise(r=>setTimeout(r,40));report.historyRequests=requests.filter(r=>r.path.includes('/codex-inspection')).slice(historyBefore);report.analysisRequests=requests.filter(r=>r.path.includes('/codex-inspection')&&r.method==='POST');report.final=document.getElementById('view-health').textContent;report.executedUnsafeHtml=!!document.querySelector('#health-operations img')||!!window.fixtureUnsafe;
 await loadOperations();report.historyPreserved=document.getElementById('view-health').textContent.includes('safe result');
 report.detailsKept=document.getElementById('operations-details').open;
 document.getElementById('health-operations').scrollIntoView({block:'start'});
 document.getElementById('result').textContent=JSON.stringify(report);
}catch(e){document.getElementById('result').textContent=JSON.stringify({error:e.stack,errors:fixtureErrors});}},150);
</script>`;

describe.skipIf(spawnSync('google-chrome',['--version'],{encoding:'utf8',timeout:5000}).status !== 0)('real Chromium custom operations',()=>{
  it.each([[1280,1000],[390,844]])('works at %ix%i with manual actions and no automatic mutation', (width,height)=> {
    const dir=mkdtempSync(join(tmpdir(),'agentmemory-operations-browser-'));
    const page=source.replace('<body>','<body>'+stub).replace('</body>','<pre id="result" hidden></pre>'+exercise+'</body>');
    writeFileSync(join(dir,'test.html'),page);
    const run=spawnSync('google-chrome',['--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--no-first-run','--user-data-dir='+join(dir,'profile'),'--virtual-time-budget=1500','--window-size='+width+','+height,'--screenshot='+join(dir,'preview.png'),'--dump-dom','file://'+join(dir,'test.html')],{encoding:'utf8',timeout:25000,maxBuffer:3000000});
    expect(run.status,run.stderr.slice(-700)).toBe(0);
    const match=run.stdout.match(/<pre id="result"[^>]*>([\s\S]*?)<\/pre>/);expect(match).not.toBeNull();
    const result=JSON.parse(match![1].replaceAll('&quot;','"').replaceAll('&amp;','&').replaceAll('&lt;','<').replaceAll('&gt;','>'));
    writeFileSync(join(dir,'browser-evidence.json'),JSON.stringify({directory:dir,...result},null,2));
    expect(result.error).toBeUndefined();expect(result.errors).toEqual([]);expect(result.getOnly).toBe(true);expect(result.sessionListsSafe).toBe(true);expect(result.initialHistoryRequests).toBe(0);expect(result.stageRows).toBe(6);expect(result.summaryCards).toBe(3);
    expect(result.httpStatus).toContain('HTTP');expect(result.httpBanner).toContain('실시간 스트림 미연결');expect(result.failedHttpStatus).not.toContain('HTTP');
    expect(result.initial).toContain('활성 격리: 1건');expect(result.initial).toContain('title');expect(result.initial).toContain('부분 내보내기');expect(result.initial).toContain('품질 표본 3건');expect(result.initial).toContain('사용 가능 16코어');
    expect(result.initial).toContain('확인된 최소 7건');expect(result.initial).toContain('미확인 세션 1개 / 단계 3개');expect(result.initial).toContain('처리 중');expect(result.initial).toContain('상태 오래됨');expect(result.initial).toContain('다음 확인');
    expect(result.initial).not.toContain('PRIVATE_SECRET');expect(result.noModal).toBe(true);expect(result.detailsFocusable).toBe(true);expect(result.horizontalOverflow).toBe(false);
    expect(result.interval).toBe(60);expect(result.off).toBe(true);expect(result.saved).toEqual({enabled:false,seconds:60});expect(result.banner).toContain('OFF');expect(result.offRequests).toBe(0);expect(result.manualRequests).toBe(3);
    expect(result.pauseCount).toBe(1);expect(result.focusAfterPause).toBe(true);expect(result.pausing).toContain('일시정지 중');expect(result.resume).toBe(true);expect(result.resuming).toBe(true);expect(result.resumeCount).toBe(1);expect(result.resumed).toBe(true);expect(result.noResume).toBe(true);
    expect(result.noAnalysisActions).toBe(true);expect(result.analysisRequests).toHaveLength(0);expect(result.historyRequests).toHaveLength(1);expect(result.historyRequests[0].method).toBe('GET');expect(result.final).toContain('<img src=x');expect(result.historyPreserved).toBe(true);expect(result.executedUnsafeHtml).toBe(false);expect(result.detailsKept).toBe(true);
    console.log('Browser evidence '+dir);
  },30000);
  it('uses native Enter and Tab for the details without a focus-trapping popup',async()=> {
    const dir=mkdtempSync(join(tmpdir(),'agentmemory-operations-keyboard-'));
    writeFileSync(join(dir,'test.html'),source.replace('<body>','<body>'+stub));
    const chrome=spawn('google-chrome',['--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--no-first-run','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+join(dir,'profile'),'about:blank'],{stdio:'ignore'});
    let socket: WebSocket | undefined;
    try {
      const deadline=Date.now()+10000, portFile=join(dir,'profile','DevToolsActivePort');
      while(!existsSync(portFile) && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,25));
      expect(existsSync(portFile)).toBe(true);
      const port=readFileSync(portFile,'utf8').split('\n')[0];
      const target=await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('file://'+join(dir,'test.html'))}`,{method:'PUT'}).then(r=>r.json());
      socket=new WebSocket(target.webSocketDebuggerUrl);
      await new Promise<void>((resolve,reject)=>{socket!.onopen=()=>resolve();socket!.onerror=()=>reject(Error('CDP connection failed'));});
      let seq=0;const pending=new Map<number,{resolve:(value:any)=>void,reject:(reason:Error)=>void}>();
      socket.onmessage=event=>{const msg=JSON.parse(String(event.data));if(!msg.id)return;const waiter=pending.get(msg.id);if(!waiter)return;pending.delete(msg.id);msg.error?waiter.reject(Error(JSON.stringify(msg.error))):waiter.resolve(msg.result);};
      const send=(method:string,params:Record<string,unknown>={})=>new Promise<any>((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket!.send(JSON.stringify({id,method,params}));});
      const evaluate=async(expression:string)=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
      await send('Page.enable');
      await send('Page.bringToFront');
      while(!(await evaluate("document.readyState==='complete' && typeof loadOperations==='function'")) && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,25));
      await evaluate("(async()=>{await loadSnapshot();await loadOperations();switchTab('health');await showTab('health');setAutoRefresh(false,30);document.querySelector('#operations-details>summary').focus();})()");
      expect(await evaluate("document.activeElement===document.querySelector('#operations-details>summary')")).toBe(true);
      await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',windowsVirtualKeyCode:13});
      await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
      expect(await evaluate("document.getElementById('operations-details').open")).toBe(true);
      await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
      await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
      expect(await evaluate("document.activeElement.getAttribute('data-action')")).toBe('refresh-codex-inspection');
      const before=await evaluate("requests.length");
      await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',windowsVirtualKeyCode:13});
      await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
      expect(await evaluate("requests.length")).toBe(before+1);
      expect(await evaluate("requests.every(r=>r.method==='GET') && !document.getElementById('modal-overlay').classList.contains('open') && fixtureErrors.length===0")).toBe(true);
    } finally { socket?.close();chrome.kill('SIGTERM'); }
  },20000);
});
