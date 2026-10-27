import type { IIIClient } from "iii-sdk";
import { randomUUID } from "node:crypto";
import type {
  CompressedObservation,
  SessionSummary,
  MemoryProvider,
  Session,
} from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import {
  SUMMARY_SYSTEM,
  buildSummaryPrompt,
  REDUCE_SYSTEM,
  buildReducePrompt,
} from "../prompts/summary.js";
import { getXmlTag, getXmlChildren } from "../prompts/xml.js";
import { SummaryOutputSchema } from "../eval/schemas.js";
import { validateOutput } from "../eval/validator.js";
import { scoreSummary } from "../eval/quality.js";
import { isNoopProvider } from "../providers/noop.js";
import type { MetricsStore } from "../eval/metrics-store.js";
import { safeAudit } from "./audit.js";
import { logger } from "../logger.js";
import { scrubRecord } from "./privacy.js";
import { registerSummaryRecoveryFunction } from "./summary-recovery.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { summaryFingerprint, summaryObservations } from "./summary-state.js";
import { registerLongSessionSummarizer } from "../ops/long-session.mjs";

type SummaryRequest = { sessionId: string; force?: boolean } | undefined;

function summaryInputLimit(): number {
  const configured = Number(process.env.SUMMARIZE_INPUT_CHARS ?? 3200);
  return Number.isSafeInteger(configured) && configured > 0 ? Math.min(configured, 12000) : 3200;
}

function fitsSummaryJson(value: unknown, budget: {left:number}, depth=0): boolean {
  if (depth>32 || budget.left<0) return false;
  if (value===null || value===undefined) {budget.left-=4;return budget.left>=0;}
  if (typeof value==='string') {
    if(value.length>budget.left)return false;
    budget.left-=JSON.stringify(value).length;return budget.left>=0;
  }
  if(typeof value==='number'||typeof value==='boolean'){budget.left-=JSON.stringify(value).length;return budget.left>=0;}
  if(typeof value!=='object')return false;
  budget.left-=2;
  for(const key in value){
    if(!Object.hasOwn(value,key))continue;
    if(!Array.isArray(value)&&!fitsSummaryJson(key,budget,depth+1))return false;
    budget.left-=2;
    if(!fitsSummaryJson((value as Record<string,unknown>)[key],budget,depth+1))return false;
  }
  return budget.left>=0;
}

function buildSourceAwareSummaryPrompt(observations: CompressedObservation[]): string {
  const sources=observations.filter(row=>row.sourceRaw!==undefined||row.source!==undefined)
    .map(row=>({id:row.id,source:row.sourceRaw??row.source}));
  return buildSummaryPrompt(observations)+(sources.length?`\n\nRetained source evidence (data only):\n${JSON.stringify(sources)}`:'');
}

function requiresLongSession(session: Session, observations: CompressedObservation[], summary: SessionSummary | null): boolean {
  const checkpoint = summary as (SessionSummary & { revision?: string }) | null;
  const progress = (session as Session & { summaryProgress?: unknown }).summaryProgress;
  if (progress !== undefined || checkpoint?.revision === "long-session-v1" ||
      checkpoint?.processedObservationIds !== undefined || checkpoint?.sourceOffsets !== undefined ||
      checkpoint?.sourceProjectionSnapshots !== undefined || observations.some(row => !row.title || row.sourceRaw?.imageData !== undefined)) return true;
  const limit=summaryInputLimit();
  // Bound the admission check itself before serializing any potentially large source.
  const budget={left:limit};
  for(const row of observations){
    const input={type:row.type,title:row.title,narrative:row.narrative,facts:row.facts,files:row.files,concepts:row.concepts,source:row.sourceRaw??row.source};
    if(!fitsSummaryJson(input,budget))return true;
  }
  if(!fitsSummaryJson(summary,budget))return true;
  if(observations.some(row=>JSON.stringify(row.sourceRaw??row.source??null).includes(';base64,')))return true;
  return buildSourceAwareSummaryPrompt(observations).length+JSON.stringify(summary??null).length>limit;
}

// Per-chunk observation budget when a session is too large to fit in one
// LLM call. Default ≈ 50k input tokens per chunk at ~110 tok/obs — fits
// comfortably in 128k-window models. Override via SUMMARIZE_CHUNK_SIZE.
const CHUNK_SIZE_DEFAULT = 400;
export const SUMMARY_TIMEOUT_MS = 120_000;
// Concurrent chunk calls share the summary deadline. Increase this for
// large sessions only when the configured provider supports the load.
const CHUNK_CONCURRENCY_DEFAULT = 6;
// Bail on the merged summary if more than this fraction of chunks fail
// to parse — a half-blind narrative is worse than a clean error.
const MAX_SKIP_RATIO = 0.5;

