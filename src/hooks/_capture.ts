import {deliverSdkCaptureV2,drainSdkCapturesV2,SDK_CAPTURE_V2_FLAG,type V2DeliveryResult,type V2PostResult} from "../capture/sdk-delivery-v2.js";
import {scrubRecord} from "../functions/privacy.js";
import {performance} from "node:perf_hooks";
import {sendCapture,restoreSdkOriginal} from "../capture/delivery.js";
import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import { capturePayloadDigest } from "../capture/receipt-digest.js";
import { spawn } from "node:child_process";
import { resolveClientSecret } from "../secret-store.js";
import { deriveEventId, hasHostIdentity } from "../capture/event-id.js";
import {
  appendSpool,
  drainInProgress,
  drainSpool,
  parseSentMark,
  reconcileSent,
  retainSent,
  spoolHasRecords,
  spoolPolicy,
  type SendOutcome,
  type SentMark,
  type SpoolRecord,
  type DrainResult,
} from "../capture/spool.js";

export {restoreSdkSourcePayload} from "../capture/delivery.js";
export { stripPrivateData } from "../functions/privacy.js";

export const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = resolveClientSecret(REST_URL);
const DRAIN_CHILD_ENV = "AGENTMEMORY_CAPTURE_DRAIN_CHILD";
const DRAIN_MAX_RECORDS = 500;
const DRAIN_DEADLINE_MS = 20_000;
const DRAIN_REQUEST_TIMEOUT_MS = 5000;

export type CaptureOutcome = "delivered" | "duplicate" | "rejected" | "spooled" | "dropped" | "held";
export type CaptureHandoffOutcome = CaptureOutcome | "pending" | "held";

interface CaptureTarget {
  url: string;
  headers: Record<string, string>;
  dir?: string;
}

export interface ObserveBody {
  hookType: string;
  sessionId: string;
  project: string;
  cwd: string;
  timestamp: string;
  data: unknown;
  eventId?: string;
}

export function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
  return h;
}

export function withEventId(
  body: ObserveBody,
  host: Record<string, unknown>,
  content?: unknown,
  options: { stable?: boolean } = {},
): ObserveBody {
  const source = options.stable || hasHostIdentity(host) ? host : { ...host, timestamp: body.timestamp };
  return {
    ...body,
    eventId: deriveEventId(body.hookType, body.sessionId, source, content ?? body.data),
  };
}

function classify(status: number): SendOutcome {
  if (status >= 200 && status < 300) return status === 200 ? "duplicate" : "delivered";
  if (status === 408 || status === 429 || status >= 500) return "retry";
  return "rejected";
}

