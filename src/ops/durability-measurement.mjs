import {createHmac,randomBytes} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {readerEvidence} from './read-progress.mjs';

const HISTORY_LIMIT=8,NAMESPACE_LIMIT=8,FAILURE_LIMIT=32,FAILURE_TTL_MS=15*60*1000,EVENT_LIMIT=32;
const EVENTS=new Set(['capture_finished','revision_recapture','read_requested','read_queued','read_joined','read_started','read_opened','read_completed','read_failed','read_aborted','unchanged_mismatch_skip','mismatch','signature_changed','deadline']);
const safe=(work,fallback)=>{try{return work();}catch{return fallback;}};
const number=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?Math.min(value,Number.MAX_SAFE_INTEGER):null;
const REASONS=new Map(Object.entries({
  state_namespace_changed:'namespace_changed',state_namespace_not_committed:'not_committed',
  STATE_READBACK_TIMEOUT:'readback_timeout',STATE_CAPTURE_TIMEOUT:'capture_timeout',
  STATE_DURABILITY_TIMEOUT:'deadline',state_namespace_corrupt:'invalid_namespace',
  state_namespace_incomplete:'invalid_namespace',state_namespace_utf8:'invalid_namespace',
  state_namespace_duplicate:'invalid_namespace',state_namespace_shape:'invalid_namespace',
  ENOENT:'missing_namespace',EIO:'io_error',ENOSPC:'io_error',EACCES:'io_error',EPERM:'io_error',
  STATE_CAPTURE_FAILED:'capture_error',STATE_SYNC_FAILED:'io_error',
}));
const reason=code=>REASONS.get(code)??'other';
const captureReason=code=>code==='STATE_DURABILITY_TIMEOUT'||code==='STATE_CAPTURE_TIMEOUT'?'capture_timeout':'capture_error';
const KINDS=new Map(Object.entries({'mem:summaries':'summaries','mem:sessions':'sessions','mem:audit':'audit',
  'mem:embedding-retry:v1':'embedding_retry','mem:embedding-committed:v1':'embedding_committed','mem:memories':'memories'}));
function kind(scope){
  if(scope.startsWith('mem:obs:'))return 'observations';
  if(scope.startsWith('mem:graph:'))return 'graph';
  if(scope.startsWith('mem:index:'))return 'index';
  if(scope.startsWith('mem:audit:'))return 'audit';
  return KINDS.get(scope)??'other';
}