function getChunkSize(): number {
  const raw = process.env.SUMMARIZE_CHUNK_SIZE;
  if (!raw) return CHUNK_SIZE_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : CHUNK_SIZE_DEFAULT;
}

function getChunkConcurrency(): number {
  const raw = process.env.SUMMARIZE_CHUNK_CONCURRENCY;
  if (!raw) return CHUNK_CONCURRENCY_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : CHUNK_CONCURRENCY_DEFAULT;
}

// One chunk call with retry-once. Returns null when both attempts fail —
// whether by parse failure, provider 4xx (content rejected by upstream
// filters), or transient network/5xx errors that didn't recover on retry.
// All failure modes are equivalent at this layer: the chunk is unusable,
// skip it and let the caller decide via the skip-ratio bailout whether
// the overall summary is still trustworthy. Errors that affect every
// chunk (auth, model down) will trip the bailout naturally.
async function summarizeChunkWithRetry(
  provider: MemoryProvider,
  chunk: CompressedObservation[],
  sessionId: string,
  project: string,
  idx: number,
  total: number,
): Promise<SessionSummary | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const xml = await provider.summarize(
        SUMMARY_SYSTEM,
        buildSourceAwareSummaryPrompt(chunk),
      );
      const parsed = parseSummaryXml(xml, sessionId, project, chunk.length);
      if (parsed) return parsed;
      logger.warn("Summarize chunk parse failed", {
        sessionId,
        chunk: `${idx + 1}/${total}`,
        attempt,
      });
    } catch (err) {
      logger.warn("Summarize chunk LLM call failed", {
        sessionId,
        chunk: `${idx + 1}/${total}`,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return null;
}

// Returns the final summary XML string. For sessions ≤ chunk size, this is
// a single LLM call (legacy behavior). For larger sessions, observations
// are split into chunks processed in parallel batches, each chunk retried
// once on parse failure, persistently-bad chunks skipped, and remaining
// partials merged via a reduce call.
export async function produceSummaryXml(
  provider: MemoryProvider,
  compressed: CompressedObservation[],
  sessionId: string,
  project: string,
): Promise<{
  response: string;
  mode: "single" | "chunked";
  chunks: number;
  skipped?: number;
}> {
  const chunkSize = getChunkSize();
  if (compressed.length <= chunkSize) {
    const response = await provider.summarize(
      SUMMARY_SYSTEM,
      buildSourceAwareSummaryPrompt(compressed),
    );
    return { response, mode: "single", chunks: 1 };
  }

  const chunks: CompressedObservation[][] = [];
  for (let i = 0; i < compressed.length; i += chunkSize) {
    chunks.push(compressed.slice(i, i + chunkSize));
  }
  const concurrency = getChunkConcurrency();
  logger.info("Summarize chunking session", {
    sessionId,
    chunks: chunks.length,
    chunkSize,
    concurrency,
    totalObservations: compressed.length,
  });

  // Sparse array preserves chunk → index mapping after parallel resolution,
  // so the reduce step sees partials in chronological order even when some
  // were skipped.
  const partialByIdx: Array<SessionSummary | null> = new Array(chunks.length).fill(null);
  for (let batchStart = 0; batchStart < chunks.length; batchStart += concurrency) {
    const batch = chunks.slice(batchStart, batchStart + concurrency);
    await Promise.all(
      batch.map(async (chunk, j) => {
        const idx = batchStart + j;
        partialByIdx[idx] = await summarizeChunkWithRetry(
          provider,
          chunk,
          sessionId,
          project,
          idx,
          chunks.length,
        );
      }),
    );
  }

  const skipped = partialByIdx.filter((p) => p === null).length;
  const partials = partialByIdx.filter((p): p is SessionSummary => p !== null);

  if (skipped > Math.floor(chunks.length * MAX_SKIP_RATIO)) {
    throw new Error(
      `too_many_chunks_skipped: ${skipped}/${chunks.length} chunks failed to parse after retry`,
    );
  }
  if (skipped > 0) {
    logger.warn("Summarize chunks partially skipped", {
      sessionId,
      skipped,
      total: chunks.length,
    });
  }

  const reduceInput = partials.map((p) => {
    const originalIdx = partialByIdx.indexOf(p);
    return {
      title: p.title,
      narrative: p.narrative,
      keyDecisions: p.keyDecisions,
      filesModified: p.filesModified,
      concepts: p.concepts,
      obsRangeStart: originalIdx * chunkSize + 1,
      obsRangeEnd: Math.min((originalIdx + 1) * chunkSize, compressed.length),
    };
  });
  const response = await provider.summarize(
    REDUCE_SYSTEM,
    buildReducePrompt(reduceInput),
  );
  return { response, mode: "chunked", chunks: chunks.length, skipped };
}

function stripXmlWrappers(raw: string): string {
  if (!raw) return "";
  let cleaned = raw.trim();
  // ```xml ... ``` or ``` ... ``` fences (anywhere in the payload).
  cleaned = cleaned.replace(/```\s*xml\s*\n?/gi, "");
  cleaned = cleaned.replace(/```/g, "");
  cleaned = cleaned.trim();
  // If preamble / postamble surrounds the XML root, peel it off.
  const rootMatch = cleaned.match(
    /(<[a-zA-Z_][a-zA-Z0-9_-]*>[\s\S]*<\/[a-zA-Z_][a-zA-Z0-9_-]*>)/,
  );
  if (rootMatch && rootMatch[1]) return rootMatch[1].trim();
  return cleaned;
}

function parseSummaryXml(
  xml: string,
  sessionId: string,
  project: string,
  obsCount: number,
): SessionSummary | null {
  if(xml.trim().startsWith('{')){
    try {
      const parsed=JSON.parse(xml);
      const content={title:parsed.title,narrative:parsed.narrative,keyDecisions:parsed.keyDecisions,filesModified:parsed.filesModified,concepts:parsed.concepts};
      if(!validateOutput(SummaryOutputSchema,content,'mem::summarize').valid)return null;
      return {sessionId,project,createdAt:new Date().toISOString(),observationCount:obsCount,...content};
    }catch{return null;}
  }
  const cleaned = stripXmlWrappers(xml);
  const title = getXmlTag(cleaned, "title");
  if (!title) return null;

  return {
    sessionId,
    project,
    createdAt: new Date().toISOString(),
    title,
    narrative: getXmlTag(cleaned, "narrative"),
    keyDecisions: getXmlChildren(cleaned, "decisions", "decision"),
    filesModified: getXmlChildren(cleaned, "files", "file"),
    concepts: getXmlChildren(cleaned, "concepts", "concept"),
    observationCount: obsCount,
  };
}

function visibleAt(observation: CompressedObservation): string {
  return observation.compressedAt ?? observation.timestamp;
}

async function reduceWithExisting(
  provider: MemoryProvider,
  existing: SessionSummary,
  delta: SessionSummary,
  total: number,
): Promise<string> {
  const existingEnd = Math.max(1, total - delta.observationCount);
  const partial = (s: SessionSummary, obsRangeStart: number, obsRangeEnd: number) => ({
    title: s.title,
    narrative: s.narrative,
    keyDecisions: s.keyDecisions,
    filesModified: s.filesModified,
    concepts: s.concepts,
    obsRangeStart,
    obsRangeEnd,
  });
  return provider.summarize(
    REDUCE_SYSTEM,
    buildReducePrompt([
      partial(existing, 1, existingEnd),
      partial(delta, existingEnd + 1, total),
    ]),
  );
}

export function registerSummarizeFunction(
  sdk: IIIClient,
  kv: StateKV,
  provider: MemoryProvider,
  metricsStore?: MetricsStore,
  options: { schedule?: boolean; onWorker?: (handle: unknown) => void } = {},
) {
  registerSummaryRecoveryFunction(sdk, kv, () => !isNoopProvider(provider));
  let longSessionSummarize: ((data: SummaryRequest) => Promise<unknown>) | undefined;
  const longSessionSdk = new Proxy(sdk, {
    get(target, key) {
      if (key === "registerFunction") return (id: string, handler: typeof longSessionSummarize) => {
        if (id !== "mem::summarize") throw new Error("unexpected_long_session_registration");
        longSessionSummarize = handler;
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const deps = { KV, withKeyedLock, logger, safeAudit, scrubRecord, summaryFingerprint, summaryObservations, ...options, onWorker: undefined };
  const longSessionHandle = registerLongSessionSummarizer(longSessionSdk, kv, provider, metricsStore, deps);
  const activeSummaries = new Set<Promise<unknown>>();
  const incrementalSummarize = longSessionSummarize;
  if (!incrementalSummarize) throw new Error("long_session_handler_unregistered");
  const lockPrefix = `summary:${randomUUID()}`;
  const summarize = async (data: { sessionId: string; force?: boolean } | undefined) => {
      if (longSessionHandle.snapshot().stopped) return {success:true,deferred:true,reason:"shutting_down",retained:true};
      const startMs = Date.now();
      if (!data || typeof data.sessionId !== "string" || !data.sessionId.trim()) {
        return { success: false, error: "sessionId is required" };
      }
      const sessionId = data.sessionId.trim();

      const session = await kv.get<Session>(KV.sessions, sessionId);
      if (!session) {
        logger.warn("Session not found for summarize", {
          sessionId,
        });
        return { success: false, error: "session_not_found" };
      }

      const observations = await kv.list<CompressedObservation>(
        KV.observations(sessionId),
      );
      const storedSummary = await kv.get<SessionSummary>(KV.summaries, sessionId);
      if (requiresLongSession(session, observations, storedSummary)) return incrementalSummarize(data);
      const compressed = summaryObservations(observations);

      if (compressed.length === 0) {
        logger.info("No observations to summarize", {
          sessionId,
        });
        return { success: false, error: "no_observations" };
      }

      const summaryRevision = JSON.stringify(storedSummary);
      const existing = data.force === true ? null : storedSummary;
      const fingerprint = summaryFingerprint(session, compressed);
      const coveredCount = existing?.observationCount ?? 0;
      const prefixMatches = existing?.coveredFingerprint && Number.isSafeInteger(coveredCount) &&
        coveredCount > 0 && coveredCount <= compressed.length &&
        summaryFingerprint(session, compressed.slice(0, coveredCount)) === existing.coveredFingerprint;
      if (existing && prefixMatches && coveredCount === compressed.length) {
        return { success: true, unchanged: true, summary: existing };
      }
      const incremental = existing && prefixMatches ? existing : null;
      const input = incremental ? compressed.slice(coveredCount) : compressed;
      const coveredThrough = visibleAt(compressed[compressed.length - 1]);

      if (isNoopProvider(provider)) {
        logger.info("Summarize skipped — no LLM provider configured", {
          sessionId,
        });
        return {
          success: false,
          error: "no_provider",
          retained: true,
          reason:
            "No LLM provider key set; Summarize is a no-op. Set ANTHROPIC_API_KEY (or GEMINI/OPENROUTER/MINIMAX) in ~/.agentmemory/.env to enable.",
        };
      }

      const boundedProvider: MemoryProvider = {
        name: provider.name,
        compress: (system, prompt) => provider.compress(system, prompt),
        summarize: async (system, prompt) => {
          if (longSessionHandle.snapshot().stopped) throw new Error("shutting_down");
          if (prompt.length > summaryInputLimit()) throw new Error("summary_input_budget_exceeded");
          const remaining = SUMMARY_TIMEOUT_MS - (Date.now() - startMs);
          if (remaining <= 0) throw new Error("summary_timeout");
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([provider.summarize(system, prompt), new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("summary_timeout")), remaining);
            })]);
          } finally { clearTimeout(timer); }
        },
      };
      try {
        let summary: SessionSummary | null = null;
        let response = "";
        let mode = "single";
        let chunks = 1;
        let incomplete = false;
        for (let attempt = 1; attempt <= 2; attempt++) {
          const produced = await produceSummaryXml(
            boundedProvider,
            input,
            sessionId,
            session.project,
          );
          response = produced.response;
          mode = incremental ? "incremental" : produced.mode;
          chunks = produced.chunks;
          incomplete = (produced.skipped ?? 0) > 0;
          if (!response || !response.trim()) {
            logger.warn("Empty provider response on summarize", {
              sessionId,
              provider: provider.name,
              mode,
              chunks,
              observationCount: input.length,
              attempt,
            });
            continue;
          }
          summary = parseSummaryXml(
            response,
            sessionId,
            session.project,
            input.length,
          );
          if (summary && incremental) {
            response = await reduceWithExisting(boundedProvider, incremental, summary, compressed.length);
            summary = parseSummaryXml(response, sessionId, session.project, compressed.length);
          }
          if (summary) break;
          logger.warn("Failed to parse summary XML", { sessionId, attempt });
        }

        if (!response || !response.trim()) {
          const latencyMs = Date.now() - startMs;
          if (metricsStore) {
            await metricsStore.record("mem::summarize", latencyMs, false);
          }
          return { success: false, error: "empty_provider_response" };
        }

        if (!summary) {
          const latencyMs = Date.now() - startMs;
          if (metricsStore) {
            await metricsStore.record("mem::summarize", latencyMs, false);
          }
          return { success: false, error: "parse_failed" };
        }
        summary = scrubRecord({ ...summary, observationCount: compressed.length,
          ...(!incomplete ? { coveredThrough, coveredFingerprint: fingerprint } : {}),
        });

        const summaryForValidation = {
          title: summary.title,
          narrative: summary.narrative,
          keyDecisions: summary.keyDecisions,
          filesModified: summary.filesModified,
          concepts: summary.concepts,
        };
        const validation = validateOutput(
          SummaryOutputSchema,
          summaryForValidation,
          "mem::summarize",
        );

        if (!validation.valid) {
          const latencyMs = Date.now() - startMs;
          if (metricsStore) {
            await metricsStore.record("mem::summarize", latencyMs, false);
          }
          logger.warn("Summary validation failed", {
            sessionId,
            errors: validation.result.errors,
          });
          return { success: false, error: "validation_failed" };
        }

        const qualityScore = scoreSummary(summaryForValidation);

        const published = await withKeyedLock(`obs:${sessionId}`, async () => {
          const currentSession = await kv.get<Session>(KV.sessions, sessionId);
          if (!currentSession || currentSession.id !== sessionId) return false;
          const currentRows = await kv.list<CompressedObservation>(KV.observations(sessionId));
          const currentSummary = await kv.get<SessionSummary>(KV.summaries, sessionId);
          if (requiresLongSession(currentSession, currentRows, currentSummary)) return false;
          const currentObservations = summaryObservations(currentRows);
          if (summaryFingerprint(currentSession, currentObservations) !== fingerprint ||
              JSON.stringify(currentSummary) !== summaryRevision) return false;
          await kv.set(KV.summaries, sessionId, summary);
          return true;
        });
        if (!published) return { success: false, error: "source_changed" };
        await safeAudit(kv, "compress", "mem::summarize", [sessionId], {
          title: summary.title,
          observationCount: compressed.length,
          newObservations: input.length,
        });

        const latencyMs = Date.now() - startMs;
        if (metricsStore) {
          await metricsStore.record(
            "mem::summarize",
            latencyMs,
            true,
            qualityScore,
          );
        }

        logger.info("Session summarized", {
          sessionId,
          title: summary.title,
          decisions: summary.keyDecisions.length,
          qualityScore,
          valid: validation.valid,
        });

        return { success: true, summary, qualityScore, incremental: incremental !== null, ...(incomplete ? { incomplete: true } : {}) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const latencyMs = Date.now() - startMs;
        if (metricsStore) {
          await metricsStore.record("mem::summarize", latencyMs, false);
        }
        logger.error("Summarize failed", {
          sessionId,
          error: msg,
        });
        return { success: false, error: msg };
      }
    };
  const dispatch = async (data: SummaryRequest) => {
    if (longSessionHandle.snapshot().stopped) return {success:true,deferred:true,reason:"shutting_down",retained:true};
    if (typeof data?.sessionId !== "string" || !data.sessionId.trim()) return summarize(data);
    const sessionId = data.sessionId.trim();
    const session = await kv.get<Session>(KV.sessions, sessionId);
    if (!session) return summarize(data);
    const observations = await kv.list<CompressedObservation>(KV.observations(sessionId));
    const storedSummary = await kv.get<SessionSummary>(KV.summaries, sessionId);
    // Keep the incremental worker's immediate coalescing outside the XML lock.
    if (requiresLongSession(session, observations, storedSummary)) return incrementalSummarize(data);
    return withKeyedLock(`${lockPrefix}:${sessionId}`, () => summarize(data));
  };
  sdk.registerFunction("mem::summarize", (data: SummaryRequest) => {
    const task = dispatch(data);
    activeSummaries.add(task);
    void task.finally(() => activeSummaries.delete(task)).catch(() => {});
    return task;
  });
  const handle = {
    ...longSessionHandle,
    stop: async () => { const closing = longSessionHandle.stop(); await Promise.allSettled([closing,...activeSummaries]); },
    drain: async () => { await Promise.allSettled([longSessionHandle.drain(),...activeSummaries]); },
    snapshot: () => { const state=longSessionHandle.snapshot(); return {...state,running:Math.max(state.running,activeSummaries.size)}; },
  };
  options.onWorker?.(handle);
  return handle;
}