async function post(body: Record<string, unknown>, timeoutMs: number, target?: CaptureTarget): Promise<{ outcome: SendOutcome; mark: SentMark | null; acknowledged?: boolean }> {
  const res = await fetch(`${target?.url ?? REST_URL}/agentmemory/observe`, {
    method: "POST",
    headers: target?.headers ?? authHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const result = await res.json().catch(() => null);
  return classifyReply(res.status, result);
}

function classifyReply(status: number, result: unknown): { outcome: SendOutcome; mark: SentMark | null; acknowledged?: boolean } {
  const value = result && typeof result === 'object' ? result as Record<string, unknown> : null;
  const outcome = classify(status);
  if (status === 503 && value?.reason === 'SDK_COMPLETION_ONLY') return { outcome: 'held', mark: null };
  if (outcome !== 'delivered' && outcome !== 'duplicate') return { outcome, mark: null };
  return { outcome, mark: parseSentMark(value), acknowledged: Boolean(value && typeof value.observationId === 'string' && value.observationId && value.success !== false && !value.error) };
}

async function durableReceipt(body: ObserveBody, target: CaptureTarget, deadline: number): Promise<boolean> {
  try {
    const key='cap_'+createHash('sha256').update(`${body.project}\u0000${body.sessionId}\u0000${body.eventId}`).digest('hex').slice(0,40);
    const digest=capturePayloadDigest(body);
    const budgetMs=Math.min(15_000,deadline-Date.now());if(budgetMs<=0)return false;
    const query=new URLSearchParams({key,digest,budgetMs:String(budgetMs)});
    const response=await fetch(`${target.url}/agentmemory/capture/receipts?${query}`,{method:'GET',headers:target.headers,signal:AbortSignal.timeout(budgetMs)});
    if(!response.ok)return false;
    const receipt=await response.json() as Record<string,unknown>;
    return receipt.key===key&&receipt.state==='completed'&&receipt.durable===true;
  }catch{return false;}
}

// Legacy ownership requires a fsynced managed copy or a freshly verified durable receipt.
export async function handoffObservation(body: ObserveBody, timeoutMs: number, target: CaptureTarget, initialReply?: { status: number; body: unknown }): Promise<CaptureHandoffOutcome> {
  const eventId = body.eventId ?? deriveEventId(body.hookType, body.sessionId, null, body.data);
  const payload = { ...body, eventId } as unknown as Record<string, unknown>;
  const deadline=Date.now()+timeoutMs;
  const remaining=()=>Math.max(0,deadline-Date.now());
  const oversized=Buffer.byteLength(JSON.stringify(payload))>spoolPolicy().maxRecordBytes;
  if(oversized&&await durableReceipt({...body,eventId},target,deadline))return 'duplicate';
  let reason = "server-error";
  try {
    if(!remaining())return "pending";
    const { outcome, mark, acknowledged } = initialReply ? classifyReply(initialReply.status, initialReply.body) : await post(payload, remaining(), target);
    if (outcome === "delivered" || outcome === "duplicate") {
      if(oversized)return await durableReceipt({...body,eventId},target,deadline)?outcome:'pending';
      if (!mark || !acknowledged) return "pending";
      const { requeued } = reconcileSent(target.url, mark.bootId, { dir: target.dir });
      if (!retainSent(target.url, eventId, payload, mark, { dir: target.dir, preserveImages: true, requireReceipt: true })) return await durableReceipt({...body,eventId},target,deadline)?outcome:"pending";
      if (requeued > 0 && target.url === REST_URL) startDrainChild();
      return outcome;
    }
    if(outcome==="held")return "held";
    if (outcome === "rejected") return "rejected";
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    reason = name === "TimeoutError" || name === "AbortError" ? "timeout" : "unreachable";
  }
  if(oversized)return "pending";
  if (!appendSpool(target.url, eventId, payload, reason, { dir: target.dir, preserveImages: true, requireReceipt: true }).spooled) return "dropped";
  if (target.url === REST_URL) startDrainChild();
  return "spooled";
}

function startDrainChild(): void {
  if (process.env[DRAIN_CHILD_ENV] === "1") return;
  if (!process.argv[1] || drainInProgress(REST_URL)) return;
  try {
    const child = spawn(process.execPath, [process.argv[1]], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, [DRAIN_CHILD_ENV]: "1" },
    });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

export async function captureObservation(body: ObserveBody, timeoutMs: number): Promise<CaptureOutcome> {
  const eventId = body.eventId ?? deriveEventId(body.hookType, body.sessionId, null, body.data);
  const payload = { ...body, eventId, captureCompletion: 'sdk-v1' } as Record<string, unknown>;
  let reason = 'delivery-pending';
  try {
    const outcome = await sendCapture({ eventId, body: payload }, value => postRaw(value, timeoutMs), REST_URL, { fresh: true });
    if (outcome === 'delivered' || outcome === 'duplicate' || outcome === 'rejected') {
      if (spoolHasRecords(REST_URL)) startDrainChild();
      return outcome;
    }
    reason = outcome === 'held' ? 'sdk-completion-held' : 'server-error';
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable';
  }
  return appendSpool(REST_URL, eventId, payload, reason, { preserveImages: true }).spooled ? 'spooled' : 'dropped';
}

let nativeCapturesPending = 0;
let nativeCaptureFailed = false;
let nativeCapturePriorExitCode: typeof process.exitCode;
let nativeExitReporterInstalled = false;

function reportNativeCaptureFailure(code: string, detail?: V2DeliveryResult): void {
  nativeCaptureFailed = true;
  process.exitCode ||= 1;
  try {
    writeSync(2, JSON.stringify({
      code,
      pendingSpoolAcknowledged: detail?.referenceAcknowledged ?? false,
      ...(detail ? {sourceAcknowledged:detail.sourceAcknowledged} : {}),
      sdkOriginalRetention: detail?.sourceAcknowledged ? "verified-v2" : "unconfirmed",
      serverCompletion: "unconfirmed",
      automaticHostRetry: "unverified",
    }) + "\n");
  } catch {}
}

export async function captureObservationForHook(body: ObserveBody, timeoutMs: number): Promise<CaptureOutcome> {
  if (!nativeExitReporterInstalled) {
    nativeExitReporterInstalled = true;
    process.once("exit", () => {
      if (nativeCapturesPending > 0) reportNativeCaptureFailure("CAPTURE_LOCAL_HANDOFF_UNCONFIRMED");
    });
  }
  if (nativeCapturesPending++ === 0 && !nativeCaptureFailed) nativeCapturePriorExitCode = process.exitCode;
  process.exitCode ||= 1;
  let detail: V2DeliveryResult | undefined;
  let outcome: CaptureOutcome;
  if (process.argv.includes(SDK_CAPTURE_V2_FLAG)) {
    detail = await captureObservationV2(body, timeoutMs).catch(() => ({outcome:"dropped" as const,code:"STORE_OR_DELIVERY_UNCONFIRMED",sourceAcknowledged:false,referenceAcknowledged:false}));
    outcome = detail.outcome;
  } else outcome = await captureObservation(body, timeoutMs).catch(() => "dropped" as const);
  nativeCapturesPending--;
  if (outcome === "dropped" || outcome === "held") reportNativeCaptureFailure(detail?.code ?? "CAPTURE_LOCAL_HANDOFF_FAILED", detail);
  if (nativeCapturesPending === 0 && !nativeCaptureFailed && process.exitCode === 1) process.exitCode = nativeCapturePriorExitCode;
  return outcome;
}

function connectionRefused(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value=error as {code?:unknown;cause?:unknown;errors?:unknown[]};
  if(value.code==="ECONNREFUSED")return true;
  if(Array.isArray(value.errors)&&value.errors.length)return value.errors.every(connectionRefused);
  return value.cause!==undefined&&connectionRefused(value.cause);
}
async function postRawV2(body:Record<string,unknown>,timeoutMs:number,deadline?:number):Promise<V2PostResult>{
  const serialized=JSON.stringify(body),headers=authHeaders();
  const remaining=deadline===undefined?timeoutMs:Math.min(timeoutMs,Math.floor(deadline-performance.now()));
  if(remaining<=0)return {status:0,body:null,notSent:true};
  try{
    const response=await fetch(`${REST_URL}/agentmemory/observe`,{method:'POST',headers,body:serialized,redirect:'error',signal:AbortSignal.timeout(remaining)});
    return {status:response.status,body:await response.json().catch(()=>({}))};
  }catch(error){
    if(connectionRefused(error))return {status:0,body:null,notSent:true};
    throw error;
  }
}
async function captureObservationV2(body:ObserveBody,timeoutMs:number):Promise<V2DeliveryResult>{
  if(!spoolPolicy().enabled)return {outcome:"dropped",code:"CAPTURE_PRESERVATION_DISABLED",sourceAcknowledged:false,referenceAcknowledged:false};
  const started=performance.now();
  const eventId=body.eventId??deriveEventId(body.hookType,body.sessionId,null,body.data);
  const payload=scrubRecord(JSON.parse(JSON.stringify({...body,eventId,captureCompletion:"sdk-v1"})),{scrubKeys:true}) as Record<string,unknown>;
  const options={dir:process.env["AGENTMEMORY_SDK_CAPTURE_V2_DIR"]};
  const result=await deliverSdkCaptureV2(REST_URL,payload,b=>postRawV2(b,timeoutMs),options);
  const now=performance.now(),deadline=Math.min(started+timeoutMs,now+250),remaining=Math.floor(deadline-now);
  if(body.hookType!=="stop"&&(result.outcome==="delivered"||result.outcome==="duplicate")&&remaining>=100){
    const backlog=await drainSdkCapturesV2(REST_URL,(b,budget)=>postRawV2(b,budget?.remainingMs??remaining,budget?.deadline??deadline),{...options,limit:1,budgetMs:remaining,deadline});
    if(backlog.held||backlog.error){try{writeSync(2,JSON.stringify({code:"CAPTURE_BACKLOG_HELD",held:backlog.held,error:backlog.error})+"\n");}catch{}}
  }
  return result;
}

async function postRaw(body:Record<string,unknown>,timeoutMs:number,path="/observe"):Promise<{status:number;body:unknown}>{
 const response=await fetch(`${REST_URL}/agentmemory${path}`,{method:'POST',headers:authHeaders(),body:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)});
 return {status:response.status,body:await response.json().catch(()=>({}))};
}

export async function restoreObservationOriginal(eventId:string,timeoutMs=5000){
 return restoreSdkOriginal(REST_URL,eventId,body=>postRaw(body,timeoutMs,'/capture/restore-sdk'));
}

export function isDrainChild(): boolean {
  return process.env[DRAIN_CHILD_ENV] === "1";
}

export async function runDrainChild(): Promise<DrainResult> {
  return drainSpool(
    REST_URL,
    (record: SpoolRecord) => sendCapture(record,b=>postRaw(b,DRAIN_REQUEST_TIMEOUT_MS),REST_URL),
    { maxRecords: DRAIN_MAX_RECORDS, deadlineMs: DRAIN_DEADLINE_MS },
  ).then(result => result.skipped === "locked" ? { ...result, remaining: Math.max(1, result.remaining) } : result).catch(() => ({ claimed: 0, delivered: 0, duplicates: 0, rejected: 0, expired: 0, corrupt: 0, remaining: 1, error: "capture_drain_failed" }));
}
