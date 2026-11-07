import {assertSdkSourceClaim,sdkSourceKeys,sdkObservationMatches,sdkSourceFailure,type SdkSourceClaim} from "../capture/sdk-source-restore.js";
import { TriggerAction, type IIIClient } from "iii-sdk";
import type { RawObservation, CompressedObservation, HookPayload, Origin, Session } from "../types.js";

const TOOL_HOOKS = new Set(["pre_tool_use", "post_tool_use", "post_tool_failure"]);
import { KV, generateId } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { emitLiveEvent } from "../viewer/live-events.js";
import { addSessionToProjectIndex } from "../state/session-index.js";
import { indexObservationSession } from "../state/obs-index.js";
import { normalizeCaptureData } from "./privacy.js";
import { DedupMap, recordDedupSkip } from "./dedup.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { getFinalizeIdleMs, isAutoCompressEnabled } from "../config.js";
import { buildSyntheticCompression } from "./compress-synthetic.js";
import { isCaptureKey } from "../capture/event-record.js";
import { claimBackfillPrompt, isBackfillPrompt, recordLivePrompt } from "../capture/prompt-ledger.js";
import { getSearchIndex, getVectorIndex, scheduleIndexSave, prepareObservationEmbedding } from "./search.js";
import { getAgentId } from "../config.js";
import { logger } from "../logger.js";
import { saveImageToDisk } from "../utils/image-store.js";
import { withoutObservationSource } from "./observation-source.js";
import { budgetLiveObservationSource } from "./observation-source-budget.js";
import { markCompressionDispatchFailed, pendingCompression } from "./compression-state.js";
import { requestSummaryRefresh } from "./summary-state.js";
import { scheduleSessionFinalize } from "./session-finalize.js";

export function extractImage(d: unknown): string | undefined {
  if (!d) return undefined;
  if (typeof d === "string") {
    if (d.startsWith("data:image/") || d.startsWith("iVBORw0KGgo") || d.startsWith("/9j/")) {
      return d;
    }
    return undefined;
  }
  if (typeof d === "object" && d !== null) {
    const obj = d as Record<string, unknown>;
    if (typeof obj["image_data"] === "string") return obj["image_data"];
    if (typeof obj["image_path"] === "string") return obj["image_path"];
    if (typeof obj["imageBase64"] === "string") return obj["imageBase64"];
    if (typeof obj["imagePath"] === "string") return obj["imagePath"];

    for (const key of Object.keys(obj)) {
      const match = extractImage(obj[key]);
      if (match) return match;
    }
  }
  return undefined;
}

async function prepareIndexEntries(obs: CompressedObservation, deferCertification = false): Promise<() => Promise<void>> {
  if (typeof obs.title !== "string" || !obs.sessionId) return async () => {};
  const search = getSearchIndex();
  if (!search.has(obs.id)) {
    search.add(obs);
    scheduleIndexSave();
  }
  const vectors = getVectorIndex();
  return vectors && !vectors.has(obs.id)
    ? prepareObservationEmbedding(obs.id, obs.sessionId, deferCertification)
    : async () => {};
}

export async function restoreIndexEntries(obs: CompressedObservation): Promise<void> {
  const certify = await prepareIndexEntries(obs);
  await certify();
}

