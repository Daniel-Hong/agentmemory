import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const viewer = readFileSync("src/viewer/index.html", "utf8");
function source(name: string) {
  let start = viewer.indexOf(`function ${name}(`);
  if (start < 0) throw Error(`Missing ${name}`);
  if (viewer.slice(start-6,start)==='async ') start-=6;
  let depth = 0;
  for (let i = viewer.indexOf("{", start); i < viewer.length; i++) {
    if (viewer[i] === "{") depth++;
    if (viewer[i] === "}" && --depth === 0) return viewer.slice(start, i + 1);
  }
  throw Error(`Unbalanced ${name}`);
}
function context(names: string[], extra: Record<string, unknown> = {}) {
  const ctx: Record<string, any> = { Number, Date, console, setTimeout, clearTimeout, AbortController, ...extra };
  runInNewContext(names.map(source).join("\n"), ctx);
  return ctx;
}
function fixtures(extra: Record<string, unknown> = {}) {
  return context(["esc", "fmtNum", "humanizeHealthFlag", "quarantineReason", "quarantineRecords", "backgroundWorkSnapshot", "memoryPressureStatus", "snapshotStatus", "storageDurabilityHtml", "inspectionErrorText", "inspectionRequest", "readinessStatusHtml", "controlDiagnosticHtml", "operationsStages", "recordOperationsProgress", "stageProgress", "progressDuration", "operationsProgressHtml", "operationsPanelHtml"], {
    operations: { health: {}, sessions: [], control: null, job: null, available: false, loading: false, error: '', controlError: '', jobError: '', checking: false, submitting: false, controlBusy: false, detailsOpen: false },
    store: {}, conn: { state: 'offline' }, autoRefresh: { enabled: true, seconds: 30 }, ...extra,
  });
}

