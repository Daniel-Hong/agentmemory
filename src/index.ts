import {createEngineEpochEvidence} from "./ops/engine-epoch.mjs";
import {acquireFileWriterLease,markFileWriterClean,ownsFileWriterLease} from "./ops/file-writer-lease.mjs";
import { createBackgroundControl, installBackgroundControl, controlBackgroundFunctions, registerBackgroundControlApi } from "./ops/background-control.mjs";
import { createMemoryPressureGuard } from "./ops/memory-pressure.mjs";
import { serializeLongSessionProvider } from "./ops/long-session.mjs";
import { registerEnrichmentWorker } from "./ops/background-enrichment.mjs";
import { createFeatureLifecycle, registerScopedSlotFunctions } from "./ops/feature-lifecycle.mjs";
import { createDashboardUpdates, registerDashboardUpdateApi } from "./ops/dashboard-updates.mjs";
import { registerFeedbackRuntime } from "./feedback/feedback-runtime.mjs";
import { registerCodexInspection, collectInspectionContext, codexInspectionArgs } from "./ops/codex-inspection.mjs";
import { rawFromObservationSource } from "./functions/observation-source.js";
import { recordAudit } from "./functions/audit.js";
import { operationalState } from "./ops/context.js";
import { createOllamaReadiness, type OllamaReadiness } from "./ops/provider-readiness.mjs";
import type { MemoryProvider } from "./types.js";
import { verifiedShutdown } from "./ops/verified-shutdown.js";
import { createShutdownIngress } from "./ops/shutdown-ingress.mjs";
import { createBackgroundLifecycle, registerBackgroundInterval } from "./ops/background-lifecycle.mjs";
import { closeLongSessionInferenceAdmission } from "./ops/long-session.mjs";
import { registerWorker } from "iii-sdk";
import {
  hydrateProcessEnvFromFile,
  loadConfig,
  getEnvVar,
  loadEmbeddingConfig,
  loadFallbackConfig,
  loadClaudeBridgeConfig,
  loadTeamConfig,
  loadSnapshotConfig,
  isGraphExtractionEnabled,
  isAutoCompressEnabled,
  isConsolidationEnabled,
  getConsolidationIntervalMs,
  isContextInjectionEnabled,
  isDropStaleIndexEnabled,
  getVectorBackfillMax,
  getAuditRetentionMonths,
  getStateBackend,
  isSessionSweepEnabled,
  isGraphCompactOnBootEnabled,
  getSessionSweepStaleHours,
} from "./config.js";
import {
  createProvider,
  createFallbackProvider,
  createEmbeddingProvider,
  createImageEmbeddingProvider,
} from "./providers/index.js";
import { KV } from "./state/schema.js";
import { withKeyedLock } from "./state/keyed-mutex.js";
import { StateKV } from "./state/kv.js";
import { VectorIndex } from "./state/vector-index.js";
import { HybridSearch } from "./state/hybrid-search.js";
import { registerEmbeddingRecovery } from "./ops/embedding-recovery.mjs";
import { createEmbeddingReceiptStatus } from "./ops/embedding-receipt-status.mjs";
import { IndexPersistence, type VectorPublication } from "./state/index-persistence.js";
import { SHUTDOWN_FLUSH_TIMEOUT_MS, settleWithin } from "./shutdown.js";
import { registerPrivacyFunction, withWriteScrubbing } from "./functions/privacy.js";
import { registerObserveFunction } from "./functions/observe.js";
import { registerCaptureFunctions } from "./functions/capture.js";
import { seedViewerStreamTracker } from "./state/viewer-stream.js";
import { registerImageQuotaCleanup } from "./functions/image-quota-cleanup.js";
import { registerVisionSearchFunctions } from "./functions/vision-search.js";
import { DEFAULT_SLOTS, isSlotsEnabled, isReflectEnabled } from "./functions/slots.js";
import { registerDiskSizeManager } from "./functions/disk-size-manager.js";
import { registerCompressFunction } from "./functions/compress.js";
import {
  registerSearchFunction,
  backfillVectors,
  backfillVectorBacklog,
  isBm25RebuildIncomplete,
  rebuildKeywordIndex,
  markKeywordRebuildPending,
  getSearchIndex,
  setVectorIndex,
  setEmbeddingProvider,
  setIndexPersistence,
  setEmbeddingRecovery,
  setHybridRanker,
  setPendingVectorBackfillCount,
  setVectorBackfillState,
  getPendingVectorBackfillCount,
} from "./functions/search.js";
import { registerContextFunction } from "./functions/context.js";
import { registerSessionIndexMaintenanceFunction } from "./functions/session-index-maintenance.js";
import { rebuildSessionIndexIfStale } from "./state/session-index.js";
import { registerSummarizeFunction } from "./functions/summarize.js";
import { registerMigrateFunction } from "./functions/migrate.js";
import { registerFileIndexFunction } from "./functions/file-index.js";
import { registerConsolidateFunction } from "./functions/consolidate.js";
import { registerPatternsFunction } from "./functions/patterns.js";
import { registerRememberFunction } from "./functions/remember.js";
import { registerEvictFunction } from "./functions/evict.js";
import { registerRelationsFunction } from "./functions/relations.js";
import { registerTimelineFunction } from "./functions/timeline.js";
import { registerSmartSearchFunction } from "./functions/smart-search.js";
import { registerRecentSearchesSweepFunction } from "./functions/recent-searches-sweep.js";
import { registerSessionSweepFunction } from "./functions/session-sweep.js";
import { registerProfileFunction } from "./functions/profile.js";
import { registerAutoForgetFunction } from "./functions/auto-forget.js";
import { registerExportImportFunction } from "./functions/export-import.js";
import { registerEnrichFunction } from "./functions/enrich.js";
import { registerClaudeBridgeFunction } from "./functions/claude-bridge.js";
import { registerGraphFunction } from "./functions/graph.js";
import { createGraphCompactBootRecovery, setGraphCompactBootDisabled } from "./functions/graph-compact-boot.js";
import { registerGraphImportFunction } from "./functions/graph-import.js";
import { registerConsolidationPipelineFunction } from "./functions/consolidation-pipeline.js";
import { registerTeamFunction } from "./functions/team.js";
import { registerGovernanceFunction } from "./functions/governance.js";
import { registerSnapshotFunction } from "./functions/snapshot.js";
import { registerActionsFunction } from "./functions/actions.js";
import { registerFrontierFunction } from "./functions/frontier.js";
import { registerLeasesFunction } from "./functions/leases.js";
import { registerRoutinesFunction } from "./functions/routines.js";
import { registerSignalsFunction } from "./functions/signals.js";
import { registerCheckpointsFunction } from "./functions/checkpoints.js";
import { registerFlowCompressFunction } from "./functions/flow-compress.js";
import { registerMeshFunction } from "./functions/mesh.js";
import { registerBranchAwareFunction } from "./functions/branch-aware.js";
import { registerSentinelsFunction } from "./functions/sentinels.js";
import { registerSketchesFunction } from "./functions/sketches.js";
import { registerCrystallizeFunction } from "./functions/crystallize.js";
import { registerDiagnosticsFunction } from "./functions/diagnostics.js";
import { registerFacetsFunction } from "./functions/facets.js";
import { registerVerifyFunction } from "./functions/verify.js";
import { registerCascadeFunction } from "./functions/cascade.js";
import { registerLessonsFunctions } from "./functions/lessons.js";
import { registerObsidianExportFunction } from "./functions/obsidian-export.js";
import { registerReflectFunctions } from "./functions/reflect.js";
import { registerWorkingMemoryFunctions } from "./functions/working-memory.js";
import { registerSkillExtractFunctions } from "./functions/skill-extract.js";
import { registerSlidingWindowFunction } from "./functions/sliding-window.js";
import { registerQueryExpansionFunction } from "./functions/query-expansion.js";
import { registerTemporalGraphFunctions } from "./functions/temporal-graph.js";
import { registerRetentionFunctions } from "./functions/retention.js";
import { startAuditMigration } from "./functions/audit.js";
import { registerCompressFileFunction } from "./functions/compress-file.js";
import { registerReplayFunctions } from "./functions/replay.js";
import { checkAuth, registerApiTriggers } from "./triggers/api.js";
import { registerEventTriggers } from "./triggers/events.js";
import { registerViewerStreamTriggers } from "./triggers/viewer-streams.js";
import { registerMcpEndpoints } from "./mcp/server.js";
import { getAllTools } from "./mcp/tools-registry.js";
import { startViewerServer } from "./viewer/server.js";
import { MetricsStore } from "./eval/metrics-store.js";
import { DedupMap } from "./functions/dedup.js";
import { registerHealthMonitor } from "./health/monitor.js";
import { createStreamRelayProbe } from "./health/stream-relay-probe.js";
import { initMetrics, OTEL_CONFIG } from "./telemetry/setup.js";
import { VERSION } from "./version.js";
import { logger, bootLog, bootWarn } from "./logger.js";
import { runtimeMetadataPath } from "./runtime-paths.js";
import { ensureServerSecret, explicitSecret, secretFilePath } from "./secret-store.js";
import { mkdirSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

function workerPidfilePath(): string {
  return runtimeMetadataPath("worker.pid");
}
function writeWorkerPidfile(): void {
  try {
    const p = workerPidfilePath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${process.pid}\n`, { encoding: "utf-8" });
  } catch {
    // best-effort; stop still has the engine pidfile + port scan fallback
  }
}
function clearWorkerPidfile(): void {
  try {
    unlinkSync(workerPidfilePath());
  } catch {}
}

function hasGetMeter(
  sdk: unknown,
): sdk is { getMeter: (name: string) => unknown } {
  return (
    typeof sdk === "object" &&
    sdk !== null &&
    "getMeter" in sdk &&
    typeof (sdk as { getMeter?: unknown }).getMeter === "function"
  );
}

let lastUnhandledLogAt = 0;
process.on("unhandledRejection", (reason) => {
  const now = Date.now();
  if (now - lastUnhandledLogAt < 60_000) return;
  lastUnhandledLogAt = now;
  const r = reason as { code?: string; function_id?: string; message?: string };
  console.warn(
    `[agentmemory] unhandledRejection (suppressed):`,
    r?.code ? `${r.code} ${r.function_id ?? ""} ${r.message ?? ""}`.trim() : reason,
  );
});

function resolveWorkerSecret(): string {
  try {
    const { secret, source } = ensureServerSecret();
    if (source === "generated") {
      bootLog(`Generated an API secret at ${secretFilePath()} (mode 0600). Local clients read it automatically.`);
    }
    return secret;
  } catch (err) {
    throw new Error(
      `agentmemory could not create its API secret at ${secretFilePath()}: ${err instanceof Error ? err.message : String(err)}. Set AGENTMEMORY_SECRET explicitly or make the directory writable.`,
    );
  }
}

let fatalShutdown: (() => Promise<void>) | undefined;

async function main() {
  // Fold ~/.agentmemory/.env into process.env before anything reads config
  // or raw process.env. Only-if-unset, so real process.env still wins.
  hydrateProcessEnvFromFile();

  const config = loadConfig();
  const embeddingConfig = loadEmbeddingConfig();
  const fallbackConfig = loadFallbackConfig();

  const provider = serializeLongSessionProvider(
    fallbackConfig.providers.length > 0
      ? createFallbackProvider(config.provider, fallbackConfig)
      : createProvider(config.provider), withKeyedLock);

  const embeddingProvider = serializeLongSessionProvider(createEmbeddingProvider(), withKeyedLock);
  const imageEmbeddingProvider = serializeLongSessionProvider(createImageEmbeddingProvider(), withKeyedLock);

  bootLog(`Starting worker v${VERSION}...`);
  bootLog(`Engine: ${config.engineUrl}`);
  bootLog(
    `Provider: ${config.provider.provider} (${config.provider.model})`,
  );
  if (embeddingProvider) {
    bootLog(
      `Embedding provider: ${embeddingProvider.name} (${embeddingProvider.dimensions} dims)`,
    );
  } else {
    bootLog(`Embedding provider: none (BM25-only mode)`);
  }
  if (imageEmbeddingProvider) {
    bootLog(
      `Image embedding provider: ${imageEmbeddingProvider.name} (${imageEmbeddingProvider.dimensions} dims) — vision-search active`,
    );
  }
  bootLog(
    `REST API: http://localhost:${config.restPort}/agentmemory/*`,
  );
  bootLog(`Streams: ws://localhost:${config.streamsPort}`);

  const sdk = withWriteScrubbing(registerWorker(config.engineUrl, {
    workerName: "agentmemory",
    invocationTimeoutMs: 180000,
    otel: {
      serviceName: OTEL_CONFIG.serviceName,
      serviceVersion: OTEL_CONFIG.serviceVersion,
      metricsExportIntervalMs: OTEL_CONFIG.metricsExportIntervalMs,
    },
    // Explicit worker telemetry metadata. iii-sdk falls back to
    // auto-detection (cwd / package.json name / hostname) when this
    // is omitted, which produces inconsistent values per host —
    // `agentmemory`, `node`, `npm`, occasionally the user's home
    // directory basename. Pinning the value here gives every install
    // the same stable project identifier for downstream attribution
    // and grouping in the engine's metrics + traces output.
    telemetry: {
      project_name: "agentmemory",
      language: "node",
      framework: "iii-sdk",
    },
  }));


  let stateBackend: "file" | "redis" = "file";
  try {
    stateBackend = getStateBackend();
  } catch {}
  if (!process.env["AGENTMEMORY_STATE_STORE_PATH"] && process.env["AGENTMEMORY_DATA_DIR"]) process.env["AGENTMEMORY_STATE_STORE_PATH"] = join(process.env["AGENTMEMORY_DATA_DIR"], "state_store.db");
  const writerStorePath=process.env["AGENTMEMORY_STATE_STORE_PATH"];
  const engineEvidence=createEngineEpochEvidence({engineUrl:config.engineUrl,enginePidPath:runtimeMetadataPath("iii.pid"),peer:()=>{const socket=(sdk as unknown as {ws?:{_socket?:{remoteAddress?:string;remotePort?:number;localAddress?:string;localPort?:number}}}).ws?._socket;return socket?{remoteAddress:socket.remoteAddress,remotePort:socket.remotePort,localAddress:socket.localAddress,localPort:socket.localPort}:null;}});
  if(stateBackend==="file"&&writerStorePath&&process.platform==="linux"){const until=Date.now()+3000;while(!engineEvidence.capture()&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,25));}
  const writerLease=stateBackend==="file"&&writerStorePath&&process.platform==="linux"?acquireFileWriterLease(writerStorePath,{evidence:engineEvidence}):undefined;
  const kv = new StateKV(sdk, { backend: stateBackend,writerLease });
  writeWorkerPidfile();
  const secret = resolveWorkerSecret();
  const ingress = createShutdownIngress();
  const lifecycle = createBackgroundLifecycle(() => { ingress.close(); closeLongSessionInferenceAdmission(); });
  ingress.install(sdk, (req) => checkAuth(req, secret));
  const control = createBackgroundControl();
  const persistentBackground = kv.backend === "file" && !!kv.durability;
  if (persistentBackground) installBackgroundControl(control);
  operationalState.storageDurability = kv.durability;
  const resources: { health?: ReturnType<typeof registerHealthMonitor>; capture?: ReturnType<typeof registerCaptureFunctions>; index?: IndexPersistence; viewer?: ReturnType<typeof startViewerServer> } = {};
  let bootDone!: () => void, bootFailed = false;
  const bootGate = new Promise<void>(resolve => { bootDone = resolve; });
  let shuttingDown = false, shutdownPromise: Promise<void> | undefined;
  const shutdown = () => shutdownPromise ?? (shutdownPromise = performShutdown());
  async function performShutdown() {
    shuttingDown = true;
    ingress.close(); closeLongSessionInferenceAdmission();
    resources.health?.stop(); resources.capture?.stop(); resources.index?.stop();
    const outcome = await verifiedShutdown({
      receiptDir: dirname(runtimeMetadataPath("shutdown-receipt.json")),
      engineAlive: () => {
        try {
          const pid = Number(readFileSync(runtimeMetadataPath("iii.pid"), "utf8").trim());
          if (!Number.isSafeInteger(pid) || pid < 1) return null;
          process.kill(pid, 0); return true;
        } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : null; }
      },
      work: async progress => {
        progress({ stage: "boot_gate" }); await bootGate;
        let disk: unknown = null;
        await lifecycle.shutdown(async ({ drained }) => {
          progress({ stage: "ingress" }); await ingress.drain();
          progress({ stage: "control" }); await control.settled();
          progress({ stage: "index_save" }); await resources.index?.save();
          const index = resources.index?.status();
          if (index?.vector?.lastError || index?.pendingLogError || (index?.pendingChanges ?? 0) > 0)
            throw Object.assign(Error("index_save_unverified"), { code: "INDEX_SAVE_UNVERIFIED" });
          if (!kv.durability) throw Object.assign(Error("file_durability_unconfigured"), { code: "STATE_DURABILITY_UNCONFIGURED" });
          progress({ stage: "durability_drain" }); await kv.durability.drain();
          progress({ stage: "disk_fence" });
          const beforeGuard = await kv.durability.wait(kv);
          if (beforeGuard.synced !== true || beforeGuard.mutationFailures !== 0) throw Object.assign(Error("shutdown_storage_unverified"), { code: "SHUTDOWN_NOT_VERIFIED" });
          if (drained) { progress({ stage: "restart_guard" }); await control.commitCleanShutdown(); }
          progress({ stage: "freeze" }); kv.durability.freeze();
          progress({ stage: "final_disk_fence" }); disk = await kv.durability.wait(kv);
        }, progress);
        return disk;
      },
    });
    resources.viewer?.closeAllConnections();
    if (resources.viewer) await settleWithin(new Promise<void>(resolve => resources.viewer!.close(() => resolve())), SHUTDOWN_FLUSH_TIMEOUT_MS).catch(() => false);
    const sdkDrained=await settleWithin(sdk.shutdown(), SHUTDOWN_FLUSH_TIMEOUT_MS).catch(() => false);
    if(writerLease&&kv.recoveryMutationSafe&&outcome.verified&&!bootFailed&&sdkDrained&&!kv.mutationOutcomeUncertain){try{markFileWriterClean(writerLease);}catch{/* The dirty marker remains conservative on failure. */}}
    if (outcome.verified) clearWorkerPidfile();
    process.exit(outcome.verified && !bootFailed ? 0 : 1);
  }
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
  fatalShutdown = shutdown;
  function trackBoot<T>(promise: Promise<T>) { lifecycle.track({ drain: () => promise }); return promise; }
  try {
  if (persistentBackground) {
    await control.init(kv, () => lifecycle.drain());
    operationalState.backgroundControl = control;
    controlBackgroundFunctions(sdk);
  }
  const pressure = persistentBackground ? lifecycle.track(createMemoryPressureGuard({ control })) : null;
  pressure?.install(sdk, (req) => checkAuth(req, secret));
  operationalState.memoryPressure = pressure;
  await pressure?.refresh();
  const metricsStore = new MetricsStore(kv);
  if (getEnvVar("AGENTMEMORY_OLLAMA_NATIVE_CHAT")?.toLowerCase() === "true" && fallbackConfig.providers.length > 0)
    throw new Error("ollama_native_fallback_unsupported");
  if (config.provider.provider === "openai" && fallbackConfig.providers.length === 0 && getEnvVar("AGENTMEMORY_OLLAMA_NATIVE_CHAT")?.toLowerCase() === "true") {
    const baseUrl = config.provider.baseURL || getEnvVar("OPENAI_BASE_URL");
    if (!baseUrl) throw new Error("ollama_native_base_url_required");
    const readiness = lifecycle.track(createOllamaReadiness({
      baseUrl,
      models: [config.provider.model],
    }));
    operationalState.providerReadiness = readiness;
    (provider as MemoryProvider & { readiness?: OllamaReadiness }).readiness = readiness;
    readiness.start();
  }
  const dedupMap = lifecycle.track(new DedupMap());

  const vectorIndex = embeddingProvider ? new VectorIndex() : null;

  setVectorIndex(vectorIndex);
  setEmbeddingProvider(embeddingProvider);

  const meterAccessor = hasGetMeter(sdk)
    ? (sdk.getMeter.bind(sdk) as (name: string) => unknown)
    : undefined;

  initMetrics(meterAccessor as ((name: string) => import("@opentelemetry/api").Meter) | undefined);

  registerPrivacyFunction(sdk);
  registerObserveFunction(sdk, kv, dedupMap, config.maxObservationsPerSession);
  const capture = resources.capture = registerCaptureFunctions(sdk, kv, { restPort: config.restPort,autoRecovery:{enabled:process.env["AGENTMEMORY_AUTO_CAPTURE_RECOVERY"]==="true",writerOwned:()=>!!writerLease&&ownsFileWriterLease(writerLease,writerStorePath!),admitted:()=>!shuttingDown&&persistentBackground&&!control.isPaused()&&pressure?.snapshot().level==="normal",admissionReason:()=>{if(shuttingDown)return "SHUTTING_DOWN";const holds=control.snapshot().holds;if(holds.includes("storage_error"))return "HOLD_STORAGE_ERROR";if(holds.includes("manual"))return "HOLD_MANUAL";if(holds.includes("deployment"))return "HOLD_DEPLOYMENT";if(holds.includes("memory"))return "HOLD_MEMORY";if(pressure?.snapshot().level!=="normal")return "MEMORY_PRESSURE";return null;}} });
  operationalState.captureProgress = { snapshot: () => capture.progress() };
  registerImageQuotaCleanup(sdk, kv);
  registerVisionSearchFunctions(sdk, kv, imageEmbeddingProvider);
  if (isSlotsEnabled()) {
    await registerScopedSlotFunctions({sdk, kv, KV, withKeyedLock, defaults: DEFAULT_SLOTS, recordAudit});
  }
  registerDiskSizeManager(sdk, kv);
  registerCompressFunction(sdk, kv, provider, metricsStore);
  registerSearchFunction(sdk, kv);
  registerContextFunction(sdk, kv, config.tokenBudget);
  registerSessionIndexMaintenanceFunction(sdk, kv);
  void trackBoot(rebuildSessionIndexIfStale(kv)
    .then((result) => {
      if (result) {
        bootLog(
          `Session index rebuilt: ${result.projects} projects, ${result.sessions} sessions`,
        );
      }
    })
    .catch((err) => {
      console.warn(`[agentmemory] Failed to rebuild session index at boot:`, err);
    }));
  lifecycle.track(registerSummarizeFunction(sdk, kv, provider, metricsStore));
  registerMigrateFunction(sdk, kv);
  registerFileIndexFunction(sdk, kv);
  registerConsolidateFunction(sdk, kv, provider);
  registerPatternsFunction(sdk, kv);
  registerRememberFunction(sdk, kv);
  registerEvictFunction(sdk, kv);
  registerSessionSweepFunction(sdk, kv);

  registerRelationsFunction(sdk, kv);
  registerTimelineFunction(sdk, kv);
  registerProfileFunction(sdk, kv);
  registerAutoForgetFunction(sdk, kv);
  registerExportImportFunction(sdk, kv);
  registerEnrichFunction(sdk, kv);

  const claudeBridgeConfig = loadClaudeBridgeConfig();
  if (claudeBridgeConfig.enabled) {
    registerClaudeBridgeFunction(sdk, kv, claudeBridgeConfig);
    bootLog(
      `Claude bridge: syncing to ${claudeBridgeConfig.memoryFilePath}`,
    );
  }

  registerGraphFunction(sdk, kv, provider);
  registerGraphImportFunction(sdk, kv);
  bootLog(
    `Knowledge graph: structural extraction on (LLM relations ${isGraphExtractionEnabled() ? "enabled" : "off"})`,
  );

  registerConsolidationPipelineFunction(sdk, kv, provider);
  bootLog(`Consolidation pipeline: registered (CONSOLIDATION_ENABLED=${isConsolidationEnabled() ? "true" : "false"})`);

  if (isAutoCompressEnabled()) {
    bootLog(
      `WARNING: AGENTMEMORY_AUTO_COMPRESS=true — every PostToolUse observation will be sent to your LLM provider for compression. This spends API tokens proportional to your session tool-use frequency. Set AGENTMEMORY_AUTO_COMPRESS=false to disable.`,
    );
  } else {
    bootLog(
      `Auto-compress: OFF (default) — observations indexed via zero-LLM synthetic compression. Set AGENTMEMORY_AUTO_COMPRESS=true to opt-in to LLM-powered summaries (uses your API key).`,
    );
  }

  if (isContextInjectionEnabled()) {
    bootLog(
      `WARNING: AGENTMEMORY_INJECT_CONTEXT=true — the PreToolUse and SessionStart hooks will inject up to ~4000 chars of memory context into every tool turn. On Claude Pro this burns session tokens proportional to your tool-call frequency. Set AGENTMEMORY_INJECT_CONTEXT=false to disable.`,
    );
  } else {
    bootLog(
      `Context injection: OFF (default) — hooks capture observations but do not inject context into Claude Code's conversation. Set AGENTMEMORY_INJECT_CONTEXT=true to opt-in (warning: expect your Claude Pro allocation to drain faster).`,
    );
  }

  const teamConfig = loadTeamConfig();
  if (teamConfig) {
    registerTeamFunction(sdk, kv, teamConfig);
    bootLog(
      `Team memory: ${teamConfig.teamId} (${teamConfig.mode})`,
    );
  }

  registerGovernanceFunction(sdk, kv);

  registerActionsFunction(sdk, kv);
  registerFrontierFunction(sdk, kv);
  registerLeasesFunction(sdk, kv);
  registerRoutinesFunction(sdk, kv);
  registerSignalsFunction(sdk, kv);
  registerCheckpointsFunction(sdk, kv);
  registerMeshFunction(sdk, kv, explicitSecret() || undefined);
  registerBranchAwareFunction(sdk, kv);
  registerFlowCompressFunction(sdk, kv, provider);
  registerSentinelsFunction(sdk, kv);
  registerSketchesFunction(sdk, kv);
  registerCrystallizeFunction(sdk, kv, provider);
  registerDiagnosticsFunction(sdk, kv);
  registerFacetsFunction(sdk, kv);
  registerVerifyFunction(sdk, kv);
  registerLessonsFunctions(sdk, kv);
  registerObsidianExportFunction(sdk, kv);
  registerReflectFunctions(sdk, kv, provider);
  registerWorkingMemoryFunctions(sdk, kv, config.tokenBudget);
  registerSkillExtractFunctions(sdk, kv, provider);
  registerCascadeFunction(sdk, kv);

  registerSlidingWindowFunction(sdk, kv, provider);
  registerQueryExpansionFunction(sdk, provider);
  registerTemporalGraphFunctions(sdk, kv, provider);
  registerRetentionFunctions(sdk, kv);
  registerCompressFileFunction(sdk, kv, provider);
  registerReplayFunctions(sdk, kv);
  bootLog(
    `v0.6 advanced retrieval: sliding-window, query-expansion, temporal-graph, retention-scoring`,
  );
  bootLog(
    `Orchestration layer: actions, frontier, leases, routines, signals, checkpoints, flow-compress, mesh, branch-aware, sentinels, sketches, crystallize, diagnostics, facets`,
  );
  if (isSlotsEnabled()) {
    bootLog(
      `Slots: enabled (pinned editable memory). Reflect on Stop hook: ${isReflectEnabled() ? "on" : "off"}`,
    );
  }

  const snapshotConfig = loadSnapshotConfig();
  if (snapshotConfig.enabled) {
    operationalState.snapshotRecovery = lifecycle.track(registerSnapshotFunction(sdk, kv, snapshotConfig.dir, snapshotConfig.interval * 1000));
    bootLog(
      `Git snapshots: ${snapshotConfig.dir} (every ${snapshotConfig.interval}s)`,
    );
  }

  const features = lifecycle.track(createFeatureLifecycle({sdk, kv, KV, withKeyedLock, provider, readiness: operationalState.providerReadiness, isSlotsEnabled, isReflectEnabled, logger}));
  operationalState.featureLifecycle = features;
  sdk.registerFunction("mem::slot-reflect", features.slotReflect);
  lifecycle.track(registerEnrichmentWorker({kv, sdk, KV, withKeyedLock, isGraphEnabled: isGraphExtractionEnabled, isCompressEnabled: isAutoCompressEnabled, logger, metricsStore, readiness: operationalState.providerReadiness, rawFromObservationSource}));
  const bm25Index = getSearchIndex();
  const graphWeight = parseFloat(getEnvVar("AGENTMEMORY_GRAPH_WEIGHT") || "0.3");
  const hybridSearch = new HybridSearch(
    bm25Index,
    vectorIndex,
    embeddingProvider,
    kv,
    embeddingConfig.bm25Weight,
    embeddingConfig.vectorWeight,
    graphWeight,
  );

  const hybridRanker = (query: string, limit: number) =>
    hybridSearch.search(query, limit);
  registerSmartSearchFunction(sdk, kv, hybridRanker);
  setHybridRanker(hybridRanker);
  registerRecentSearchesSweepFunction(sdk, kv);

  markKeywordRebuildPending();
  registerApiTriggers(sdk, kv, secret, metricsStore, provider);
  registerDashboardUpdateApi(sdk, secret, createDashboardUpdates({requestRoot: runtimeMetadataPath("update-requests"), version: VERSION}));
  if (persistentBackground) registerBackgroundControlApi(sdk, secret, control);
  if (getEnvVar("AGENTMEMORY_FEEDBACK_DIR")) {
  const feedback = lifecycle.track(registerFeedbackRuntime(sdk, secret, {
    root: getEnvVar("AGENTMEMORY_FEEDBACK_DIR"),
    collect: () => collectInspectionContext(secret, {restPort: config.restPort}),
    args: codexInspectionArgs, isPaused: () => persistentBackground && control.isPaused(), version: VERSION,
    receiptRoot: getEnvVar("AGENTMEMORY_RECEIPT_DIR"),
    receipts: {"personal-deployment": "activation.json"},
  }));
  await feedback.ready;
  lifecycle.track(registerCodexInspection(sdk, secret, {restPort: config.restPort, onSnapshot: feedback.onSnapshot}));
  } else {
    lifecycle.track(registerCodexInspection(sdk, secret, {restPort: config.restPort}));
  }
  registerEventTriggers(sdk, kv);
  registerViewerStreamTriggers(sdk, kv, { secret, metricsStore, provider });
  registerMcpEndpoints(sdk, kv, secret);

  const healthMonitor = resources.health = registerHealthMonitor(sdk, kv, {
    streamRelayProbe:
      kv.backend === "redis"
        ? createStreamRelayProbe(sdk, { url: `ws://localhost:${config.streamsPort}` })
        : undefined,
  });

  const indexPersistence = resources.index = new IndexPersistence(kv, vectorIndex);
  setIndexPersistence(indexPersistence);

  const loaded = await indexPersistence.load().catch((err) => {
    console.warn(`[agentmemory] Failed to load persisted vector index:`, err);
    return null;
  });
  if (loaded?.vector && vectorIndex && loaded.vector.size > 0) {
    // Persisted vectors carry whatever dimension the provider had when
    // they were written. If the active provider declares a different
    // dimension — or if the on-disk index contains a mix of dimensions
    // (legacy indexes written before the live-API guard in this PR) —
    // restoring would silently corrupt search: cosineSimilarity returns
    // 0 on cross-dim pairs, so affected observations stop matching
    // anything and recall degrades without an error. Walk every stored
    // vector instead of trusting the first; refuse to load if anything
    // is off.
    const activeDim = embeddingProvider?.dimensions ?? 0;
    const { mismatches, seenDimensions } =
      activeDim > 0
        ? loaded.vector.validateDimensions(activeDim)
        : { mismatches: [], seenDimensions: new Set<number>() };

    if (mismatches.length > 0) {
      const sample = mismatches
        .slice(0, 5)
        .map((m) => `${m.obsId} (dim=${m.dim})`)
        .join(", ");
      const distinct = Array.from(seenDimensions).sort((a, b) => a - b).join(", ");
      const dropStale = isDropStaleIndexEnabled();
      if (dropStale) {
        for (const [obsId] of loaded.vector.entries()) vectorIndex.markRemoved(obsId);
        console.warn(
          `[agentmemory] Persisted vector index has ${mismatches.length} of ` +
            `${loaded.vector.size} vectors with the wrong dimension. Active ` +
            `provider (${embeddingProvider?.name}) declares ${activeDim}; ` +
            `dimensions seen on disk: ${distinct}. ` +
            `AGENTMEMORY_DROP_STALE_INDEX=true is set — discarding the persisted ` +
            `vectors. Live observations will rebuild the index over time.`,
        );
      } else {
        throw new Error(
          `[agentmemory] Refusing to start: persisted vector index has ` +
            `${mismatches.length} of ${loaded.vector.size} vectors with the ` +
            `wrong dimension. Active provider (${embeddingProvider?.name}) ` +
            `declares ${activeDim}; dimensions seen on disk: ${distinct}. ` +
            `First mismatched obsIds: ${sample}. Loading would silently corrupt ` +
            `search (cross-dimension cosine returns 0). Choose one:\n` +
            `  - Re-embed the existing index against the new provider, then start.\n` +
            `  - Set AGENTMEMORY_DROP_STALE_INDEX=true to discard the persisted ` +
            `vectors and rebuild from live observations.\n` +
            `  - Switch the embedding provider back to the one that wrote the index.`,
        );
      }
    } else {
      vectorIndex.restoreFrom(loaded.vector);
      bootLog(
        `Loaded persisted vector index (${vectorIndex.size} vectors)`,
      );
    }
  }

  if (vectorIndex && loaded && loaded.state !== "unavailable") {
    const replay = await indexPersistence.replayPendingLog(embeddingProvider?.dimensions ?? 0);
    if (replay.entries > 0) {
      bootLog(
        `Recovered ${replay.added} vectors and ${replay.removed} removals written after the last index save, without calling the embedding provider` +
          (replay.skipped > 0 ? ` (${replay.skipped} entries skipped)` : ""),
      );
    }
  }

  if (vectorIndex && embeddingProvider) {
    const embeddingUrl = getEnvVar("OPENAI_EMBEDDING_BASE_URL") || getEnvVar("OPENAI_BASE_URL");
    const chatUrl = config.provider.baseURL || getEnvVar("OPENAI_BASE_URL");
    const readiness = operationalState.providerReadiness && embeddingProvider.name === "openai" && embeddingUrl && chatUrl && new URL(embeddingUrl).origin === new URL(chatUrl).origin
      ? operationalState.providerReadiness : undefined;
    operationalState.embeddingRecovery = lifecycle.track(registerEmbeddingRecovery({
      kv, KV, index: vectorIndex, provider: embeddingProvider, readiness, withKeyedLock, logger,
      schedule: false, persistIndex: (publication?: VectorPublication) => indexPersistence.saveVerified(publication),
    }));
    await operationalState.embeddingRecovery.initialize();
  }
  setEmbeddingRecovery(operationalState.embeddingRecovery ?? null);
  const embeddingReceipts = createEmbeddingReceiptStatus({
    kv, KV, index: vectorIndex,
    observedPublication: id => operationalState.embeddingRecovery?.observedPublication(id) ?? null,
  });
  sdk.registerFunction("mem::embedding-receipts", embeddingReceipts);

  const auditMigration = trackBoot(startAuditMigration(kv).catch(() => {}));

  const vectorCountShortfall =
    Boolean(loaded?.vector) &&
    loaded?.expectedCount !== undefined &&
    loaded.vector!.size < loaded.expectedCount;
  let vectorBackfillSince =
    !loaded || loaded.state === "unavailable"
      ? undefined
      : loaded.state === "none" || vectorCountShortfall
        ? null
        : loaded.savedAt;
  const incrementalBackfill = typeof vectorBackfillSince === "string" && Boolean(vectorIndex && embeddingProvider);
  if (incrementalBackfill) {
    const since = vectorBackfillSince as string;
    const marker = await indexPersistence.readBackfillMarker();
    if (marker !== null && Date.parse(marker) < Date.parse(since)) vectorBackfillSince = marker;
    await indexPersistence.markBackfillSince(vectorBackfillSince as string).catch((err) => {
      bootWarn(`Could not save the vector backfill marker: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
  const keywordStart = Date.now();
  try {
    const keyword = await rebuildKeywordIndex(kv, vectorBackfillSince);
    bootLog(
      `Rebuilt BM25 index from stored content (${keyword.documents} docs in ${Date.now() - keywordStart} ms)`,
    );
    setPendingVectorBackfillCount(keyword.vectorJobs.length + keyword.fullBackfillPending);
    setVectorBackfillState(keyword.fullBackfillPending > 0 ? "waiting-for-opt-in" : "idle");
    if (keyword.fullBackfillPending > 0) {
      bootLog(
        `Vector backfill needs ${keyword.fullBackfillPending} embeddings but a full backfill was not started ` +
          `(set AGENTMEMORY_VECTOR_BACKFILL=all to opt in). See /agentmemory/status.`,
      );
    }
    const backlogScanComplete = !isBm25RebuildIncomplete();
    if (incrementalBackfill && backlogScanComplete && keyword.vectorJobs.length === 0) {
      await indexPersistence.clearBackfillMarker().catch(() => {});
    }
    if (incrementalBackfill && keyword.vectorJobs.length > 0) {
      setVectorBackfillState("running");
      bootLog(
        `Re-embedding ${keyword.vectorJobs.length} vectors missing since the last index save, ${getVectorBackfillMax()} per batch in the background`,
      );
      void trackBoot(backfillVectorBacklog(keyword.vectorJobs)
        .then(async (result) => {
          if (result.complete && backlogScanComplete) await indexPersistence.clearBackfillMarker().catch(() => {});
          setVectorBackfillState(result.queued ? "queued" : result.complete ? "idle" : "paused");
          if (result.added > 0) bootLog(`Vector index backfilled: ${result.added} entries`);
          if (!result.complete && !result.queued) {
            bootWarn(
              `Vector backfill stopped with ${result.remaining} documents still missing a vector. They are retried on the next start.`,
            );
          }
        })
        .catch((err) => {
          setVectorBackfillState("paused");
          console.warn(`[agentmemory] Failed to backfill vectors:`, err);
        }));
    } else if (keyword.vectorJobs.length > 0) {
      setVectorBackfillState("running");
      bootLog(`Backfilling ${keyword.vectorJobs.length} missing vectors in the background`);
      const limitedBackfill = getPendingVectorBackfillCount() > keyword.vectorJobs.length;
      void trackBoot(backfillVectors(keyword.vectorJobs)
        .then((count) => {
          setPendingVectorBackfillCount(keyword.fullBackfillPending);
          setVectorBackfillState(keyword.fullBackfillPending > 0 ? "waiting-for-opt-in" : limitedBackfill ? "limited" : getPendingVectorBackfillCount() > 0 ? "queued" : "idle");
          if (count > 0) bootLog(`Vector index backfilled: ${count} entries`);
        })
        .catch((err) => {
          setVectorBackfillState("idle");
          console.warn(`[agentmemory] Failed to backfill vectors:`, err);
        }));
    }
  } catch (err) {
    console.warn(`[agentmemory] Failed to rebuild the BM25 index:`, err);
  }

  // Ready / Endpoints lines are emitted via `bootLog` so they're
  // buffered in quiet mode and printed verbatim under --verbose. The
  // CLI surfaces a compact summary when it sees the worker reach
  // ready state.
  bootLog(
    `Ready. ${embeddingProvider ? "Triple-stream (BM25+Vector+Graph)" : "BM25+Graph"} search active.`,
  );
  bootLog(
    `REST API: 142 endpoints at http://localhost:${config.restPort}/agentmemory/*`,
  );
  bootLog(
    `MCP surface (opt-in via \`npx @agentmemory/mcp\`): ${getAllTools().length} tools · 6 resources · 3 prompts`,
  );

  void trackBoot((async () => {
    try {
      const drained = await capture.drainLocalSpool();
      const delivered = drained.reduce((n, r) => n + r.delivered, 0);
      const duplicates = drained.reduce((n, r) => n + r.duplicates, 0);
      const remaining = drained.reduce((n, r) => n + r.remaining, 0);
      if (delivered + duplicates + remaining > 0) {
        bootLog(`Capture spool: ${delivered} recovered, ${duplicates} already stored, ${remaining} still waiting`);
      }
      const swept = await capture.sweep();
      if (swept.processed > 0) {
        bootLog(`Capture inbox: ${swept.recovered} of ${swept.processed} unfinished observations stored after restart`);
      }
      await capture.prune();
    } catch (err) {
      bootWarn(`Capture recovery at boot failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!shuttingDown) capture.start();
  })());
  lifecycle.track(capture);
  lifecycle.track(healthMonitor);
  lifecycle.track({ stop: () => indexPersistence.stop() });

  resources.viewer = startViewerServer(
    config.viewerPort,
    kv,
    sdk,
    secret,
    config.restPort,
  );

  if (isGraphCompactOnBootEnabled()) {
    const graphCompaction = createGraphCompactBootRecovery(kv, {log: bootLog, warn: bootWarn});
    lifecycle.track(graphCompaction);
    graphCompaction.start();
  } else {
    setGraphCompactBootDisabled();
  }

  const autoForgetIntervalMs = parseInt(process.env.AUTO_FORGET_INTERVAL_MS || "3600000", 10);
  const consolidationIntervalMs = getConsolidationIntervalMs();

  if (process.env.AUTO_FORGET_ENABLED !== "false") {
    const autoForgetTimer = registerBackgroundInterval(lifecycle, async () => {
      try {
        await sdk.trigger({ function_id: "mem::auto-forget", payload: { dryRun: false } });
      } catch {}
    }, autoForgetIntervalMs);
    autoForgetTimer.unref();
    bootLog(`Auto-forget: enabled (every ${autoForgetIntervalMs / 60000}m)`);
  }

  const auditRetentionMonths = getAuditRetentionMonths();
  if (auditRetentionMonths > 0) {
    const runAuditSweep = async () => {
      try {
        await auditMigration;
        await sdk.trigger({ function_id: "mem::audit-retention-sweep", payload: {} });
      } catch {}
    };
    const auditRetentionTimer = registerBackgroundInterval(lifecycle, runAuditSweep, 86400000);
    auditRetentionTimer.unref();
    bootLog(
      `Audit retention sweep: enabled (drop month scopes older than ${auditRetentionMonths}mo, every 24h)`,
    );
  }

  if (process.env.LESSON_DECAY_ENABLED !== "false") {
    const lessonDecayTimer = registerBackgroundInterval(lifecycle, async () => {
      try {
        await sdk.trigger({ function_id: "mem::lesson-decay-sweep", payload: {} });
      } catch {}
    }, 86400000);
    lessonDecayTimer.unref();
    bootLog(`Lesson decay sweep: enabled (every 24h)`);
  }

  if (process.env.INSIGHT_DECAY_ENABLED !== "false") {
    const insightDecayTimer = registerBackgroundInterval(lifecycle, async () => {
      try {
        await sdk.trigger({ function_id: "mem::insight-decay-sweep", payload: {} });
      } catch {}
    }, 86400000);
    insightDecayTimer.unref();
  }

  const recentSearchesSweepTimer = registerBackgroundInterval(lifecycle, async () => {
    try {
      await sdk.trigger({
        function_id: "mem::diagnostic::recent-searches-sweep",
        payload: {},
      });
    } catch {}
  }, 60 * 60 * 1000);
  recentSearchesSweepTimer.unref();

  void trackBoot(seedViewerStreamTracker(sdk, { unorderedListing: kv.backend === "redis" }).catch(() => {}));

  if (isSessionSweepEnabled()) {
    const sessionSweepTimer = registerBackgroundInterval(lifecycle, async () => {
      try {
        await sdk.trigger({ function_id: "mem::session-sweep", payload: {} });
      } catch (err) {
        bootLog(`Session sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, 60 * 60 * 1000);
    sessionSweepTimer.unref();
    bootLog(`Session sweep: enabled (hourly, stale after ${getSessionSweepStaleHours()}h)`);
  }

  if (isConsolidationEnabled()) {
    const consolidationTimer = registerBackgroundInterval(lifecycle, async () => {
      try {
        await sdk.trigger({ function_id: "mem::consolidate-pipeline", payload: {} });
      } catch {}
    }, consolidationIntervalMs);
    consolidationTimer.unref();
    bootLog(`Auto-consolidation: enabled (every ${consolidationIntervalMs / 60000}m)`);
  }

  if (!shuttingDown) operationalState.embeddingRecovery?.start();
  if (!shuttingDown) {
    operationalState.snapshotRecovery?.start();
    pressure?.start();
  }
  if (kv.durability) registerBackgroundInterval(lifecycle, () => kv.durability!.flushStable(kv), 15000, false);
  } catch (error) { bootFailed = true; throw error; } finally { bootDone(); }
}

export const workerReady = main();
workerReady.catch(async (err) => {
  console.error(`[agentmemory] Fatal:`, err);
  if (fatalShutdown) await fatalShutdown();
  process.exit(1);
});
