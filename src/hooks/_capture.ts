import {sendCapture,restoreSdkOriginal} from "../capture/delivery.js";
import { createHash } from "node:crypto";
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

export type CaptureOutcome = "delivered" | "duplicate" | "rejected" | "spooled" | "dropped";
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