describe("custom operations panel", () => {
  it("lets stage progress collapse independently and retains its open state in rendering", () => {
    const c=fixtures();c.operations.progressOpen=false;
    expect(c.operationsPanelHtml()).toContain('<details id="operations-progress-details"><summary>단계별 처리 현황 · 최근 완료 표본 기준</summary>');
    c.operations.progressOpen=true;expect(c.operationsPanelHtml()).toContain('<details id="operations-progress-details" open>');
  });
  it("omits the retired analysis-history control when there are no results", () => {
    const html = fixtures().operationsPanelHtml();
    expect(html).not.toContain('과거 분석 기록 보기');
    expect(html).not.toContain('refresh-codex-inspection');
    expect(html).toContain('수집 격리·복구 이력 보기');
  });
  it("renders unavailable data explicitly without declaring an empty queue", () => {
    const c = fixtures(); const html = c.operationsPanelHtml();
    expect(html).toContain('미확인');
    expect(html).toContain('조회 실패');
    expect(html).not.toContain('조회 가능한 대기 작업 없음');
    expect(html).toContain('disabled');
    expect(html).not.toContain('<textarea');
  });
  it("shows persistent pause transition and safe quarantine details", () => {
    const c = fixtures(); c.operations.available = true;
    c.operations.control = { status: 'pausing' };
    c.operations.sessions = [{ id: '<img src=x>', project: '<script>x</script>', summaryProgress: { pendingCount: 1, status: 'blocked', blockedObservations: { '<b>x</b>': { status: 'blocked', diagnostics: { category: 'input_invalid', field: 'title' }, attempts: 3 } } } }];
    const html = c.operationsPanelHtml();
    expect(html).toContain('일시정지 중'); expect(html).toContain('입력 메타데이터 형식·크기 오류');
    expect(html).toContain('title'); expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>x'); expect(html).toContain('단계별 처리 현황');
    expect(html).toContain('<summary'); expect(html).toContain('role="status"');
  });
  it("does not count finished sessions or missing stage fields as completed work", () => {
    const c = fixtures();
    expect(c.backgroundWorkSnapshot([{ id:'x', status:'completed', observationCount:10 }], {}, true).totals.summary).toBeNull();
    expect(c.backgroundWorkSnapshot([], {}, false).totals.graph).toBeNull();
  });
  it("shows the confirmed minimum and the unknown session/stage scope separately",()=> {
    const c=fixtures();c.operations.available=true;
    c.operations.sessions=[{id:'known',summaryProgress:{pendingCount:3,status:'running'},enrichmentProgress:{compress:{pendingCount:4,status:'waiting_provider'},graph:{pendingCount:5,status:'queued'}}},{id:'unknown',observationCount:10}];
    c.operations.health={embeddingRecovery:{pendingCount:2},featureLifecycle:{enabled:true,pendingCount:1}};
    const work=c.backgroundWorkSnapshot(c.operations.sessions,c.operations.health,true);
    expect(work.knownTotals).toMatchObject({summary:3,compress:4,graph:5,embedding:2,features:1});
    expect(work.unknownSessionsCount).toBe(1);expect(work.unknownStageCounts).toMatchObject({summary:1,compress:1,graph:1});
    const html=c.operationsPanelHtml();expect(html).toContain('최소 15건');expect(html).toContain('미확인 세션 1개 / 단계 3개');expect(html).not.toContain('남은 처리 단계: 0건');
  });
  it("prefers observed running work over provider waiting and never infers missing status",()=> {
    const c=fixtures();const rows=c.backgroundWorkSnapshot([{id:'mixed',summaryProgress:{status:'waiting_provider',pendingCount:2},enrichmentProgress:{compress:{status:'running',pendingCount:1},graph:{status:'queued',pendingCount:1}}},{id:'unknown',summaryProgress:{pendingCount:2}}],{},true).rows;
    expect(rows[0].status).toBe('처리 중');expect(rows[1].status).toBe('미확인');
    expect(c.backgroundWorkSnapshot([{id:'finishing',summaryProgress:{status:'running',pendingCount:0},enrichmentProgress:{compress:{status:'current',pendingCount:0},graph:{status:'current',pendingCount:0}}}],{},true).rows[0]?.status).toBe('처리 중');
  });
  it.each([['pause','일시정지 요청 중'],['resume','재개 중']])("shows %s action while the previous persistent state is still unchanged",(action,label)=> {
    const c=fixtures();c.operations.control={status:action==='resume'?'paused':'running',transition:{action:action==='resume'?'pause':'resume',stage:'complete'}};c.operations.controlBusy=true;c.operations.controlAction=action;
    const html=c.operationsPanelHtml();expect(html).toContain(label);expect(html).not.toContain('저장 확인 완료');
  });
  it("marks stale readiness cache without describing the past failure as a current outage",()=> {
    const c=fixtures();const html=c.readinessStatusHtml({status:'waiting',lastCheckedAt:Date.now()-600000,nextCheckAt:Date.now()-300000,checks:2,errorCode:'OLLAMA_TIMEOUT'});
    expect(html).toContain('상태 오래됨');expect(html).toContain('마지막 확인');expect(html).toContain('다음 확인');expect(html).toContain('추론 미검증');
    expect(c.readinessStatusHtml({status:'ready',lastCheckedAt:Date.now(),nextCheckAt:Date.now()+15000})).toContain('메타데이터 준비됨');
  });
  it("shows bounded control stages and error codes without raw diagnostics",()=> {
    const c=fixtures();const html=c.controlDiagnosticHtml({status:'error',transition:{stage:'storage',stageElapsedMs:2500},diagnostics:{errorCode:'STATE_DURABILITY_TIMEOUT',causeCode:'PRIVATE SECRET',raw:'PRIVATE SECRET'}});
    expect(html).toContain('디스크 저장 확인');expect(html).toContain('2초');expect(html).toContain('STATE_DURABILITY_TIMEOUT');expect(html).not.toContain('PRIVATE SECRET');
  });
  it("labels snapshot export limits, future scheduling and high memory without promising a backup", () => {
    const c = fixtures();
    expect(c.snapshotStatus({ enabled:true, status:'queued', nextCheckAt:1700000000000 })).toContain('부분 내보내기');
    expect(c.snapshotStatus({ enabled:true, status:'queued', nextCheckAt:1700000000000 })).toContain('다음 점검');
    expect(c.snapshotStatus({ enabled:true, status:'retrying', nextAttemptAt:1700000000000 })).toContain('다음 재시도');
    expect(c.memoryPressureStatus({ level:'high', availableBytes:123456 })).toContain('백그라운드 보류');
    expect(c.memoryPressureStatus(null)).toContain('미확인');
  });
  it("shows preserved analysis safely without offering analysis execution or copying", () => {
    const c = fixtures(); c.operations.job = { status:'completed', result:'<script>result</script>' };
    const html = c.operationsPanelHtml();
    expect(html).toContain('&lt;script&gt;result'); expect(html).not.toContain('<script>result');
    expect(html).not.toContain('copy-inspection-request'); expect(html).not.toContain('submit-codex-inspection');
    expect(html).not.toContain('refresh-codex-inspection');
    expect(html).not.toContain('과거 분석 기록 보기');
    expect(c.inspectionErrorText('Bearer secret')).not.toContain('secret');
  });
  it("disables commands after their last status read failed", () => {
    const c=fixtures();c.operations.control={status:'paused'};c.operations.controlError='조회 실패';
    c.operations.job={status:'idle'};c.operations.jobError='조회 실패';
    const html=c.operationsPanelHtml();
    expect(html).toMatch(/data-action="resume-background" disabled/);
    expect(html).not.toContain('submit-codex-inspection'); expect(html).toContain('과거 기록을 조회하지 못했습니다.');
  });
});

