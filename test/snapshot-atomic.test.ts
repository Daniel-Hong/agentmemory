import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerSnapshotFunction } from "../src/functions/snapshot.js";
import { KV } from "../src/state/schema.js";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const fault = vi.hoisted(() => ({ phase: null as "write" | "sync" | "rename" | null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (path: any, ...args: any[]) => {
      const file = await actual.open(path, ...args as [any]);
      if (!String(path).includes("state.json.") || !String(path).endsWith(".tmp")) return file;
      return {
        writeFile: async (...values: any[]) => {
          if (fault.phase === "write") { await file.writeFile("partial fixture"); throw Object.assign(Error("fixture disk full"), { code: "ENOSPC" }); }
          return file.writeFile(...values as [any]);
        },
        sync: async () => {
          if (fault.phase === "sync") throw Object.assign(Error("fixture sync failure"), { code: "EIO" });
          return file.sync();
        },
        close: () => file.close(),
      };
    },
    rename: async (from: any, to: any) => {
      if (fault.phase === "rename" && String(to).endsWith("/state.json")) throw Object.assign(Error("fixture rename failure"), { code: "EIO" });
      return actual.rename(from, to);
    },
  };
});
const exec = promisify(execFile);
async function git(dir: string, args: string[]) { return (await exec("git", args, { cwd: dir })).stdout.trim(); }
const directories: string[] = [], workers: Array<{ stop: () => Promise<void> }> = [];
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "agentmemory-snapshot-atomic-")); directories.push(dir);
  const data = new Map<string, Map<string, unknown>>(), handlers = new Map<string, (payload: any) => Promise<any>>();
  const kv = {
    list: async (scope: string) => structuredClone([...(data.get(scope)?.values() ?? [])]),
    get: async (scope: string, id: string) => structuredClone(data.get(scope)?.get(id) ?? null),
    set: async (scope: string, id: string, value: unknown) => {
      if (!data.has(scope)) data.set(scope, new Map());
      data.get(scope)!.set(id, structuredClone(value)); return value;
    },
  };
  const sdk = {
    registerFunction: (id: string, handler: any) => handlers.set(id, handler),
    trigger: ({ function_id, payload }: any) => handlers.get(function_id)!(payload),
  };
  const recovery = registerSnapshotFunction(sdk as never, kv as never, dir); workers.push(recovery);
  await kv.set(KV.sessions, "s", { id: "s", project: "fixture", status: "completed", observationCount: 1 });
  await kv.set(KV.observations("s"), "o", { id: "o", title: "fixture", sourceRaw: { raw: "full fixture evidence" } });
  return { dir, kv, recovery,
    create: (message = "snapshot | fixture") => sdk.trigger({ function_id: "mem::snapshot-create", payload: { message } }),
    list: () => sdk.trigger({ function_id: "mem::snapshot-list", payload: {} }) };
}
afterEach(async () => {
  fault.phase = null; vi.useRealTimers();
  await Promise.all(workers.splice(0).map(worker => worker.stop()));
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("snapshot publication on real temporary files", () => {
  it("publishes complete private state and commits only state.json even with other staged files", async () => {
    const f = await fixture();
    await git(f.dir, ["init"]); await git(f.dir, ["config", "user.email", "fixture@local"]); await git(f.dir, ["config", "user.name", "fixture"]);
    await writeFile(join(f.dir, "unrelated.txt"), "unrelated synthetic fixture"); await git(f.dir, ["add", "unrelated.txt"]);
    const result = await f.create();
    expect(result.success).toBe(true);
    const state = JSON.parse(await readFile(join(f.dir, "state.json"), "utf8"));
    expect(state.observations.s[0].sourceRaw.raw).toBe("full fixture evidence");
    expect(await git(f.dir, ["ls-tree", "--name-only", "HEAD"])).toBe("state.json");
    expect(await git(f.dir, ["diff", "--cached", "--name-only"])).toBe("unrelated.txt");
    expect((await stat(f.dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(f.dir, "state.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(f.dir, ".snapshot-schedule.json"))).mode & 0o777).toBe(0o600);
    await git(f.dir, ["commit", "-m", "unrelated | commit"]);
    expect(await f.list()).toEqual({ snapshots: [{ commitHash: result.snapshot.commitHash, createdAt: expect.any(String), message: "snapshot | fixture" }] });
  });

  it.each(["write", "sync", "rename"] as const)("retains the previous committed state on atomic %s failure", async (phase) => {
    const f = await fixture();
    const committed = await f.create(); expect(committed.success).toBe(true);
    const original = await readFile(join(f.dir, "state.json"), "utf8");
    await f.kv.set(KV.memories, "new", { id: "new", content: "new synthetic fixture" });
    fault.phase = phase;
    expect(await f.create()).toMatchObject({ success: false, errorCode: phase === "write" ? "ENOSPC" : "EIO" });
    expect(await readFile(join(f.dir, "state.json"), "utf8")).toBe(original);
    expect(await git(f.dir, ["rev-parse", "HEAD"])).toBe(committed.snapshot.commitHash);
    expect((await readdir(f.dir)).filter(file => file.endsWith(".tmp"))).toEqual([]);
    expect(f.recovery.snapshot()).toMatchObject({ status: "retrying", lastCommitHash: committed.snapshot.commitHash });
  });

  it.each([KV.observations("s"), KV.accessLog])("refuses publication on %s read failure without erasing a good snapshot", async (failedScope) => {
    const f = await fixture();
    expect((await f.create()).success).toBe(true);
    const original = await readFile(join(f.dir, "state.json"), "utf8"), hash = await git(f.dir, ["rev-parse", "HEAD"]);
    const list = f.kv.list;
    f.kv.list = async scope => { if (scope === failedScope) throw Object.assign(Error("fixture read failed"), { code: "EIO" }); return list(scope); };
    expect(await f.create()).toMatchObject({ success: false, errorCode: "EIO" });
    expect(await readFile(join(f.dir, "state.json"), "utf8")).toBe(original);
    expect(await git(f.dir, ["rev-parse", "HEAD"])).toBe(hash);
  });

  it("defers concurrent creation and drains the admitted publication", async () => {
    const f = await fixture();
    let entered!: () => void, release!: () => void;
    const admission = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const list = f.kv.list; let held = false;
    f.kv.list = async scope => { if (scope === KV.sessions && !held) { held = true; entered(); await gate; } return list(scope); };
    const first = f.create(); await admission;
    expect(await f.create()).toEqual({ success: false, deferred: true, reason: "snapshot_in_progress" });
    let drained = false; const drain = f.recovery.drain().then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve)); expect(drained).toBe(false);
    release(); expect((await first).success).toBe(true); await drain;
    expect(drained).toBe(true); expect(JSON.parse(await readFile(join(f.dir, "state.json"), "utf8")).sessions[0].id).toBe("s");
  });

  it("lists unborn repositories as empty and genuine Git errors as failed", async () => {
    const f = await fixture();
    await git(f.dir, ["init"]);
    expect(await f.list()).toEqual({ snapshots: [] });
    await writeFile(join(f.dir, ".git", "HEAD"), "corrupt fixture");
    const result = await f.list();
    expect(result).toMatchObject({ success: false, error: "SNAPSHOT_LIST_FAILED" });
    expect(result).not.toHaveProperty("snapshots");
  });

  it("acknowledges an unchanged snapshot with its actual commit hash", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-14T00:00:00Z"));
    const f = await fixture(); const original = await f.create(); expect(original.success).toBe(true);
    expect(await f.create()).toMatchObject({ success: true, message: "No changes to snapshot", commitHash: original.snapshot.commitHash });
    expect(f.recovery.snapshot()).toMatchObject({ status: "current", failures: 0, lastCommitHash: original.snapshot.commitHash });
  });
});
