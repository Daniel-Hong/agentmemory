import {snapshotJsonChunks,readGitSnapshot,validateSnapshotArchive} from "../ops/snapshot-json.mjs";
import { pinGraphState } from "../state/graph-generation.js";
import {createSnapshotRecovery, ensurePrivateSnapshotDir, publishSnapshotFile} from "../ops/snapshot-recovery.mjs";
import {backgroundPaused} from "../ops/background-control.mjs";
import type { IIIClient } from "iii-sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type {
  SnapshotMeta,
  Session,
  Memory,
  GraphNode,
  GraphEdge,
  CompressedObservation,
  AccessLogExport,
} from "../types.js";
import { KV, generateId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import type { SearchIndexRevision } from "../state/search-index.js";
import { addSessionToProjectIndex } from "../state/session-index.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { recordAudit, safeAudit } from "./audit.js";
import { boundRecordSources } from "./graph.js";
import { persistGraphRecords, validateGraphRecords } from "../state/graph-ingestion.js";
import { flushIndexSave, getSearchIndex, indexRecords, vectorIndexRemove } from "./search.js";
import { VERSION } from "../version.js";
import { logger } from "../logger.js";

const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/i;

const execFileAsync = promisify(execFile);

async function gitExec(dir: string, args: string[], maxBuffer?: number): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: dir, maxBuffer });
  return stdout.trim();
}

async function ensureGitRepo(dir: string): Promise<void> {
  await ensurePrivateSnapshotDir(dir);
  if (!existsSync(join(dir, ".git"))) {
    await gitExec(dir, ["init"]);
    await gitExec(dir, ["config", "user.email", "agentmemory@local"]);
    await gitExec(dir, ["config", "user.name", "agentmemory"]);
  }
}