describe("operational metadata", () => {
  it("compares only matching monotonic counters, leaving old failures historical", () => {
    const c = context(['metricRecentObservation']);
    expect(c.metricRecentObservation({totalCalls:110,failureCount:90},{totalCalls:100,failureCount:90,observedAt:1000},2000).text).toContain('실패 +0');
    expect(c.metricRecentObservation({totalCalls:1,failureCount:1},{totalCalls:100,failureCount:90}).text).toContain('집계 기준 변경');
    expect(c.metricRecentObservation({totalCalls:2,failureCount:1},null).text).toContain('다음 조회');
  });
  it("shows missing quality samples and CPU capacity as unknown", () => {
    const c = context(['metricQuality','cpuDisplay']);
    expect(c.metricQuality({avgQualityScore:0})).toMatchObject({value:'-'});
    expect(c.metricQuality({avgQualityScore:0,qualitySampleCount:2,qualityEpochAt:1000}).detail).toContain('표본 2');
    expect(c.cpuDisplay({percent:200,capacityCores:8,capacityPercent:25})).toMatchObject({percent:25,label:'CPU (전체)'});
    expect(c.cpuDisplay({capacityPercent:25})).toMatchObject({percent:null,label:'CPU (1코어)'});
  });
  it("includes new failures and quality periods in the existing functions card", () => {
    const c = context(['esc','metricRecentObservation','metricQuality','functionsCardHtml'], {store:{functionMetrics:[]},operations:{health:{functionMetrics:[{functionId:'mem::summary',totalCalls:100,failureCount:90,qualitySampleCount:2,avgQualityScore:0,qualityEpochAt:1000}]},metrics:{'mem::summary':{totalCalls:100,failureCount:90,observedAt:2000}},metricPrevious:{'mem::summary':{totalCalls:90,failureCount:90,observedAt:1000}}},help:()=>'',fmtNum:String,emptyState:()=>'',curlPost:()=>''});
    const html=c.functionsCardHtml(null);
    expect(html).toContain('실패 +0'); expect(html).toContain('품질 표본 2'); expect(html).toContain('0.00');
    expect(html).toContain('누적');
  });
});