export function registerObserveFunction(
  sdk: IIIClient,
  kv: StateKV,
  dedupMap?: DedupMap,
  maxObservationsPerSession?: number,
): void {
  sdk.registerFunction("mem::observe", 
    async (payload: HookPayload & {sdkSourceRestore?:SdkSourceClaim}) => {

      if (
        !payload?.sessionId ||
        typeof payload.sessionId !== "string" ||
        !payload.hookType ||
        typeof payload.hookType !== "string" ||
        !payload.timestamp ||
        typeof payload.timestamp !== "string"
      ) {
        return {
          success: false,
          error:
            "Invalid payload: sessionId, hookType, and timestamp are required",
        };
      }

      const durable =
        typeof payload.observationId === "string" && /^obs_[A-Za-z0-9_]{8,80}$/.test(payload.observationId);
      const obsId = durable ? payload.observationId! : generateId("obs");

      let dedupHash: string | undefined;
      if (dedupMap && typeof payload.eventId !== "string") {
        const dataIsObject =
          typeof payload.data === "object" && payload.data !== null;
        const d = dataIsObject
          ? (payload.data as Record<string, unknown>)
          : {};
        const toolName = (d["tool_name"] as string) || payload.hookType;
        // Hash the full payload when tool_input is absent so distinct
        // events never collapse onto one key.
        const dedupInput =
          d["tool_input"] !== undefined
            ? d["tool_input"]
            : dataIsObject
              ? d
              : payload.data;
        const dedupOutput =
          d["tool_input"] !== undefined
            ? d["tool_response"] ?? d["tool_output"] ?? d["output"] ?? d["error"]
            : undefined;
        dedupHash = dedupMap.computeHash(
          payload.sessionId,
          toolName,
          dedupInput,
          dedupOutput,
        );
        const duplicate = dedupMap.isDuplicate(dedupHash);
        const storedReplay = duplicate && durable
          ? await kv.get<CompressedObservation>(KV.observations(payload.sessionId), obsId)
          : undefined;
        if (duplicate && !storedReplay) {
          recordDedupSkip();
          return { deduplicated: true, sessionId: payload.sessionId };
        }
      }

      const sanitizedRaw = normalizeCaptureData(payload.data);

      let originChannel: Origin["channel"] = "agent";
      if (payload.hookType === "prompt_submit") originChannel = "user";
      else if (TOOL_HOOKS.has(payload.hookType)) originChannel = "tool";
      const raw: RawObservation = {
        id: obsId,
        sessionId: payload.sessionId,
        timestamp: payload.timestamp,
        hookType: payload.hookType,
        raw: sanitizedRaw,
        origin: {
          channel: originChannel,
          capturedAt: payload.timestamp,
        },
        ...(typeof payload.eventId === "string" ? { eventId: payload.eventId } : {}),
        ...(isCaptureKey(payload.captureKey) ? { captureKey: payload.captureKey } : {}),
      };

      let extractedImage: string | undefined;

      if (typeof sanitizedRaw === "object" && sanitizedRaw !== null) {
        const d = sanitizedRaw as Record<string, unknown>;
        if (TOOL_HOOKS.has(payload.hookType)) {
          raw.toolName = d["tool_name"] as string | undefined;
          raw.toolInput = d["tool_input"];
          raw.toolOutput = d["tool_output"] ?? d["error"];
          if (raw.origin && raw.toolName) raw.origin.detail = raw.toolName;
        }
        if (payload.hookType === "prompt_submit") {
          raw.userPrompt = d["prompt"] as string | undefined;
        }
        if (payload.hookType === "stop") {
          const response = d["assistant_response"] ?? d["last_assistant_message"] ?? d["response"];
          if (typeof response === "string") raw.assistantResponse = response;
          const originalBytes = d["last_assistant_message_bytes"];
          if (typeof originalBytes === "number" && Number.isSafeInteger(originalBytes) && originalBytes >= 0) {
            raw.assistantResponseBytes = originalBytes;
          }
        }

        extractedImage = extractImage(sanitizedRaw);
        if (extractedImage) {
          raw.modality = (raw.toolInput || raw.toolOutput || raw.userPrompt) ? "mixed" : "image";
        }
      } else if (typeof sanitizedRaw === "string") {
        extractedImage = extractImage(sanitizedRaw);
        if (extractedImage) {
          raw.modality = "image";
        }
      }

      const pendingImageData = extractedImage;
      const submittedPrompt =
        payload.hookType === "prompt_submit" && typeof raw.userPrompt === "string" ? raw.userPrompt : undefined;
      const backfillPrompt = submittedPrompt && isBackfillPrompt(payload.data) ? submittedPrompt : undefined;
      const livePrompt = submittedPrompt && !backfillPrompt ? submittedPrompt : undefined;
      const promptRef = durable || typeof payload.eventId !== "string" ? obsId : payload.eventId;

      const deferCertification = kv.backend !== "file" || typeof kv.durability?.watchKeys === "function";
      let certify: () => Promise<void> = async () => {};
      const result = await withKeyedLock(`obs:${payload.sessionId}`, async () => {
        // A timed-out capture can already be stored; replay must not scan the session again.
        const stored = durable ? await kv.get<CompressedObservation>(KV.observations(payload.sessionId), obsId) : undefined;
        if (stored) {
          if(payload.sdkSourceRestore&&!sdkObservationMatches(stored,payload,payload.sdkSourceRestore.key,obsId,payload.eventId!))throw sdkSourceFailure("SDK_SOURCE_CONFLICT");
          if (livePrompt) await recordLivePrompt(kv, payload.sessionId, livePrompt, promptRef);
          certify = await prepareIndexEntries(stored, deferCertification);
          return { observationId: obsId, deduplicated: true, existing: true };
        }
        const existing = kv.observationReader
          ? await kv.observationReader.captureSummary(KV.observations(payload.sessionId), obsId)
          : await kv.list<CompressedObservation>(KV.observations(payload.sessionId));
        if (backfillPrompt && (await claimBackfillPrompt(kv, payload.sessionId, backfillPrompt, promptRef))) {
          recordDedupSkip();
          return { deduplicated: true, sessionId: payload.sessionId };
        }
        if (!isCaptureKey(payload.captureKey) && maxObservationsPerSession && maxObservationsPerSession > 0) {
          if ((Array.isArray(existing) ? existing.length : existing.count) >= maxObservationsPerSession) {
            return {
              success: false,
              error: `Session observation limit reached (${maxObservationsPerSession})`,
            };
          }
        }

        // Existing session is the source of truth for agentId (even
        // undefined). Env AGENT_ID only fires when no session row
        // exists yet — otherwise an unscoped session would get
        // retroactively scoped by a later AGENT_ID export.
        const existingSession = await kv.get<{
          agentId?: string;
          observationCount?: number;
          firstPrompt?: string;
          status?: Session["status"];
        }>(KV.sessions, payload.sessionId);
        const inheritedAgentId = existingSession
          ? existingSession.agentId
          : getAgentId();
        if (inheritedAgentId) {
          raw.agentId = inheritedAgentId;
        }

        if (pendingImageData && (pendingImageData.startsWith("data:image/") || pendingImageData.startsWith("iVBORw0KGgo") || pendingImageData.startsWith("/9j/"))) {
          const { filePath, bytesWritten } = await saveImageToDisk(pendingImageData);
          raw.imageData = filePath;
          const { incrementImageRef } = await import("./image-refs.js");
          await incrementImageRef(kv, filePath);
          sdk.trigger({
            function_id: "mem::disk-size-delta",
            payload: { deltaBytes: bytesWritten },
            action: TriggerAction.Void(),
          });
          if (process.env["AGENTMEMORY_IMAGE_EMBEDDINGS"] === "true") {
            sdk.trigger({
              function_id: "mem::vision-embed",
              payload: {
                imageRef: filePath,
                sessionId: payload.sessionId,
                observationId: obsId,
              },
              action: TriggerAction.Void(),
            });
          }
        }

        const autoCompress = isAutoCompressEnabled();
        const finalizeIdleMs = getFinalizeIdleMs();
        if (!payload.sdkSourceRestore && existingSession && existingSession.status !== "active") {
          const dueAt = Date.now() + finalizeIdleMs;
          await requestSummaryRefresh(kv, payload.sessionId, dueAt);
          if (finalizeIdleMs > 0) await scheduleSessionFinalize(kv, payload.sessionId, dueAt);
        }
        let synthetic = budgetLiveObservationSource({ ...buildSyntheticCompression(raw), sourceRaw: raw }, existing);
        synthetic.syntheticCompression = withoutObservationSource(synthetic);
        if (autoCompress) synthetic.compression = pendingCompression();
        try {
          let restoreRaced:CompressedObservation|undefined;
          if(payload.sdkSourceRestore){
            const claim=payload.sdkSourceRestore;
            if(!kv.recoveryWrite)throw sdkSourceFailure('SDK_SOURCE_WRITER_UNVERIFIED');
            await kv.recoveryWrite.exclusive(sdkSourceKeys(payload,claim.key,obsId),async()=>{
              await assertSdkSourceClaim(kv,payload,claim);
              const current=await kv.get<CompressedObservation>(KV.observations(payload.sessionId),obsId);
              if(current){if(!sdkObservationMatches(current,payload,claim.key,obsId,payload.eventId!))throw sdkSourceFailure('SDK_SOURCE_CONFLICT');restoreRaced=current;return;}
              await kv.set(KV.observations(payload.sessionId),obsId,synthetic);
            });
          }else await kv.set(KV.observations(payload.sessionId), obsId, synthetic);
          if(restoreRaced){certify=await prepareIndexEntries(restoreRaced,deferCertification);return {observationId:obsId,deduplicated:true,existing:true};}
          await indexObservationSession(kv, obsId, payload.sessionId).catch(
            (err) => {
              logger.warn("observation index update failed", {
                obsId,
                sessionId: payload.sessionId,
                error: err instanceof Error ? err.message : String(err),
              });
            },
          );

        } catch (error) {
          if (raw.imageData) {
            // Roll back the ref taken above. decrementImageRef deletes the file
            // only when no other observation still references it (deduped images
            // survive) and emits the disk-size delta itself — deleting the file
            // directly here would orphan shared images and leave a stale ref.
            // If the rollback itself fails, log it but still surface the
            // original write error (the more useful failure to diagnose).
            try {
              const { decrementImageRef } = await import("./image-refs.js");
              await decrementImageRef(kv, sdk, raw.imageData);
            } catch (rollbackError) {
              logger.error("Failed to roll back image ref after observation write failure", {
                imageRef: raw.imageData,
                error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
              });
            }
          }
          throw error;
        }

        if (dedupMap && dedupHash) {
          dedupMap.record(dedupHash);
        }
        if (livePrompt) await recordLivePrompt(kv, payload.sessionId, livePrompt, promptRef);

        emitLiveEvent({
          id: `raw-${obsId}`,
          type: "raw_observation",
          data: { type: "raw", observation: { id: obsId, sessionId: payload.sessionId, timestamp: raw.timestamp, hookType: raw.hookType }, sessionId: payload.sessionId },
        });


        const session = existingSession;
        if (session) {
          const updates: Array<{ type: "set" | "remove"; path: string; value?: unknown }> = [
            ...(!payload.sdkSourceRestore ? [{ type: "set" as const, path: "updatedAt", value: new Date().toISOString() }] : []),
            {
              type: "set",
              path: "observationCount",
              value: payload.sdkSourceRestore?(Array.isArray(existing)?existing.length:existing.count)+1:(session.observationCount || 0) + 1,
            },
          ];
          if (!payload.sdkSourceRestore && session.status !== "active" && finalizeIdleMs > 0) {
            updates.push({ type: "set", path: "status", value: "active" });
            updates.push({ type: "remove", path: "endedAt" });
          }
          if (!payload.sdkSourceRestore && !session.firstPrompt && typeof raw.userPrompt === "string") {
            const trimmed = raw.userPrompt.replace(/\s+/g, " ").trim();
            if (trimmed.length > 0) {
              updates.push({
                type: "set",
                path: "firstPrompt",
                value: trimmed.slice(0, 200),
              });
            }
          }
          await kv.update(KV.sessions, payload.sessionId, updates);
        } else if (
          typeof payload.project === "string" &&
          payload.project.trim().length > 0 &&
          typeof payload.cwd === "string" &&
          payload.cwd.trim().length > 0
        ) {
          // OpenCode (and any plugin that skips POST /session/start)
          // can fire observations before the session record exists. Without
          // an implicit create, those observations stack up but
          // `memory_sessions` never lists them, and summarize bails with
          // "Session not found for summarize". Create the session now from
          // the observation payload — but only when project + cwd are
          // present (HookPayload contract). Older test payloads without
          // those fields keep their original no-op behaviour.
          const trimmedPrompt =
            typeof raw.userPrompt === "string"
              ? raw.userPrompt.replace(/\s+/g, " ").trim().slice(0, 200)
              : undefined;
          const ts = new Date().toISOString();
          const startedAt = payload.timestamp ?? ts;
          await kv.set(KV.sessions, payload.sessionId, {
            id: payload.sessionId,
            project: payload.project,
            cwd: payload.cwd,
            startedAt,
            updatedAt: ts,
            status: "active",
            observationCount: payload.sdkSourceRestore?(Array.isArray(existing)?existing.length:existing.count)+1:1,
            ...(inheritedAgentId ? { agentId: inheritedAgentId } : {}),
            ...(trimmedPrompt && trimmedPrompt.length > 0
              ? { firstPrompt: trimmedPrompt }
              : {}),
          });
          await addSessionToProjectIndex(kv, payload.project, {
            id: payload.sessionId,
            startedAt,
            ...(inheritedAgentId ? { agentId: inheritedAgentId } : {}),
          }).catch((err) => {
            logger.warn("session index update failed", {
              sessionId: payload.sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }

        synthetic = (await kv.get<CompressedObservation>(KV.observations(payload.sessionId), obsId))!;
        getSearchIndex().add(synthetic);
        scheduleIndexSave();
        emitLiveEvent({ id: `compressed-${obsId}`, type: "compressed_observation", data: { type: "compressed", observation: withoutObservationSource(synthetic), sessionId: payload.sessionId } });


        logger.info("Observation captured", {
          obsId,
          sessionId: payload.sessionId,
          hook: payload.hookType,
          compress: autoCompress ? "llm" : "synthetic",
        });
        certify = await prepareObservationEmbedding(synthetic.id, synthetic.sessionId, deferCertification);
        return { observationId: obsId };
      });
      await certify();
      return result;
    },
  );
}
