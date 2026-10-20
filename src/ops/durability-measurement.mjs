import {createHmac,randomBytes} from 'node:crypto';
import {performance} from 'node:perf_hooks';

const HISTORY_LIMIT=8,NAMESPACE_LIMIT=8;
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

export function createDurabilityMeasurements(){
  const salt=safe(()=>randomBytes(32),null);
  let recent=[],sequence=0,evicted=0,unavailable=0;
  function begin(scopes,keyCount){const measurement=safe(()=>{
    if(!salt)return null;
    const began=performance.now();
    if(number(began)===null)return null;
    let mark=began,phase='capture',closed=false,valid=true,checkAttempts=0,retryCount=0,failedStage=null,lastFailureReason=null;
    const phases={captureMs:0,readbackMs:0,fsyncMs:0,verifyMs:0,cleanupMs:0,retryWaitMs:0};
    const retryReasons={},namespaces=new Map();
    let namespaceCount=0,scans=0,scanBytes=0;
    for(const scope of scopes){
      namespaceCount++;
      if(namespaces.size<NAMESPACE_LIMIT)namespaces.set(scope,{
        kind:kind(scope),token:createHmac('sha256',salt).update(scope).digest('hex').slice(0,16),
        fileBytes:null,scanBytes:0,scans:0,completeScans:0,
      });
    }
    const id=++sequence;
    function observe(work){if(!closed&&valid)try{work();}catch{valid=false;}}
    function advance(next){
      const now=performance.now();
      if(number(now)===null)throw Error('measurement_clock_unavailable');
      phases[phase+'Ms']+=Math.max(0,now-mark);mark=now;phase=next;
    }
    return {
      enter(next){observe(()=>advance(next));},
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
        const sample={id,completedAt:Date.now(),outcome,keyCount,namespaceCount,omittedNamespaces:namespaceCount-namespaces.size,
          elapsedMs:Math.max(0,mark-began),phases,checkAttempts,rechecks:Math.max(0,checkAttempts-1),
          retryCount,retryReasons,failedStage:outcome==='failed'?failedStage??stage:null,
          failureReason:outcome==='failed'?lastFailureReason??(phase==='capture'?captureReason(code):reason(code)):null,scans,scanBytes,namespaces:[...namespaces.values()]};
        const next=[...recent,sample],evict=next.length>HISTORY_LIMIT;
        recent=evict?next.slice(-HISTORY_LIMIT):next;
        if(evict)evicted++;
        return true;
      },false);
        if(!stored)unavailable++;
      },
    };
  },null);if(!measurement)unavailable++;return measurement;}
  return {begin,snapshot:()=>safe(()=>structuredClone({version:1,historyLimit:HISTORY_LIMIT,namespaceLimit:NAMESPACE_LIMIT,evicted,unavailable,recent}),null)};
}