describe("manual operations commands", () => {
  it("refreshes only current metadata and preserves previously loaded analysis", async () => {
    const apiGet = vi.fn(async (path: string) => path === 'health' ? {} : path.startsWith('sessions?') ? {sessions:[]} : {success:true,control:{status:'running'}});
    const job={id:'past-job',status:'completed',result:'preserved result'};
    const c=fixtures({apiGet,renderOperations:vi.fn(),operations:{health:{},sessions:[],control:null,job,available:false,generation:0,progressSamples:{}}});
    runInNewContext(source('loadOperations'),c);
    await c.loadOperations();
    expect(apiGet.mock.calls.map(call=>call[0])).toEqual(['health','sessions?includeSummary=false','background/control']);
    expect(c.operations.job).toEqual(job);
    expect(viewer).not.toMatch(/action === ['"](?:submit-codex-inspection|copy-inspection-request)['"]/);
  });
  it("does not repeat a pause click while its request is outstanding and reads back uncertain outcome", async () => {
    let finish: (value: any) => void = () => {};
    const api = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const readback = vi.fn();
    const c = context(['changeBackgroundControl'], { operations:{controlBusy:false,control:{status:'running'},health:{}}, api, renderOperations:vi.fn(), checkBackgroundControl:readback });
    const first = c.changeBackgroundControl('pause'); await c.changeBackgroundControl('pause');
    expect(api).toHaveBeenCalledTimes(1); expect(c.operations.controlBusy).toBe(true);
    expect(c.operations.controlAction).toBe('pause');
    finish(null); await first;
    expect(readback).toHaveBeenCalled(); expect(c.operations.controlError).toContain('미확정');
    expect(c.operations.controlBusy).toBe(false);
  });
  it("keeps the POST failure reason after a successful state read",async()=> {
    const c=context(['changeBackgroundControl','checkBackgroundControl'],{operations:{controlBusy:false,control:{status:'paused'},health:{}},api:async()=>({success:false,error:'memory_pressure'}),apiGet:async()=>({success:true,control:{status:'paused'}}),renderOperations:()=>{}});
    await c.changeBackgroundControl('resume');await c.checkBackgroundControl();
    expect(c.operations.controlRequestError).toContain('메모리 보호');
  });
  it("reuses an inspection requestId after an uncertain response and never sends session data", async () => {
    const api = vi.fn().mockResolvedValue(null);
    const c = context(['submitCodexInspection'], { operations:{submitting:false,job:{status:'idle'},requestId:null}, api, newInspectionRequestId:()=> 'uuid', renderOperations:vi.fn(), checkCodexInspection:vi.fn(), inspectionErrorText:()=> '미확정' });
    await c.submitCodexInspection(); await c.submitCodexInspection();
    expect(api).toHaveBeenCalledTimes(2);
    const opts = api.mock.calls[0][1];
    expect(JSON.parse(opts.body)).toEqual({requestId:'uuid'});
    expect(opts.headers['X-AgentMemory-Inspection']).toBe('1');
    expect(c.operations.requestId).toBe('uuid');
  });
  it("keeps a rejected inspection request visible when the job status read succeeds",async()=> {
    const c=context(['submitCodexInspection','checkCodexInspection','inspectionErrorText'], {operations:{submitting:false,checking:false,job:{status:'idle'},requestId:null},api:async()=>({error:'inspection_cooldown'}),apiGet:async()=>({status:'idle'}),newInspectionRequestId:()=> 'uuid',renderOperations:()=>{}});
    await c.submitCodexInspection();await c.checkCodexInspection();
    expect(c.operations.submitError).toContain('30초');
  });
  it("stops live and metadata timers when refresh is disabled and persists the selection", () => {
    const close = vi.fn(); const storage = {setItem:vi.fn()};
    const c = context(['setAutoRefresh'], {autoRefresh:{enabled:true,seconds:30}, operations:{refreshTimer:7}, state:{ws:{close}}, wsReconnectTimer:8,pendingLiveRender:9,clearTimeout:vi.fn(),localStorage:storage,updateRefreshControls:vi.fn(),setConnection:vi.fn(),connectWs:vi.fn(),scheduleOperationsRefresh:vi.fn(),renderOperations:vi.fn()});
    c.setAutoRefresh(false,60);
    expect(close).toHaveBeenCalledOnce(); expect(c.state.ws).toBeNull();
    expect(storage.setItem).toHaveBeenCalledWith('agentmemory-refresh',JSON.stringify({enabled:false,seconds:60}));
    expect(c.connectWs).not.toHaveBeenCalled();
  });
  it("bounds read API body parsing and distinguishes consolidation request failure", async () => {
    const c = context(['runConsolidation'], {state:{health:{consolidating:false,error:null},activeTab:'health'},markDirty:()=>{},renderTab:()=>{},apiPost:async()=> null});
    await c.runConsolidation(); expect(c.state.health.error).toContain('확인');
    const api = source('api'); expect(api).toContain('controller.abort()'); expect(api.indexOf('finally')).toBeGreaterThan(api.indexOf('await res.json()'));
  });
});

describe('HTTP snapshot fallback when the stream is unavailable', () => {
  function connection(extra: Record<string, unknown> = {}) {
    const elements = new Map<string, any>();
    const c = context(['esc', 'hasFreshHttpSnapshot', 'setWsStatus', 'renderConnection', 'healthStaleHtml'], {
      store: {snapshotAt: Date.now(), snapshotError: false, lastHealthAt: Date.now()},
      conn: {state:'reconnecting',nextRetryAt:0,lostAt:0},
      autoRefresh: {enabled:true,seconds:30}, HEALTH_STALE_MS:90000,
      document: {body:{classList:{toggle:vi.fn()}},getElementById:(id:string)=>{
        if(!elements.has(id)) elements.set(id,{textContent:'',innerHTML:'',hidden:false});
        return elements.get(id);
      }}, GLOSSARY:{live:{text:'stream'}}, cmdBlock:()=>'', ...extra,
    });
    return {c,elements};
  }
  it('shows successful HTTP sync without claiming a live stream or an unreachable service',()=>{
    const {c,elements}=connection();c.renderConnection();
    expect(elements.get('ws-status').textContent).toContain('HTTP');
    expect(elements.get('offline-banner').innerHTML).toContain('실시간 스트림 미연결');
    expect(elements.get('offline-banner').innerHTML).not.toContain('unreachable');
    expect(c.healthStaleHtml({})).not.toContain('Offline:');
  });
  it.each([{snapshotAt:Date.now()-120000,snapshotError:false},{snapshotAt:Date.now(),snapshotError:true},{snapshotAt:0,snapshotError:false}])('never presents stale or failed HTTP queries as fresh (%j)',store=>{
    const {c,elements}=connection({store});c.renderConnection();
    expect(elements.get('ws-status').textContent).not.toContain('HTTP');
  });
  it('keeps automatic refresh OFF and real streaming distinct from fallback',()=>{
    const {c,elements}=connection();c.autoRefresh.enabled=false;c.renderConnection();
    expect(elements.get('ws-status').textContent).toContain('OFF');
    c.autoRefresh.enabled=true;c.conn.state='live';c.renderConnection();
    expect(elements.get('ws-status').textContent).toBe('live');
  });
  it('refreshes the snapshot on the existing timer when the stream is unavailable',async()=>{
    let tick:()=>Promise<void> = async()=>{};
    const loadSnapshot=vi.fn().mockResolvedValue(true),loadOperations=vi.fn();
    const c=context(['scheduleOperationsRefresh'],{operations:{refreshTimer:null},autoRefresh:{enabled:true,seconds:30},document:{hidden:false},state:{activeTab:'dashboard'},conn:{state:'reconnecting'},loadSnapshot,loadOperations,clearTimeout:vi.fn(),setTimeout:(fn:()=>Promise<void>)=>{tick=fn;return 1;}});
    c.scheduleOperationsRefresh();await tick();expect(loadSnapshot).toHaveBeenCalledOnce();expect(loadOperations).toHaveBeenCalledOnce();
    c.conn.state='live';await tick();expect(loadSnapshot).toHaveBeenCalledOnce();
  });
});

it('invalidates the HTTP badge, footer and health view together when a snapshot query fails',async()=> {
  const updateFooter=vi.fn(),renderTab=vi.fn();
  const c=context(['loadSnapshot'],{apiGet:async()=>null,store:{snapshotAt:Date.now()},state:{activeTab:'health'},renderConnection:vi.fn(),updateFooter,markDirty:vi.fn(),renderTab});
  expect(await c.loadSnapshot()).toBe(false);expect(c.store.snapshotError).toBe(true);expect(updateFooter).toHaveBeenCalledOnce();expect(renderTab).toHaveBeenCalledWith('health');
});

it('shows memory protection hold separately from current normal pressure and manual recovery constraints',()=>{
 const c=fixtures();c.operations.control={status:'paused',holds:['memory','manual'],recovery:{attempts:3,maxAttempts:3}};c.operations.health={memoryPressure:{level:'normal',recoveryStatus:'attempt_limit'}};
 const html=c.operationsPanelHtml();expect(html).toContain('메모리 보호');expect(html).toContain('수동 중지');expect(html).toContain('자동 회복 횟수 제한');expect(html).toContain('메모리 보호는 안정 확인 후 자동 회복');expect(html).not.toContain('재개는 직접 눌러야 합니다');
 c.operations.control.holds=['PRIVATE_RAW'];expect(c.operationsPanelHtml()).not.toContain('PRIVATE_RAW');
});
it('does not imply another hold exists when a cancelled memory recovery remains held',()=>{
 const c=fixtures();c.operations.control={status:'paused',holds:['memory']};c.operations.health={memoryPressure:{level:'high',recoveryStatus:'held'}};const html=c.operationsPanelHtml();expect(html).toContain('보호 중지 유지 · 재개 조건 확인 필요');expect(html).not.toContain('다른 중지 원인 확인 필요');
});
it('shows recovery-disabled build explicitly without promising automatic recovery',()=>{
 const c=fixtures();c.operations.control={status:'paused',holds:['memory']};c.operations.health={memoryPressure:{level:'normal',recoveryStatus:'disabled',automaticMemoryRecovery:false}};
 const html=c.operationsPanelHtml();expect(html).toContain('호환 복구 빌드 · 자동 회복 비활성');expect(html).not.toContain('메모리 보호는 안정 확인 후 자동 회복합니다');
});


describe("honest observed function metrics", () => {
  const recent = {windowMs:60000,windowStartAt:'2026-10-22T00:01:00.000Z',windowEndAt:'2026-10-22T00:02:00.000Z',observedSince:'2026-10-22T00:00:00.000Z',attemptCount:10,failureCount:2};
  it("prefers the timestamped observed attempt window over browser-poll differences", () => {
    const c=context(['metricRecentObservation']);
    const text=c.metricRecentObservation({totalCalls:200,failureCount:190,recent},{totalCalls:199,failureCount:190,observedAt:'2026-10-22T00:01:30.000Z'},'2026-10-22T00:02:01.000Z').text;
    expect(text).toContain('실패 2건 / 시도 10건');expect(text).toContain(recent.windowStartAt);expect(text).toContain(recent.windowEndAt);expect(text).toContain('관측 시작 '+recent.observedSince);
  });
  it("gives legacy counter differences their actual successful observation timestamps", () => {
    const c=context(['metricRecentObservation']);
    const text=c.metricRecentObservation({totalCalls:200,failureCount:190},{totalCalls:195,failureCount:190,observedAt:'2026-10-22T00:01:00.000Z'},'2026-10-22T00:05:00.000Z').text;
    expect(text).toContain('실패 +0건 / 시도 +5건');expect(text).toContain('2026-10-22T00:01:00.000Z');expect(text).toContain('2026-10-22T00:05:00.000Z');expect(text).toContain('성공 조회 사이');
  });
  it("marks missing comparison timestamps unknown without inventing a recent zero", () => {
    const c=context(['metricRecentObservation']);
    expect(c.metricRecentObservation({totalCalls:200,failureCount:190},{totalCalls:195,failureCount:190}).text).toContain('관측 시각 미확인');
  });
  it("keeps a zero-length initial observation explicit rather than inventing a longer window", () => {
    const c=context(['metricRecentObservation']);
    const value=c.metricRecentObservation({recent:{...recent,windowMs:0,windowStartAt:recent.observedSince,windowEndAt:recent.observedSince,attemptCount:0,failureCount:0}},null);
    expect(value.failures).toBe(0);expect(value.text).toContain('관측 시작 직후');expect(value.text).toContain('시도 0건');
  });
  it.each([{failureCount:11},{windowMs:1},{observedSince:'2026-10-22T00:03:00.000Z'},{attemptCount:-1},{windowEndAt:'invalid'}])("does not trust invalid recent coverage or counts: %j", change => {
    const c=context(['metricRecentObservation']);
    const value=c.metricRecentObservation({recent:{...recent,...change}},null);
    expect(value.failures).toBeNull();expect(value.text).toContain('서버 관측 집계 확인 불가');
  });
  it("does not color persistent historical failures or failure rate as current errors", () => {
    const c=context(['esc','metricRecentObservation','metricQuality','functionsCardHtml'],{store:{functionMetrics:[]},operations:{health:{functionMetrics:[{functionId:'mem::summary',totalCalls:200,failureCount:190,recent}]},metrics:{'mem::summary':{totalCalls:200,failureCount:190,observedAt:recent.windowEndAt}},metricPrevious:{'mem::summary':{totalCalls:195,failureCount:189,observedAt:recent.windowStartAt}}},help:()=>'',fmtNum:String,emptyState:()=>'',curlPost:()=>''});
    const html=c.functionsCardHtml(null);expect(html).toContain('집계 시작 미확인');expect(html).toContain('실행 시도');expect(html).toContain('190');expect(html).toContain('95%');expect(html).not.toContain('color:var(--red)">95%');expect(html).not.toContain('since the worker started');
  });
});

describe('storage verification process totals versus retained samples', () => {
  it('keeps process totals larger than the eight retained samples and labels bounds separately', () => {
    const c=fixtures();c.operations.health.storageDurability={measurements:{historyLimit:8,evicted:17,unavailable:2,recent:Array.from({length:8},()=>({outcome:'verified'})),totals:{sinceAt:Date.parse('2026-10-22T00:00:00Z'),counterEpoch:'synthetic-not-for-display',completed:25,verified:20,failed:4,unknown:1,saturated:false}}};
    const html=c.operationsPanelHtml();expect(html).toContain('2026-10-22T00:00:00.000Z');expect(html).toContain('완료 25건');expect(html).toContain('검증 확인 20건');expect(html).toContain('실패 4건');expect(html).toContain('결과 미상 1건');expect(html).toContain('최근 표본 8 / 8건');expect(html).toContain('축출 17건');expect(html).toContain('측정 불가 2건');expect(html).toContain('고유 작업 수나 최초 시도 횟수가 아닙니다');expect(html).not.toContain('synthetic-not-for-display');
    c.operations.health.storageDurability.measurements.totals.saturated=true;expect(c.operationsPanelHtml()).toContain('카운터 포화 · 표시 건수는 하한');
  });
  it('leaves absent legacy totals and unavailable sample metadata unknown instead of zero', () => {
    const c=fixtures();c.operations.health.storageDurability={measurements:{historyLimit:8,recent:[]}};
    const html=c.operationsPanelHtml();expect(html).toContain('프로세스 집계 미확인');expect(html).toContain('집계 시작 미확인');expect(html).toContain('측정 불가 미확인');expect(html).not.toContain('완료 0건');expect(html).not.toContain('실패 0건');
    c.operations.health.storageDurability={};expect(c.operationsPanelHtml()).toContain('최근 표본 미확인');
  });
});
