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
  AccessLogExport,
} from "../types.js";
import { KV, generateId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { addSessionToProjectIndex } from "../state/session-index.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { recordAudit, safeAudit } from "./audit.js";
import { boundRecordSources } from "./graph.js";
import { VERSION } from "../version.js";
import { logger } from "../logger.js";

const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/i;

const execFileAsync = promisify(execFile);

async function gitExec(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: dir });
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
  kv: StateKV,
  snapshotDir: string,
  intervalMs = 86400000,
): ReturnType<typeof createSnapshotRecovery> {
  const recovery = createSnapshotRecovery({dir:snapshotDir, intervalMs, gitExec, isPaused:backgroundPaused, create:()=>sdk.trigger({function_id:"mem::snapshot-create",payload:{}})});
  sdk.registerFunction("mem::snapshot-create",
    async (data?: { message?: string }) => recovery.runCreate(async () => {
      try {
        await ensureGitRepo(snapshotDir);
        const ts = new Date().toISOString();

        const sessions = await kv.list<Session>(KV.sessions);
        const memories = await kv.list<Memory>(KV.memories);
        const graphNodes = await kv.list<GraphNode>(KV.graphNodes);
        const accessLogs = await kv.list<AccessLogExport>(KV.accessLog);

        const observations: Record<string, unknown[]> = {};
        for (const session of sessions) {
          const obs = await kv.list(KV.observations(session.id));
          if (obs.length > 0) {
            observations[session.id] = obs;
          }
        }

        const state = {
          version: VERSION,
          timestamp: ts,
          sessions,
          memories,
          graphNodes,
          observations,
          accessLogs,
        };

        await publishSnapshotFile(snapshotDir, "state.json", JSON.stringify(state, null, 2));
        await gitExec(snapshotDir, ["add", "--", "state.json"]);

        const message = data?.message || `Snapshot ${ts}`;
        try {
          await gitExec(snapshotDir, ["commit", "-m", message, "--only", "--", "state.json"]);
        } catch (commitErr) {
          const changed = await gitExec(snapshotDir, ["diff", "HEAD", "--name-only", "--", "state.json"]);
          if (!changed) {
            return { success: true, message: "No changes to snapshot", commitHash: await gitExec(snapshotDir, ["rev-parse", "HEAD"]) };
          }
          throw commitErr;
        }

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

        await safeAudit(kv, "export", "mem::snapshot-create", [meta.id], {
          commitHash,
          stats: meta.stats,
        });

        logger.info("Snapshot created", { commitHash });
        return { success: true, snapshot: meta };
      } catch (err) {
        const code = (err as { code?: unknown })?.code;
        const errorCode = typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "SNAPSHOT_FAILED";
        logger.error("Snapshot failed", { error: errorCode });
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
      if (!data || typeof data.commitHash !== "string" || !data.commitHash.trim()) {
        return { success: false, error: "commitHash is required" };
      }
      if (!COMMIT_HASH_RE.test(data.commitHash)) {
        return { success: false, error: "Invalid commitHash format" };
      }

      try {
        await gitExec(snapshotDir, [
          "checkout",
          data.commitHash,
          "--",
          "state.json",
        ]);
        const content = readFileSync(join(snapshotDir, "state.json"), "utf-8");
        const state = JSON.parse(content) as {
          sessions?: Array<{ id: string } & Record<string, unknown>>;
          memories?: Array<{ id: string } & Record<string, unknown>>;
          graphNodes?: Array<{ id: string } & Record<string, unknown>>;
          observations?: Record<
            string,
            Array<{ id: string } & Record<string, unknown>>
          >;
          accessLogs?: AccessLogExport[];
        };

        if (state.sessions) {
          for (const session of state.sessions) {
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
        if (state.memories) {
          for (const memory of state.memories) {
            await kv.set(KV.memories, memory.id, memory);
          }
        }
        if (state.graphNodes) {
          for (const node of state.graphNodes) {
            await withKeyedLock("graph:persist", () =>
              kv.set(KV.graphNodes, node.id, boundRecordSources(node)),
            );
          }
        }
        if (state.observations) {
          for (const [sessionId, obs] of Object.entries(state.observations)) {
            for (const o of obs) {
              await kv.set(KV.observations(sessionId), o.id, o);
            }
          }
        }
        if (state.accessLogs) {
          for (const log of state.accessLogs) {
            await kv.set(KV.accessLog, log.memoryId, log);
          }
        }

        await gitExec(snapshotDir, ["checkout", "HEAD", "--", "state.json"]);

        await recordAudit(kv, "import", "mem::snapshot-restore", [], {
          commitHash: data.commitHash,
          sessions: state.sessions?.length || 0,
          memories: state.memories?.length || 0,
          graphNodes: state.graphNodes?.length || 0,
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
