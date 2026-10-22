import { createOutboxMetadata, type OutboxMetadata } from "../capture/outbox-metadata.js";
import { registerCaptureReceipts } from "../capture/receipts.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IIIClient } from "iii-sdk";
import type { CaptureReviewHistory, CompressedObservation, HookPayload } from "../types.js";
import { KV, generateId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { getEnvVar, getStateBackend } from "../config.js";
import { logger } from "../logger.js";
import { isValidEventId } from "../capture/event-id.js";
import {
  EVENT_SHARD_CHARS,
  EVENT_SHARDS,
  captureEventScope as eventScope,
  type CompletedEvent,
} from "../capture/event-record.js";
import { captureReviewPage, recordCaptureFailure, resolveCaptureReview, reviewHistory } from "../capture/review.js";
import { createCaptureRetryJobs } from "../capture/retry-jobs.js";
import { backgroundTask, backgroundPaused } from "../ops/background-control.mjs";
import { restoreIndexEntries } from "./observe.js";
import { prunePromptLedgers } from "../capture/prompt-ledger.js";
import { scrubRecord } from "./privacy.js";
import { runtimeConfigPath } from "../cli/engine-launch.js";
import { captureDurableAfterMs, engineStateConfigPaths } from "../cli/engine-config.js";
import {
  drainSpool,
  reconcileSent,
  retainSent,
  spoolDir,
  spoolPolicy,
  spoolSummary,
  type DrainResult,
  type SendOutcome,
  type SentMark,
  type SpoolRecord,
  type SpoolSummary,
} from "../capture/spool.js";

export type InboxState = "pending" | "retrying" | "dead";

export interface InboxRecord {
  key: string;
  eventId: string;
  eventSource: "client" | "server";
  sessionId: string;
  project: string;
  hookType: string;
  observationId: string;
  status: InboxState;
  attempts: number;
  cycleAttempts?: number;
  manualRequestId?: string;
  acceptedAt: string;
  updatedAt: string;
  nextAttemptAt?: string;
  deadAt?: string;
  lastError?: string;
  payload: HookPayload;
}

export type { CompletedEvent } from "../capture/event-record.js";
export { captureEventShard } from "../capture/event-record.js";

export type CaptureResult =
  | { status: "accepted"; state: "completed"; eventId: string; observationId: string; attempts: number }
  | { status: "accepted"; state: "retrying"; eventId: string; observationId: string; attempts: number; nextAttemptAt: string; error: string }
  | { status: "duplicate"; state: "completed" | InboxState; eventId: string; observationId?: string; deduplicated: true }
  | { status: "rejected"; eventId: string; error: string; retryable: boolean; observationId?: string };

export interface CapturePolicy {
  maxAttempts: number;
  retryIntervalMs: number;
  dedupRetentionHours: number;
  inboxMax: number;
  deadMax: number;
  eventsMax: number;
}

export interface CaptureProgress {
  completedCount: number;
  counterEpoch: string;
  pending: number | null;
  lastCompletedAt: string | null;
  lastSweepAt: string | null;
  sweepRunning: boolean;
  stalled: boolean;
  stallAfterMs: number;
}
export interface CaptureStatus {
  legacyOutbox?: OutboxMetadata;
  progress?: CaptureProgress;
  policy: CapturePolicy;
  inbox: {
    pending: number;
    retrying: number;
    dead: number;
    oldestAcceptedAt: string | null;
    nextAttemptAt: string | null;
    lastError: string | null;
  } | null;
  sinceStart: {
    accepted: number;
    completed: number;
    duplicates: number;
    retried: number;
    recovered: number;
    deadLettered: number;
    rejected: number;
    pruned: number;
  };
  lastSweepAt: string | null;
  lastPruneAt: string | null;
  lastBootDrain: (DrainResult & { at: string }) | null;
  spool: SpoolSummary[];
}

const MAX_BACKOFF_MS = 15 * 60_000;
const ERROR_MAX_CHARS = 500;

function positiveInt(key: string, fallback: number): number {
  const raw = getEnvVar(key);
  if (!raw || !/^\d+$/.test(raw.trim())) return fallback;
  const n = parseInt(raw.trim(), 10);
  return n > 0 ? n : fallback;
}

export function capturePolicy(): CapturePolicy {
  return {
    maxAttempts: positiveInt("AGENTMEMORY_CAPTURE_MAX_ATTEMPTS", 5),
    retryIntervalMs: positiveInt("AGENTMEMORY_CAPTURE_RETRY_INTERVAL_MS", 10_000),
    dedupRetentionHours: positiveInt("AGENTMEMORY_CAPTURE_DEDUP_HOURS", 168),
    inboxMax: positiveInt("AGENTMEMORY_CAPTURE_INBOX_MAX", 10_000),
    deadMax: positiveInt("AGENTMEMORY_CAPTURE_DEAD_MAX", 1000),
    eventsMax: positiveInt("AGENTMEMORY_CAPTURE_EVENTS_MAX", 100_000),
  };
}

export function captureKey(project: string, sessionId: string, eventId: string): string {
  const hash = createHash("sha256").update(`${project}\u0000${sessionId}\u0000${eventId}`).digest("hex");
  return `cap_${hash.slice(0, 40)}`;
}

const MIN_ID_TIME = Date.UTC(2020, 0, 1);
const MAX_ID_TIME = Date.UTC(2100, 0, 1);

export function observationIdFor(key: string, timestamp: string | undefined, acceptedAt: number): string {
  const at = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
  const stamp = Number.isFinite(at) && at >= MIN_ID_TIME && at < MAX_ID_TIME ? at : acceptedAt;
  return `obs_${stamp.toString(36)}_${key.slice(4, 16)}`;
}

function backoffMs(attempts: number, policy: CapturePolicy): number {
  return Math.min(policy.retryIntervalMs * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, ERROR_MAX_CHARS);
}

function serverSpoolTargets(restPort: number): string[] {
  const url = `http://localhost:${restPort}`;
  const dirs = new Set<string>([spoolDir()]);
  try {
    const { AGENTMEMORY_DATA_DIR: _workerDataDir, AGENTMEMORY_CAPTURE_SPOOL_DIR: _spoolDir, ...hookEnv } = process.env;
    dirs.add(spoolDir(hookEnv));
  } catch {}
  return [...dirs].map((dir) => `${url}|${dir}`);
}

function splitTarget(target: string): { url: string; dir: string } {
  const at = target.indexOf("|");
  return { url: target.slice(0, at), dir: target.slice(at + 1) };
}

export function serverDurableAfterMs(): number {
  let backend: "file" | "redis" = "file";
  try {
    backend = getStateBackend();
  } catch {}
  const configTexts: string[] = [];
  const dataDir = getEnvVar("AGENTMEMORY_DATA_DIR");
  if (dataDir) {
    for (const path of engineStateConfigPaths(join(homedir(), ".agentmemory"), runtimeConfigPath(dataDir))) {
      try {
        configTexts.push(readFileSync(path, "utf-8"));
      } catch {}
    }
  }
  return captureDurableAfterMs(backend, configTexts);
}

let activeController: CaptureController | null = null;

export function getCaptureController(): CaptureController | null {
  return activeController;
}

export interface CaptureController {
  sweep(): Promise<{ processed: number; recovered: number; deadLettered: number }>;
  prune(): Promise<number>;
  drainLocalSpool(): Promise<DrainResult[]>;
  status(): Promise<CaptureStatus>;
  progress(): CaptureProgress;
  durability(): SentMark;
  start(): void;
  stop(): void;
  drain(): Promise<void>;
}

export function registerCaptureFunctions(
  sdk: IIIClient,
  kv: StateKV,
  options: { restPort?: number; durableAfterMs?: number } = {},
): CaptureController {
  registerCaptureReceipts(sdk,kv);
  const inspectOutbox=createOutboxMetadata(join(getEnvVar("AGENTMEMORY_HOME")||join(homedir(),".agentmemory"),"hook-outbox"));
  const policy = capturePolicy();
  const counterEpoch = randomUUID();
  const mark: SentMark = {
    bootId: randomBytes(12).toString("hex"),
    durableAfterMs: options.durableAfterMs ?? serverDurableAfterMs(),
  };
  const counters: CaptureStatus["sinceStart"] = {
    accepted: 0,
    completed: 0,
    duplicates: 0,
    retried: 0,
    recovered: 0,
    deadLettered: 0,
    rejected: 0,
    pruned: 0,
  };
  let lastSweepAt: string | null = null;
  let lastCompletedAt: string | null = null;
  let pendingSince: number | null = null;
  const stallAfterMs = Math.max(300000, policy.retryIntervalMs * 30);
  function progress(): CaptureProgress {
    const pending = activeInboxKeys?.size ?? null;
    return {completedCount:counters.completed,counterEpoch,pending,lastCompletedAt,lastSweepAt,sweepRunning:!!sweeping,stallAfterMs,
      stalled:pending!==null && pending>0 && pendingSince!==null && Date.now()-Math.max(pendingSince,lastCompletedAt?Date.parse(lastCompletedAt):0)>stallAfterMs};
  }
  let lastPruneAt: string | null = null;
  let lastBootDrain: CaptureStatus["lastBootDrain"] = null;
  let sweeping: Promise<{ processed: number; recovered: number; deadLettered: number }> | null = null;
  let inboxSize: number | null = null;
  let activeInboxKeys: Set<string> | null = null;
  let stopped = false;
  const timers: Array<ReturnType<typeof setInterval>> = [];
  const maintenance=new Set<Promise<unknown>>();
  function trackWork<T>(work:()=>Promise<T>):Promise<T> {
    const pending=Promise.resolve().then(work);maintenance.add(pending);
    const done=()=>{maintenance.delete(pending);};pending.then(done,done);
    return pending;
  }
  const trackMaintenance=(work:()=>Promise<unknown>)=>{void trackWork(work).catch(()=>{});};
  const spoolTargets = options.restPort ? serverSpoolTargets(options.restPort) : [];

  function updatePendingSince(): void {
    if (activeInboxKeys?.size === 0) pendingSince = null;
    else if (activeInboxKeys && pendingSince === null) pendingSince = Date.now();
  }

  function refreshInbox(records: InboxRecord[]): void {
    inboxSize = records.length;
    activeInboxKeys = new Set(records.filter((rec) => rec && rec.status !== "dead").map((rec) => rec.key));
    updatePendingSince();
  }

  function updateActiveInbox(key: string, active: boolean): void {
    if (active) activeInboxKeys?.add(key);
    else activeInboxKeys?.delete(key);
    updatePendingSince();
  }

  async function currentInboxSize(): Promise<number> {
    if (inboxSize === null) refreshInbox(await kv.list<InboxRecord>(KV.captureInbox));
    return inboxSize!;
  }

  async function complete(rec: InboxRecord, observationId: string): Promise<void> {
    await resolveCaptureReview(kv,rec,observationId);
    const done: CompletedEvent = {
      key: rec.key,
      eventId: rec.eventId,
      sessionId: rec.sessionId,
      project: rec.project,
      observationId,
      acceptedAt: rec.acceptedAt,
      completedAt: new Date().toISOString(),
      attempts: rec.attempts,
    };
    if (rec.eventSource === "client") await kv.set(eventScope(rec.key), rec.key, done);
    await kv.delete(KV.captureInbox, rec.key);
    if (inboxSize !== null) inboxSize = Math.max(0, inboxSize - 1);
    updateActiveInbox(rec.key, false);
    counters.completed++;
    lastCompletedAt = done.completedAt;
  }

  async function storedObservation(done: CompletedEvent): Promise<CompressedObservation | null | undefined> {
    if (!done.observationId) return undefined;
    try {
      return (await kv.get<CompressedObservation>(KV.observations(done.sessionId), done.observationId)) ?? null;
    } catch {
      return undefined;
    }
  }

  async function attempt(rec: InboxRecord): Promise<CaptureResult> {
    rec.cycleAttempts = (rec.cycleAttempts ?? rec.attempts) + 1;
    rec.attempts++;
    type ObserveResult = { observationId?: string; deduplicated?: boolean; success?: boolean; error?: string };
    let result = null as ObserveResult | null;
    let failure: string | null = null;
    try {
      result = (await sdk.trigger({
        function_id: "mem::observe",
        payload: {
          ...rec.payload,
          captureKey: rec.key,
          ...(rec.eventSource === "client" ? { eventId: rec.eventId } : {}),
          observationId: rec.observationId,
        },
      })) as ObserveResult | null;
    } catch (err) {
      failure = errorText(err);
    }
    const now = new Date();
    const hasReview=!!rec.manualRequestId || !!(await kv.get<CaptureReviewHistory>(KV.captureReview,rec.key));
    if (!failure && hasReview && (result?.observationId || result?.deduplicated)) {
      const id=result?.observationId || rec.observationId;
      const stored=await storedObservation({sessionId:rec.sessionId,observationId:id} as CompletedEvent);
      if (!stored || stored.id !== id) failure="CAPTURE_OBSERVATION_NOT_STORED";
      else result={...result,observationId:id};
    }
    if (!failure && result && typeof result.observationId === "string") {
      if (rec.attempts > 1) counters.recovered++;
      await complete(rec, result.observationId);
      return { status: "accepted", state: "completed", eventId: rec.eventId, observationId: result.observationId, attempts: rec.attempts };
    }
    if (!failure && result?.deduplicated) {
      await complete(rec, "");
      counters.duplicates++;
      return { status: "duplicate", state: "completed", eventId: rec.eventId, deduplicated: true };
    }
    const permanent = !failure;
    const message = failure ?? (result && typeof result.error === "string" ? result.error : "mem::observe returned no observation");
    if (permanent || rec.cycleAttempts >= policy.maxAttempts) {
      const dead: InboxRecord = { ...rec, status: "dead", updatedAt: now.toISOString(), deadAt: now.toISOString(), lastError: message };
      delete dead.nextAttemptAt;
      await recordCaptureFailure(kv,dead);
      await kv.set(KV.captureInbox, rec.key, dead);
      updateActiveInbox(rec.key, false);
      counters.deadLettered++;
      logger.warn("capture moved to dead letters", { eventId: rec.eventId, attempts: rec.attempts, error: message });
      return { status: "rejected", eventId: rec.eventId, error: message, retryable: false, observationId: rec.observationId };
    }
    const nextAttemptAt = new Date(now.getTime() + backoffMs(rec.cycleAttempts, policy)).toISOString();
    const retrying: InboxRecord = { ...rec, status: "retrying", updatedAt: now.toISOString(), nextAttemptAt, lastError: message };
    await recordCaptureFailure(kv,retrying);
    await kv.set(KV.captureInbox, rec.key, retrying);
    counters.retried++;
    logger.warn("capture processing failed, will retry", { eventId: rec.eventId, attempts: rec.attempts, nextAttemptAt, error: message });
    return { status: "accepted", state: "retrying", eventId: rec.eventId, observationId: rec.observationId, attempts: rec.attempts, nextAttemptAt, error: message };
  }

  async function capture(input: { payload: HookPayload; eventId?: string }): Promise<CaptureResult> {
    const payload = input.payload;
    const clientEventId = isValidEventId(input.eventId) ? input.eventId : undefined;
    const eventId = clientEventId ?? generateId("evs");
    const key = captureKey(payload.project, payload.sessionId, eventId);
    return withKeyedLock(`capture:${key}`, async () => {
      let storedObservationId: string | undefined;
      if (clientEventId) {
        const done = await kv.get<CompletedEvent>(eventScope(key), key);
        if (done?.state === "deleted") {
          counters.duplicates++;
          return { status: "duplicate", state: "completed", eventId, observationId: done.observationId, deduplicated: true };
        }
        if (done) {
          const stored = await storedObservation(done);
          if (stored === undefined && done.observationId) throw new Error("capture_existing_observation_unavailable");
          if (stored !== null) {
            if (stored) await restoreIndexEntries(stored);
            counters.duplicates++;
            return { status: "duplicate", state: "completed", eventId, observationId: done.observationId, deduplicated: true };
          }
          storedObservationId = done.observationId;
          logger.warn("capture event was marked stored but its observation is missing, storing it again", {
            eventId,
            observationId: done.observationId,
          });
        }
      }
      const queued = await kv.get<InboxRecord>(KV.captureInbox, key);
      if (queued) {
        counters.duplicates++;
        return { status: "duplicate", state: queued.status, eventId, observationId: queued.observationId, deduplicated: true };
      }
      if ((await currentInboxSize()) >= policy.inboxMax) {
        counters.rejected++;
        return { status: "rejected", eventId, error: `capture inbox is full (${policy.inboxMax} unprocessed events)`, retryable: true };
      }
      const acceptedAt = Date.now();
      const { eventId: _ignoredEventId, observationId: _ignoredObservationId, captureKey: _ignoredCaptureKey, ...cleanPayload } = payload;
      const rec: InboxRecord = {
        key,
        eventId,
        eventSource: clientEventId ? "client" : "server",
        sessionId: payload.sessionId,
        project: payload.project,
        hookType: payload.hookType,
        observationId: storedObservationId ?? observationIdFor(key, payload.timestamp, acceptedAt),
        status: "pending",
        attempts: 0,
        acceptedAt: new Date(acceptedAt).toISOString(),
        updatedAt: new Date(acceptedAt).toISOString(),
        payload: { ...cleanPayload, data: scrubRecord(cleanPayload.data) },
      };
      await kv.set(KV.captureInbox, key, rec);
      if (inboxSize !== null) inboxSize++;
      updateActiveInbox(key, true);
      counters.accepted++;
      return attempt(rec);
    });
  }

  async function retryOne(key: string, force: boolean, requestId?: string): Promise<"recovered" | "dead" | "waiting" | "gone" | "stopped"> {
    return withKeyedLock(`capture:${key}`, async () => {
      if (stopped) return "stopped";
      await currentInboxSize();
      const stored=await kv.get<InboxRecord>(KV.captureInbox,key);
      if (!stored) return "gone";
      const rec={...stored};
      if(rec.eventSource==='client'&&(await kv.get<CompletedEvent>(eventScope(key),key))?.state==='deleted'){
        await kv.delete(KV.captureInbox,key);
        if(inboxSize!==null)inboxSize=Math.max(0,inboxSize-1);
        updateActiveInbox(key, false);
        counters.duplicates++;return 'gone';
      }
      let history=await kv.get<CaptureReviewHistory>(KV.captureReview,key);
      if(history?.status==='completed'){
        rec.attempts=Math.max(rec.attempts,history.totalAttempts);
        const observation=await storedObservation({sessionId:rec.sessionId,observationId:history.observationId} as CompletedEvent);
        if(observation?.id===history.observationId){await complete(rec,history.observationId);return 'recovered';}
      }
      if(history && history.totalAttempts>rec.attempts){
        rec.attempts=history.totalAttempts;
        rec.cycleAttempts=history.cycleAttempts??rec.cycleAttempts;
        if(history.status!=='completed')rec.status=history.status;
        rec.updatedAt=history.updatedAt;
        await kv.set(KV.captureInbox,key,rec);
        updateActiveInbox(key, rec.status !== "dead");
      }
      if(rec.status==='dead'&&!force)return 'waiting';
      if(!force&&rec.status==='retrying'&&rec.nextAttemptAt&&Date.parse(rec.nextAttemptAt)>Date.now())return 'waiting';
      if(!history&&rec.lastError){history=await reviewHistory(kv,rec);await kv.set(KV.captureReview,key,history);}
      if(force){
        history=await reviewHistory(kv,rec);
        if(requestId && history.requests[requestId]){
          const previous=history.requests[requestId];
          if(previous.outcome){
            if(previous.outcome!=='recovered'||history.observationId&&(await storedObservation({sessionId:rec.sessionId,observationId:history.observationId} as CompletedEvent))?.id===history.observationId)return previous.outcome;
          }else if(rec.manualRequestId===requestId)return 'waiting';
        }
        const id=requestId??randomUUID();
        if(!history.requests[id]){history.manualRetries++;history.requests[id]={startedAt:new Date().toISOString()};}
        await kv.set(KV.captureReview,key,history);
        rec.cycleAttempts=0;rec.manualRequestId=id;rec.status='retrying';rec.nextAttemptAt=new Date().toISOString();
        await kv.set(KV.captureInbox,key,rec);
        updateActiveInbox(key, true);
      }
      const outcome=await attempt({...rec});
      const outcomeName=outcome.status==='accepted'&&outcome.state==='completed'||outcome.status==='duplicate'&&outcome.state==='completed'?'recovered':outcome.status==='rejected'?'dead':'waiting';
      if(force&&rec.manualRequestId){
        history=await reviewHistory(kv,rec);
        history.requests[rec.manualRequestId]={...history.requests[rec.manualRequestId]!,finishedAt:new Date().toISOString(),outcome:outcomeName};
        await kv.set(KV.captureReview,key,history);
      }
      return outcomeName;
    });
  }

  async function runSweep(): Promise<{ processed: number; recovered: number; deadLettered: number }> {
    if (stopped) return { processed: 0, recovered: 0, deadLettered: 0 };
    const records = await kv.list<InboxRecord>(KV.captureInbox);
    refreshInbox(records);
    let processed = 0;
    let recovered = 0;
    let deadLettered = 0;
    const now = Date.now();
    const due = records
      .filter((r) => r && r.status !== "dead")
      .filter((r) => r.status === "pending" || !r.nextAttemptAt || Date.parse(r.nextAttemptAt) <= now)
      .sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt));
    for (const rec of due) {
      if (stopped) break;
      const outcome = await retryOne(rec.key, false).catch(() => "waiting" as const);
      if (outcome === "stopped") break;
      if (outcome === "gone") continue;
      processed++;
      if (outcome === "recovered") recovered++;
      if (outcome === "dead") deadLettered++;
    }
    lastSweepAt = new Date().toISOString();
    return { processed, recovered, deadLettered };
  }

  function sweep() {
    if (stopped) return Promise.resolve({ processed: 0, recovered: 0, deadLettered: 0 });
    if (!sweeping) {
      sweeping = trackWork(runSweep).finally(() => {
        sweeping = null;
      });
    }
    return sweeping;
  }

  async function prune(): Promise<number> {
    if (stopped) return 0;
    const cutoff = Date.now() - policy.dedupRetentionHours * 3600_000;
    const perShard = Math.max(1, Math.ceil(policy.eventsMax / EVENT_SHARDS));
    let removed = 0;
    for (let i = 0; i < EVENT_SHARDS && !stopped; i++) {
      const scope = KV.captureEvents(i.toString(16).padStart(EVENT_SHARD_CHARS, "0"));
      const events = await kv.list<CompletedEvent>(scope).catch(() => [] as CompletedEvent[]);
      if (events.length === 0) continue;
      const sorted = events.filter(Boolean).sort((a, b) => b.completedAt.localeCompare(a.completedAt));
      for (let j = 0; j < sorted.length && !stopped; j++) {
        const ev = sorted[j]!;
        if (j >= perShard || Date.parse(ev.deletedAt ?? ev.completedAt) < cutoff) {
          await kv.delete(scope, ev.key).catch(() => {});
          removed++;
        }
      }
    }
    // Unprocessed originals and their review history have no age/count expiry.
    if (!stopped) removed += await prunePromptLedgers(kv, cutoff, policy.eventsMax);
    inboxSize = null;
    activeInboxKeys = null;
    counters.pruned += removed;
    lastPruneAt = new Date().toISOString();
    return removed;
  }

  function spoolSender(url: string, dir: string) {
    return async (record: SpoolRecord): Promise<SendOutcome> => {
      const body = record.body as Record<string, unknown>;
      const payload = spoolPayload(body);
      if (!payload) return "rejected";
      const outcome = await capture({ payload, eventId: record.eventId });
      if (outcome.status === "rejected") return outcome.retryable ? "retry" : "rejected";
      if (record.requireReceipt && !outcome.observationId) return "retry";
      if (!retainSent(url, record.eventId, body, mark, { dir, requireReceipt: record.requireReceipt, preserveImages: record.requireReceipt })) return "retry";
      return outcome.status === "duplicate" ? "duplicate" : "delivered";
    };
  }

  async function settleRetained(): Promise<number> {
    let requeued = 0;
    for (const target of spoolTargets) {
      if (stopped) break;
      const { url, dir } = splitTarget(target);
      const settled = reconcileSent(url, mark.bootId, { dir });
      if (settled.requeued > 0) {
        await drainSpool(url, spoolSender(url, dir), { dir, policy: spoolPolicy(), shouldStop: () => stopped });
        requeued += settled.requeued;
      }
    }
    return requeued;
  }

  function drainLocalSpool(): Promise<DrainResult[]> {
    return stopped ? Promise.resolve([]) : trackWork(runDrainLocalSpool);
  }
  async function runDrainLocalSpool(): Promise<DrainResult[]> {
    const results: DrainResult[] = [];
    for (const target of spoolTargets) {
      if (stopped) break;
      const { url, dir } = splitTarget(target);
      reconcileSent(url, mark.bootId, { dir });
      results.push(await drainSpool(url, spoolSender(url, dir), { dir, policy: spoolPolicy(), shouldStop: () => stopped }));
    }
    const total = results.reduce<DrainResult>(
      (acc, r) => ({
        claimed: acc.claimed + r.claimed,
        delivered: acc.delivered + r.delivered,
        duplicates: acc.duplicates + r.duplicates,
        rejected: acc.rejected + r.rejected,
        expired: acc.expired + r.expired,
        corrupt: acc.corrupt + r.corrupt,
        remaining: acc.remaining + r.remaining,
        ...(r.error || acc.error ? { error: r.error ?? acc.error } : {}),
      }),
      { claimed: 0, delivered: 0, duplicates: 0, rejected: 0, expired: 0, corrupt: 0, remaining: 0 },
    );
    lastBootDrain = { ...total, at: new Date().toISOString() };
    return results;
  }

  async function status(): Promise<CaptureStatus> {
    let inbox: CaptureStatus["inbox"] = null;
    try {
      const records = (await kv.list<InboxRecord>(KV.captureInbox)).filter(Boolean);
      refreshInbox(records);
      const live = records.filter((r) => r.status !== "dead");
      const next = live
        .map((r) => r.nextAttemptAt)
        .filter((v): v is string => typeof v === "string")
        .sort()[0];
      const lastFailed = records
        .filter((r) => r.lastError)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      inbox = {
        pending: records.filter((r) => r.status === "pending").length,
        retrying: records.filter((r) => r.status === "retrying").length,
        dead: records.filter((r) => r.status === "dead").length,
        oldestAcceptedAt: live.map((r) => r.acceptedAt).sort()[0] ?? null,
        nextAttemptAt: next ?? null,
        lastError: lastFailed?.lastError ?? null,
      };
    } catch {}
    const seen = new Set<string>();
    const spool: SpoolSummary[] = [];
    for (const target of spoolTargets) {
      const { url, dir } = splitTarget(target);
      const summary = spoolSummary(url, { dir });
      if (seen.has(summary.path)) continue;
      seen.add(summary.path);
      spool.push(summary);
    }
    return { policy, inbox, legacyOutbox:await inspectOutbox(), progress:progress(), sinceStart: { ...counters }, lastSweepAt, lastPruneAt, lastBootDrain, spool };
  }

  sdk.registerFunction("mem::capture", async (input: { payload: HookPayload; eventId?: string }) => capture(input));

  sdk.registerFunction("mem::capture-retry", async (input: { eventId?: string; key?: string; all?: boolean; requestId?: string } = {}) => {
    if(input.requestId && (!input.eventId || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.requestId))) throw new Error("INVALID_RETRY_REQUEST");
    const records = (await kv.list<InboxRecord>(KV.captureInbox)).filter(Boolean);
    refreshInbox(records);
    if(input.eventId && input.requestId && !records.some(r=>input.key?r.key===input.key:r.eventId===input.eventId)){
      const h=(await kv.list<CaptureReviewHistory>(KV.captureReview)).find(h=>(input.key?h.key===input.key:h.eventId===input.eventId)&&h.eventId===input.eventId&&h.requests[input.requestId!]);
      if(h){const outcome=h.requests[input.requestId].outcome;return {matched:1,recovered:outcome==="recovered"?1:0,dead:outcome==="dead"?1:0,waiting:!outcome||outcome==="waiting"?1:0};}
    }
    const targets = records.filter((r) => {
      if (input.key) return r.key === input.key && (!input.eventId || r.eventId === input.eventId);
      if (input.eventId) return r.eventId === input.eventId;
      return input.all === true;
    });
    const outcomes = { recovered: 0, dead: 0, waiting: 0 };
    for (const rec of targets) {
      if (stopped) break;
      const outcome = await retryOne(rec.key, true, input.requestId);
      if (outcome === "recovered") outcomes.recovered++;
      else if (outcome === "dead") outcomes.dead++;
      else if (outcome === "waiting") outcomes.waiting++;
    }
    return { matched: targets.length, ...outcomes };
  });

  sdk.registerFunction("mem::capture-list", async (input: { status?: InboxState | "completed"; limit?: number; review?: boolean; eventId?: string; key?: string; cursor?: string; historyOffset?: number } = {}) => {
    if(input.review) return captureReviewPage(kv,input);
    const limit = Math.min(Math.max(1, Number(input.limit) || 50), 500);
    const records = (await kv.list<InboxRecord>(KV.captureInbox))
      .filter((r) => r && (!input.status || r.status === input.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
      total: records.length,
      items: records.slice(0, limit).map(({ payload, ...rest }) => ({
        ...rest,
        preview: previewPayload(payload),
      })),
    };
  });

  const retryJobs = createCaptureRetryJobs(kv,retryOne);
  sdk.registerFunction("mem::capture-jobs",async (input:{jobId?:string}={})=>({job:await retryJobs.status(input.jobId),backgroundPaused:backgroundPaused()}));
  sdk.registerFunction("mem::capture-jobs-start",async (input:{requestId:string;all?:boolean;eventId?:string;key?:string})=>({job:await retryJobs.start(input),backgroundPaused:backgroundPaused()}));
  sdk.registerFunction("mem::capture-jobs-stop",async (input:{jobId:string})=>({job:await retryJobs.stop(input.jobId),backgroundPaused:backgroundPaused()}));

  sdk.registerFunction("mem::capture-drain", async () => {
    const results = await drainLocalSpool();
    return { results };
  });

  const controller: CaptureController = {
    sweep,
    prune,
    drainLocalSpool,
    status,
    progress,
    durability: () => ({ ...mark }),
    start() {
      if (stopped || timers.length) return;
      const sweepTimer = setInterval(() => {
        trackMaintenance(sweep);
        trackMaintenance(settleRetained);
      }, policy.retryIntervalMs);
      sweepTimer.unref();
      const pruneTimer = setInterval(() => {
        trackMaintenance(prune);
      }, 60 * 60 * 1000);
      pruneTimer.unref();
      const jobTick=backgroundTask(async()=>{if(!stopped)await retryJobs.tick();});
      const jobTimer=setInterval(()=>{if(!stopped)trackMaintenance(jobTick);},1000);
      jobTimer.unref();
      timers.push(sweepTimer, pruneTimer,jobTimer);
    },
    stop() {
      stopped = true;
      for (const t of timers.splice(0)) clearInterval(t);
    },
    async drain() { while (maintenance.size) await Promise.allSettled([...maintenance]); },
  };
  activeController = controller;
  return controller;
}

function spoolPayload(body: Record<string, unknown>): HookPayload | null {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
  const hookType = str(body["hookType"]);
  const sessionId = str(body["sessionId"]);
  const project = str(body["project"]);
  const cwd = str(body["cwd"]);
  const timestamp = str(body["timestamp"]);
  if (!hookType || !sessionId || !project || !cwd || !timestamp) return null;
  return { hookType: hookType as HookPayload["hookType"], sessionId, project, cwd, timestamp, data: body["data"] };
}

function previewPayload(payload: HookPayload | undefined): string {
  if (!payload) return "";
  const d = payload.data && typeof payload.data === "object" ? (payload.data as Record<string, unknown>) : {};
  const label = typeof d["tool_name"] === "string" ? d["tool_name"] : payload.hookType;
  let text = "";
  try {
    text = JSON.stringify(d["tool_input"] ?? d["prompt"] ?? payload.data ?? "");
  } catch {}
  return `${label}: ${text}`.slice(0, 160);
}