export function createDurabilityMeasurements({clock=()=>performance.now(),wallClock=()=>Date.now()}={}){
  const salt=safe(()=>randomBytes(32),null);
  let recent=[],sequence=0,evicted=0,unavailable=0,failures=[],failureEvicted=0,failureExpired=0,failureClockUnavailable=false;
  const firstReadbackFailures=[];let omittedReadbackFailures=0;
  const totals={sinceAt:safe(()=>wallClock(),null),counterEpoch:safe(()=>randomBytes(16).toString('hex'),null),
    completed:0,verified:0,failed:0,unknown:0,failedStages:{},failureReasons:{},saturated:false};
  function increment(object,key){
    const old=object[key]??0;
    if(old>=Number.MAX_SAFE_INTEGER){totals.saturated=true;return;}
    object[key]=old+1;
  }
  function complete(outcome,stage,code){safe(()=>{
    increment(totals,'completed');
    increment(totals,outcome==='verified'?'verified':outcome==='failed'?'failed':'unknown');
    if(outcome==='failed'){
      const safeStage=['capture','readback','fsync','verify','cleanup','retryWait'].includes(stage)?stage:'other';
      increment(totals.failedStages,safeStage);
      increment(totals.failureReasons,stage==='capture'?captureReason(code):reason(code));
    }
  });}
  function pruneFailures(){safe(()=>{
    const now=safe(()=>number(wallClock()),null);if(now===null){failureClockUnavailable=true;return;}
    const kept=failures.filter(sample=>now-sample.completedAt<FAILURE_TTL_MS);
    failureExpired+=failures.length-kept.length;failures=kept;
  },null);}
  function begin(scopes,keyCount,{budgetMs,startedAt}={}){const measurement=safe(()=>{
    if(!salt)return null;
    const began=clock();
    if(number(began)===null)return null;
    let mark=began,phase='capture',closed=false,valid=true,checkAttempts=0,retryCount=0,failedStage=null,lastFailureReason=null;
    const phases={captureMs:0,readbackMs:0,fsyncMs:0,verifyMs:0,cleanupMs:0,retryWaitMs:0};
    const retryReasons={},namespaces=new Map();
    let namespaceCount=0,scans=0,scanBytes=0,unchangedMismatchSkips=0,sharedReads=0;
    for(const scope of scopes){
      namespaceCount++;
      if(namespaces.size<NAMESPACE_LIMIT)namespaces.set(scope,{
        kind:kind(scope),token:createHmac('sha256',salt).update(scope).digest('hex').slice(0,16),
        fileBytes:null,scanBytes:0,scans:0,completeScans:0,
      });
    }
    const id=++sequence;
    const certificateRef=/^[0-9a-f]{32}$/.test(totals.counterEpoch??'')?totals.counterEpoch+':'+id:null;
    const timeline=[];let omittedEvents=0,lastReader;
    function observe(work){if(!closed&&valid)try{work();}catch{valid=false;}}
    function advance(next){
      const now=clock();
      if(number(now)===null)throw Error('measurement_clock_unavailable');
      phases[phase+'Ms']+=Math.max(0,now-mark);mark=now;phase=next;
    }
    return {
      certificateRef,
      readbackEvidence:()=>safe(()=>lastReader?structuredClone(lastReader):undefined,undefined),
      event(eventPhase,scope,info={}){observe(()=>{
        if(!EVENTS.has(eventPhase))return;
        const now=number(clock());if(now===null)throw Error('measurement_clock_unavailable');
        const entry={phase:eventPhase,atMs:Math.max(0,now-began)};
        const reader=readerEvidence(info);if(reader){Object.assign(entry,reader);lastReader=reader;}else if(eventPhase==='read_queued')lastReader={readerPhase:'queued',readerTimings:{}};
        const namespace=namespaces.get(scope);if(namespace)entry.namespaceToken=namespace.token;
        for(const key of ['readId','bytesRead','fileBytes','ageMs','capturedKeyCount']){const value=number(info[key]);if(value!==null&&(key!=='readId'||Number.isSafeInteger(value)))entry[key]=value;}
        for(const key of ['shared','started','complete','valueChanged','generationChanged'])if(typeof info[key]==='boolean')entry[key]=info[key];
        if(['missing','retry_generation','value'].includes(info.mismatch))entry.mismatch=info.mismatch;
        if(['capture','readback','fsync','verify'].includes(info.stage))entry.stage=info.stage;
        if(timeline.length<EVENT_LIMIT)timeline.push(entry);else{timeline[EVENT_LIMIT-1]=entry;omittedEvents++;}
      });},
      enter(next){observe(()=>advance(next));},
      skipUnchangedMismatch(){observe(()=>{unchangedMismatchSkips++;});},
      sharedRead(){observe(()=>{sharedReads++;});},
      check(){if(!closed)checkAttempts++;},
      retry(code,stage){observe(()=>{
        if(closed)return;
        retryCount++;failedStage=phase==='capture'?'capture':stage;
        const key=phase==='capture'?captureReason(code):reason(code);
        lastFailureReason=key;retryReasons[key]=(retryReasons[key]??0)+1;
      });},
      read(scope,info){observe(()=>{
        if(closed)return;
        const bytes=number(info.bytesRead)??0;
        scans++;scanBytes+=bytes;
        const entry=namespaces.get(scope);
        if(!entry)return;
        entry.fileBytes=number(info.fileBytes);entry.scanBytes+=bytes;entry.scans++;
        if(info.complete===true)entry.completeScans++;
      });},
      finish(outcome,code,stage){
        if(closed)return;
        observe(()=>advance(phase));closed=true;
        if(!valid){unavailable++;return;}
        const stored=safe(()=>{
        const completedAt=number(wallClock());if(completedAt===null)throw Error('measurement_clock_unavailable');
        const sample={id,certificateRef,budgetMs:number(budgetMs),startedAt:number(startedAt),completedAt,outcome,keyCount,namespaceCount,omittedNamespaces:namespaceCount-namespaces.size,
          elapsedMs:Math.max(0,mark-began),phases,checkAttempts,rechecks:Math.max(0,checkAttempts-1),
          retryCount,retryReasons,unchangedMismatchSkips,sharedReads,failedStage:outcome==='failed'?failedStage??stage:null,
          failureReason:outcome==='failed'?lastFailureReason??(phase==='capture'?captureReason(code):reason(code)):null,scans,scanBytes,namespaces:[...namespaces.values()]};
        const next=[...recent,sample],evict=next.length>HISTORY_LIMIT;
        const nextRecent=evict?next.slice(-HISTORY_LIMIT):next;
        pruneFailures();
        const nextFailures=outcome==='failed'?[...failures,{...sample,timeline,omittedEvents}]:failures;
        const failureOverflow=nextFailures.length>FAILURE_LIMIT;
        const boundedFailures=failureOverflow?nextFailures.slice(-FAILURE_LIMIT):nextFailures;
        recent=nextRecent;failures=boundedFailures;
        if(outcome==='failed'&&stage==='readback'&&lastReader){if(firstReadbackFailures.length<8)firstReadbackFailures.push({certificateRef,startedAt:number(startedAt),completedAt,failedStage:sample.failedStage,...lastReader});else omittedReadbackFailures++;}
        if(evict)evicted++;if(failureOverflow)failureEvicted++;
        return true;
      },false);
        if(!stored)unavailable++;
      },
    };
  },null);if(!measurement)unavailable++;return measurement;}
  return {begin,complete,snapshot:()=>safe(()=>{pruneFailures();return structuredClone({version:1,historyLimit:HISTORY_LIMIT,namespaceLimit:NAMESPACE_LIMIT,evicted,unavailable,totals,recent,
    readbackFailureEvidence:{limit:8,retention:'first_per_process',omitted:omittedReadbackFailures,first:firstReadbackFailures},
    failureTraces:{limit:FAILURE_LIMIT,retentionMs:FAILURE_TTL_MS,eventLimit:EVENT_LIMIT,evicted:failureEvicted,expired:failureExpired,clockUnavailable:failureClockUnavailable,lookupCoverage:'bounded_missing_is_unknown',physicalReadCompletionAfterAbort:'unknown',recent:failures}});},null)};
}
