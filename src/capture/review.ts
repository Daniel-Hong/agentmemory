import type { CaptureReviewHistory } from '../types.js';
import type { InboxRecord } from '../functions/capture.js';
import type { StateKV } from '../state/kv.js';
import { KV } from '../state/schema.js';

export function captureFailureCode(error: string): string {
  if (error.includes('Session observation limit reached')) return 'SESSION_OBSERVATION_LIMIT';
  if (error.includes('CAPTURE_OBSERVATION_NOT_STORED')) return 'OBSERVATION_NOT_STORED';
  if (/timeout|timed out/i.test(error)) return 'CAPTURE_STORE_TIMEOUT';
  return 'CAPTURE_STORE_FAILED';
}

function initial(rec: InboxRecord): CaptureReviewHistory {
  return {key:rec.key,eventId:rec.eventId,sessionId:rec.sessionId,project:rec.project,hookType:rec.hookType,
    observationId:rec.observationId,acceptedAt:rec.acceptedAt,updatedAt:rec.updatedAt,status:rec.status,
    totalAttempts:rec.attempts,manualRetries:0,failures:[],requests:{}};
}

export async function reviewHistory(kv: StateKV, rec: InboxRecord): Promise<CaptureReviewHistory> {
  const existing = await kv.get<CaptureReviewHistory>(KV.captureReview, rec.key);
  if (existing) return structuredClone(existing);
  const history = initial(rec);
  if (rec.lastError) history.failures.push({at:rec.updatedAt,attempt:rec.attempts,code:captureFailureCode(rec.lastError),legacy:true});
  return history;
}

export async function recordCaptureFailure(kv: StateKV, rec: InboxRecord): Promise<void> {
  const history = structuredClone(await kv.get<CaptureReviewHistory>(KV.captureReview,rec.key) ?? initial(rec));
  history.totalAttempts=rec.attempts;history.cycleAttempts=rec.cycleAttempts;history.updatedAt=rec.updatedAt;history.status=rec.status;
  if(rec.manualRequestId&&history.requests[rec.manualRequestId])history.requests[rec.manualRequestId]={...history.requests[rec.manualRequestId]!,finishedAt:rec.updatedAt,outcome:rec.status==='dead'?'dead':'waiting'};
  history.failures.push({at:rec.updatedAt,attempt:rec.attempts,code:captureFailureCode(rec.lastError || '')});
  await kv.set(KV.captureReview,rec.key,history);
}

export async function resolveCaptureReview(kv: StateKV, rec: InboxRecord, observationId: string): Promise<void> {
  const saved=await kv.get<CaptureReviewHistory>(KV.captureReview,rec.key);
  if (!saved) return;
  const history=structuredClone(saved);
  if(history.status==='completed'&&history.observationId===observationId&&history.totalAttempts>=rec.attempts)return;
  history.status='completed';history.observationId=observationId;history.totalAttempts=rec.attempts;
  history.updatedAt=new Date().toISOString();history.recoveredAt=history.updatedAt;
  if(rec.manualRequestId && history.requests[rec.manualRequestId])history.requests[rec.manualRequestId]={...history.requests[rec.manualRequestId]!,finishedAt:history.updatedAt,outcome:'recovered'};
  await kv.set(KV.captureReview,rec.key,history);
}

export function reviewMetadata(history: CaptureReviewHistory) {
  const requests=Object.entries(history.requests);const last=requests[requests.length-1];
  return {status:history.status,totalAttempts:history.totalAttempts,manualRetries:history.manualRetries,
    lastFailureCode:history.failures.at(-1)?.code ?? null,recoveredAt:history.recoveredAt ?? null,
    lastRequest:last ? {requestId:last[0],...last[1]} : null};
}

export async function captureReviewPage(kv: StateKV, input: {status?:string;eventId?:string;key?:string;cursor?:string;limit?:number;historyOffset?:number}) {
  const limit=Math.min(Math.max(1,Number(input.limit)||25),50);
  const inbox=await kv.list<InboxRecord>(KV.captureInbox);
  const histories=await kv.list<CaptureReviewHistory>(KV.captureReview);
  const byKey=new Map(histories.map(h=>[h.key,h]));
  const rows=new Map<string,any>();
  for (const h of histories) rows.set(h.key,{key:h.key,eventId:h.eventId,sessionId:h.sessionId,project:h.project,hookType:h.hookType,
    observationId:h.observationId,status:h.status,attempts:h.totalAttempts,acceptedAt:h.acceptedAt,updatedAt:h.updatedAt,review:reviewMetadata(h),preview:'복구 기록 · 원문은 저장된 관측에서 확인'});
  for (const rec of inbox) {
    const h=byKey.get(rec.key);const d=rec.payload?.data as Record<string,unknown>|undefined;
    const text=typeof d?.tool_name==='string' ? d.tool_name : rec.hookType;
    rows.set(rec.key,{key:rec.key,eventId:rec.eventId,sessionId:rec.sessionId,project:rec.project,hookType:rec.hookType,
      observationId:rec.observationId,status:rec.status,attempts:rec.attempts,acceptedAt:rec.acceptedAt,updatedAt:rec.updatedAt,
      errorCode:rec.lastError ? captureFailureCode(rec.lastError) : null,preview:text,
      review:h ? reviewMetadata(h) : {status:rec.status,totalAttempts:rec.attempts,manualRetries:0,lastFailureCode:rec.lastError?captureFailureCode(rec.lastError):null,recoveredAt:null,lastRequest:null}});
  }
  let filtered=[...rows.values()].filter(r=>(!input.status||r.status===input.status)&&(!input.eventId||r.eventId===input.eventId)&&(!input.key||r.key===input.key));
  filtered.sort((a,b)=>a.acceptedAt.localeCompare(b.acceptedAt)||a.key.localeCompare(b.key));
  const total=filtered.length;
  if(input.cursor){
    if(input.cursor.length>512)throw new Error('INVALID_CAPTURE_CURSOR');
    let cursor;try{cursor=JSON.parse(Buffer.from(input.cursor,'base64url').toString());}catch{throw new Error('INVALID_CAPTURE_CURSOR');}
    if(!Array.isArray(cursor)||cursor.length!==2||!cursor.every(x=>typeof x==='string')||input.cursor.length>512)throw new Error('INVALID_CAPTURE_CURSOR');
    filtered=filtered.filter(r=>r.acceptedAt>cursor[0]||r.acceptedAt===cursor[0]&&r.key>cursor[1]);
  }
  const items=filtered.slice(0,limit);const last=items.at(-1);
  for(const item of items){const rec=inbox.find(r=>r.key===item.key);if(rec){const d=rec.payload?.data as Record<string,unknown>|undefined;item.preview=(item.preview+': '+JSON.stringify(d?.tool_input??d?.prompt??d?.message??'')).slice(0,500);}}
  if(input.eventId)for(const item of items){const h=byKey.get(item.key);const offset=Number.isSafeInteger(input.historyOffset)&&input.historyOffset!>=0 ? input.historyOffset! : 0;
    item.failures=h?.failures.slice(offset,offset+50)||[];item.nextHistoryOffset=h&&h.failures.length>offset+50 ? offset+50 : null;}
  return {total,items,nextCursor:filtered.length>limit&&last?Buffer.from(JSON.stringify([last.acceptedAt,last.key])).toString('base64url'):null};
}
