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

export const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = resolveClientSecret(REST_URL);
const DRAIN_CHILD_ENV = "AGENTMEMORY_CAPTURE_DRAIN_CHILD";
const DRAIN_MAX_RECORDS = 500;
const DRAIN_DEADLINE_MS = 20_000;
const DRAIN_REQUEST_TIMEOUT_MS = 5000;

export type CaptureOutcome = "delivered" | "duplicate" | "rejected" | "spooled" | "dropped";
export type CaptureHandoffOutcome = CaptureOutcome | "pending";

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
  const text = await res.text().catch(() => "");
  const outcome = classify(res.status);
  if (outcome !== "delivered" && outcome !== "duplicate") return { outcome, mark: null };
  try {
    const result = JSON.parse(text) as Record<string, unknown> | null;
    return { outcome, mark: parseSentMark(result), acknowledged: Boolean(result && typeof result.observationId === "string" && result.observationId && result.success !== false && !result.error) };
  } catch {
    return { outcome, mark: null };
  }
}

function keepUntilDurable(eventId: string, body: Record<string, unknown>, mark: SentMark, target?: CaptureTarget): { requeued: number; retained: boolean } {
  const url = target?.url ?? REST_URL;
  const { requeued } = reconcileSent(url, mark.bootId, { dir: target?.dir });
  return { requeued, retained: retainSent(url, eventId, body, mark, { dir: target?.dir }) };
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
export async function handoffObservation(body: ObserveBody, timeoutMs: number, target: CaptureTarget): Promise<CaptureHandoffOutcome> {
  const eventId = body.eventId ?? deriveEventId(body.hookType, body.sessionId, null, body.data);
  const payload = { ...body, eventId } as unknown as Record<string, unknown>;
  const deadline=Date.now()+timeoutMs;
  const remaining=()=>Math.max(0,deadline-Date.now());
  const oversized=Buffer.byteLength(JSON.stringify(payload))>spoolPolicy().maxRecordBytes;
  if(oversized&&await durableReceipt({...body,eventId},target,deadline))return 'duplicate';
  let reason = "server-error";
  try {
    if(!remaining())return "pending";
    const { outcome, mark, acknowledged } = await post(payload, remaining(), target);
    if (outcome === "delivered" || outcome === "duplicate") {
      if(oversized)return await durableReceipt({...body,eventId},target,deadline)?outcome:'pending';
      if (!mark || !acknowledged) return "pending";
      const { requeued } = reconcileSent(target.url, mark.bootId, { dir: target.dir });
      if (!retainSent(target.url, eventId, payload, mark, { dir: target.dir, preserveImages: true, requireReceipt: true })) return await durableReceipt({...body,eventId},target,deadline)?outcome:"pending";
      if (requeued > 0 && target.url === REST_URL) startDrainChild();
      return outcome;
    }
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
  const payload = { ...body, eventId } as unknown as Record<string, unknown>;
  let reason: string;
  try {
    const { outcome, mark } = await post(payload, timeoutMs);
    if (outcome !== "retry") {
      const kept = mark ? keepUntilDurable(eventId, payload, mark) : { requeued: 0, retained: true };
      if (kept.requeued > 0 || spoolHasRecords(REST_URL)) startDrainChild();
      if (kept.retained) return outcome;
      reason = "sent-retention-failed";
    } else {
      reason = "server-error";
    }
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    reason = name === "TimeoutError" || name === "AbortError" ? "timeout" : "unreachable";
  }
  return appendSpool(REST_URL, eventId, payload, reason).spooled ? "spooled" : "dropped";
}

export function isDrainChild(): boolean {
  return process.env[DRAIN_CHILD_ENV] === "1";
}

export async function runDrainChild(): Promise<DrainResult> {
  return drainSpool(
    REST_URL,
    async (record: SpoolRecord) => {
      const { outcome, mark, acknowledged } = await post({ ...record.body, eventId: record.eventId }, DRAIN_REQUEST_TIMEOUT_MS);
      if (record.requireReceipt && (outcome === "delivered" || outcome === "duplicate") && (!mark || !acknowledged)) return "retry";
      if (mark && !retainSent(REST_URL, record.eventId, record.body, mark, { requireReceipt: record.requireReceipt, preserveImages: record.requireReceipt })) return "retry";
      return outcome;
    },
    { maxRecords: DRAIN_MAX_RECORDS, deadlineMs: DRAIN_DEADLINE_MS },
  ).then(result => result.skipped === "locked" ? { ...result, remaining: Math.max(1, result.remaining) } : result).catch(() => ({ claimed: 0, delivered: 0, duplicates: 0, rejected: 0, expired: 0, corrupt: 0, remaining: 1, error: "capture_drain_failed" }));
}