export function registerSnapshotFunction(
  sdk: IIIClient,
  state: StateKV,
  snapshotDir: string,
  intervalMs = 86400000,
): ReturnType<typeof createSnapshotRecovery> {
  const recovery = createSnapshotRecovery({dir:snapshotDir, intervalMs, gitExec, isPaused:backgroundPaused, create:()=>sdk.trigger({function_id:"mem::snapshot-create",payload:{}})});
  sdk.registerFunction("mem::snapshot-create",
    async (data?: { message?: string }) => recovery.runCreate(async () => {
      let phase = "pin_graph";
      try {
        const kv = await pinGraphState(state);
        phase = "prepare_repository";
        await ensureGitRepo(snapshotDir);
        const ts = new Date().toISOString();

        phase = "read_sessions";
        const sessions = await kv.list<Session>(KV.sessions);
        phase = "read_memories";
        const memories = await kv.list<Memory>(KV.memories);
        phase = "read_graph_nodes";
        const graphNodes = await kv.list<GraphNode>(KV.graphNodes);
        phase = "read_graph_edges";
        const graphEdges = await kv.list<GraphEdge>(KV.graphEdges);
        phase = "read_access";
        const accessLogs = await kv.list<AccessLogExport>(KV.accessLog);

        const observations: Record<string, unknown[]> = {};
        phase = "read_observations";
        for (const session of sessions) {
          const obs = await kv.list(KV.observations(session.id), { observationConsistency: "opened-generation" });
          if (obs.length > 0) {
            observations[session.id] = obs;
          }
        }

        const exportState = {
          version: VERSION,
          timestamp: ts,
          sessions,
          memories,
          graphNodes,
          graphEdges,
          observations,
          accessLogs,
        };

        phase = "serialize";
        validateSnapshotArchive(exportState);
        validateGraphRecords(graphNodes, graphEdges);
        const content = snapshotJsonChunks(exportState);
        phase = "publish";
        await publishSnapshotFile(snapshotDir, "state.json", content);
        phase = "git_add";
        await gitExec(snapshotDir, ["add", "--", "state.json"]);

        const message = data?.message || `Snapshot ${ts}`;
        phase = "git_commit";
        try {
          await gitExec(snapshotDir, ["commit", "-m", message, "--only", "--", "state.json"]);
        } catch (commitErr) {
          phase = "git_diff";
          const changed = await gitExec(snapshotDir, ["diff", "HEAD", "--name-only", "--", "state.json"]);
          if (!changed) {
            phase = "git_head";
            return { success: true, message: "No changes to snapshot", commitHash: await gitExec(snapshotDir, ["rev-parse", "HEAD"]) };
          }
          phase = "git_commit";
          throw commitErr;
        }

        phase = "git_head";
        const commitHash = await gitExec(snapshotDir, ["rev-parse", "HEAD"]);

        const meta: SnapshotMeta = {
          id: generateId("snap"),
          commitHash,
          createdAt: ts,
          message,
          stats: {
            sessions: sessions.length,
            observations: Object.values(observations).reduce(
              (sum, arr) => sum + arr.length,
              0,
            ),
            memories: memories.length,
            graphNodes: graphNodes.length,
          },
        };

        phase = "audit";
        await safeAudit(kv, "export", "mem::snapshot-create", [meta.id], {
          commitHash,
          stats: meta.stats,
        });

        logger.info("Snapshot created", { commitHash });
        return { success: true, snapshot: meta };
      } catch (err) {
        const failure = err as { code?: unknown; message?: unknown };
        if ((failure as {snapshotPhase?:unknown})?.snapshotPhase === "serialize") phase = "serialize";
        const code = failure?.code ?? (failure?.message === "graph_mutation_uncertain" ? "graph_mutation_uncertain" : undefined);
        const knownReadCodes = new Set(["state_namespace_changed", "state_namespace_corrupt", "state_namespace_incomplete", "state_namespace_shape", "state_namespace_duplicate", "state_namespace_utf8", "observation_exceeds_page_budget", "invalid_observation_record", "graph_mutation_uncertain"]);
        const errorCode = typeof code === "string" && /^[A-Z0-9_]{1,80}$/.test(code) ? code
          : typeof code === "string" && knownReadCodes.has(code) ? code.toUpperCase() : "SNAPSHOT_FAILED";
        const errorClass = err instanceof RangeError ? "RangeError" : err instanceof TypeError ? "TypeError" : "Error";
        logger.error("Snapshot failed", { error: errorCode, phase, errorClass });
        return { success: false, error: errorCode, errorCode };
      }
    }),
  );

  sdk.registerFunction("mem::snapshot-list",  async () => {
    try {
      try { await lstat(join(snapshotDir, ".git")); }
      catch (err) {
        if ((err as { code?: string }).code === "ENOENT") return { snapshots: [] };
        throw err;
      }
      const log = await gitExec(snapshotDir, [
        "log",
        "--format=%H|%aI|%s",
        "--all", "-20", "--", "state.json",
      ]);
      const snapshots = log
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const parts = line.split("|");
          const [hash, date] = parts;
          const msg = parts.slice(2).join("|");
          return { commitHash: hash, createdAt: date, message: msg };
        });
      return { snapshots };
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      return { success: false, error: typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "SNAPSHOT_LIST_FAILED" };
    }
  });

  sdk.registerFunction("mem::snapshot-restore", 
    async (data: { commitHash: string } | undefined) => {
      const kv = await pinGraphState(state);
      if (!data || typeof data.commitHash !== "string" || !data.commitHash.trim()) {
        return { success: false, error: "commitHash is required" };
      }
      if (!COMMIT_HASH_RE.test(data.commitHash)) {
        return { success: false, error: "Invalid commitHash format" };
      }

      try {
        const archive = await readGitSnapshot(snapshotDir, data.commitHash) as {
          sessions?: Array<{ id: string } & Record<string, unknown>>;
          memories?: Memory[];
          graphNodes?: GraphNode[];
          graphEdges?: GraphEdge[];
          observations?: Record<string, CompressedObservation[]>;
          accessLogs?: AccessLogExport[];
        };
        validateSnapshotArchive(archive);
        validateGraphRecords(archive.graphNodes ?? [], archive.graphEdges ?? []);
        const memoryIds = new Set<string>();
        const observationSessions = new Map<string, string>();
        let restoreError: unknown;
        try {
          if (archive.sessions) {
            for (const session of archive.sessions) {
              await withKeyedLock(`obs:${session.id}`, () =>
                kv.set(KV.sessions, session.id, session),
              );
              const project = session.project;
              const startedAt = session.startedAt;
              if (typeof project === "string" && typeof startedAt === "string") {
                const agentId = session.agentId;
                await addSessionToProjectIndex(kv, project, {
                  id: session.id,
                  startedAt,
                  ...(typeof agentId === "string" ? { agentId } : {}),
                }).catch(() => {});
              }
            }
          }
          for (const memory of archive.memories ?? []) {
            await kv.set(KV.memories, memory.id, memory);
            getSearchIndex().remove(memory.id);
            vectorIndexRemove(memory.id);
            memoryIds.add(memory.id);
          }
          for (const [sessionId, observations] of Object.entries(archive.observations ?? {})) {
            await withKeyedLock(`obs:${sessionId}`, async () => {
              for (const observation of observations) {
                await kv.set(KV.observations(sessionId), observation.id, observation);
                getSearchIndex().remove(observation.id);
                vectorIndexRemove(observation.id);
                observationSessions.set(observation.id, sessionId);
              }
            });
          }
          if (archive.graphNodes?.length || archive.graphEdges?.length) {
            await persistGraphRecords(kv, archive.graphNodes ?? [], archive.graphEdges ?? [], { mode: "merge" });
          }
          for (const log of archive.accessLogs ?? []) {
            await kv.set(KV.accessLog, log.memoryId, log);
          }
        } catch (err) {
          restoreError = err;
        }

        let indexError: unknown;
        if (memoryIds.size || observationSessions.size) {
          const revisions: SearchIndexRevision[] = [];
          try {
            const memories: Array<{ record: Memory; revision: SearchIndexRevision }> = [];
            const observations: Array<{ record: CompressedObservation; revision: SearchIndexRevision }> = [];
            for (const id of memoryIds) {
              const revision = getSearchIndex().watchRevision(id);
              revisions.push(revision);
              const current = await kv.get<Memory>(KV.memories, id);
              if (current) memories.push({ record: current, revision });
            }
            for (const [id, sessionId] of observationSessions) {
              const revision = getSearchIndex().watchRevision(id);
              revisions.push(revision);
              const current = await kv.get<CompressedObservation>(KV.observations(sessionId), id);
              if (current) observations.push({ record: current, revision });
            }
            await indexRecords(
              observations.filter(({ revision }) => revision.isCurrent()).map(({ record }) => record),
              memories.filter(({ revision }) => revision.isCurrent()).map(({ record }) => record),
            );
          } catch (err) {
            indexError = err;
          } finally {
            for (const revision of revisions) revision.release();
            await flushIndexSave();
          }
        }
        if (restoreError) throw restoreError;
        if (indexError) throw indexError;

        await recordAudit(kv, "import", "mem::snapshot-restore", [], {
          commitHash: data.commitHash,
          sessions: archive.sessions?.length || 0,
          memories: archive.memories?.length || 0,
          graphNodes: archive.graphNodes?.length || 0,
        });

        logger.info("Snapshot restored", {
          commitHash: data.commitHash,
        });
        return { success: true, commitHash: data.commitHash };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Snapshot restore failed", { error: msg });
        return { success: false, error: msg };
      }
    },
  );
  return recovery;
}
