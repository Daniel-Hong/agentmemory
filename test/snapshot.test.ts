import { describe, it, expect, beforeEach, vi } from "vitest";

const snapshotContent = vi.hoisted(() => vi.fn(() => '{"version":"0.4.0","sessions":[],"memories":[]}'));

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { gitMock } = vi.hoisted(() => ({ gitMock: vi.fn() }));
vi.mock("node:util", async () => ({ ...(await vi.importActual("node:util")), promisify: () => gitMock }));
vi.mock("node:fs/promises", async () => ({
  ...(await vi.importActual("node:fs/promises")),
  mkdir: vi.fn(async () => {}), chmod: vi.fn(async () => {}),
  lstat: vi.fn(async () => ({ isDirectory: () => true })),
  readFile: vi.fn(async () => { throw Object.assign(Error("missing fixture"), { code: "ENOENT" }); }),
  open: vi.fn(async () => ({ writeFile: vi.fn(async (content) => { if (content && typeof content !== "string") for await (const _ of content) {} }), sync: vi.fn(async () => {}), close: vi.fn(async () => {}) })),
  rename: vi.fn(async () => {}), unlink: vi.fn(async () => {}),
}));

vi.mock("node:fs", async () => ({
  constants: (await vi.importActual<typeof import("node:fs")>("node:fs")).constants,
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn(() => snapshotContent()),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("../src/ops/snapshot-json.mjs",async original=>{
 const m=await original<any>();return {...m,readGitSnapshot:()=>m.readSnapshotJson((async function*(){yield Buffer.from(snapshotContent());})())};
});
import { readFileSync } from "node:fs";
import { logger } from "../src/logger.js";
import { lstat } from "node:fs/promises";
import { registerSnapshotFunction } from "../src/functions/snapshot.js";
import { currentAuditScope } from "./helpers/mocks.js";
import { withKeyedLock } from "../src/state/keyed-mutex.js";
import { KV } from "../src/state/schema.js";
import { getProjectSessionIndex } from "../src/state/session-index.js";
import type { Session, Memory, SnapshotMeta } from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (idOrInput: string | { function_id: string; payload: unknown }, data?: unknown) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

beforeEach(() => {
  gitMock.mockReset().mockImplementation(async (_cmd, args) => ({ stdout: args[0] === "show" ? String(vi.mocked(readFileSync)()) : args[0] === "log" ? "" : args[1] === "--is-inside-work-tree" ? "true" : "a".repeat(40), stderr: "" }));
  snapshotContent.mockReset().mockReturnValue('{"version":"0.4.0","sessions":[],"memories":[]}');
  vi.mocked(readFileSync).mockReset().mockImplementation(() => snapshotContent());
  vi.mocked(lstat).mockReset().mockResolvedValue({ isDirectory: () => true } as never);
});

describe("Snapshot Functions", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;
  const snapshotDir = "/tmp/agentmemory-snapshots";

  beforeEach(async () => {
    sdk = mockSdk();
    kv = mockKV();
    vi.clearAllMocks();
    registerSnapshotFunction(sdk as never, kv as never, snapshotDir);

    const session: Session = {
      id: "ses_1",
      project: "test",
      cwd: "/tmp",
      startedAt: "2026-02-01T00:00:00Z",
      status: "completed",
      observationCount: 1,
    };
    await kv.set("mem:sessions", "ses_1", session);

    const mem: Memory = {
      id: "mem_1",
      createdAt: "2026-02-01T00:00:00Z",
      updatedAt: "2026-02-01T00:00:00Z",
      type: "pattern",
      title: "Test pattern",
      content: "Always test",
      concepts: [],
      files: [],
      sessionIds: ["ses_1"],
      strength: 5,
      version: 1,
      isLatest: true,
    };
    await kv.set("mem:memories", "mem_1", mem);
  });

  it("snapshot-create serializes state and returns meta", async () => {
    const result = (await sdk.trigger("mem::snapshot-create", {
      message: "Test snapshot",
    })) as { success: boolean; snapshot: SnapshotMeta };

    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot.commitHash).toBe("a".repeat(40));
    expect(result.snapshot.message).toBe("Test snapshot");
    expect(result.snapshot.stats.sessions).toBe(1);
    expect(result.snapshot.stats.memories).toBe(1);
  });

  it("keeps a known lowercase read failure and its phase without source details", async () => {
    const list = kv.list;
    kv.list = async scope => {
      if (scope === KV.observations("ses_1")) throw Object.assign(Error("private body and path"), { code: "state_namespace_changed" });
      return list(scope);
    };
    expect(await sdk.trigger("mem::snapshot-create", {})).toMatchObject({ success: false, errorCode: "STATE_NAMESPACE_CHANGED" });
    expect(logger.error).toHaveBeenCalledWith("Snapshot failed", { error: "STATE_NAMESPACE_CHANGED", phase: "read_observations", errorClass: "Error" });
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain("private body and path");
  });

  it("identifies a serialization RangeError without allocating a large fixture or logging its message", async () => {
    await kv.set(KV.memories, "range", { id:"range", toJSON() { throw new RangeError("private serialization detail"); } });
    expect(await sdk.trigger("mem::snapshot-create", {})).toMatchObject({ success: false, errorCode: "SNAPSHOT_FAILED" });
    expect(logger.error).toHaveBeenCalledWith("Snapshot failed", { error: "SNAPSHOT_FAILED", phase: "serialize", errorClass: "RangeError" });
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain("private serialization detail");
  });

  it("redacts unknown codes and TypeError messages during an observation read", async () => {
    const list = kv.list;
    kv.list = async scope => {
      if (scope === KV.observations("ses_1")) throw Object.assign(new TypeError("private source"), { code: "private_source_identifier" });
      return list(scope);
    };
    expect(await sdk.trigger("mem::snapshot-create", {})).toMatchObject({ success: false, errorCode: "SNAPSHOT_FAILED" });
    expect(logger.error).toHaveBeenCalledWith("Snapshot failed", { error: "SNAPSHOT_FAILED", phase: "read_observations", errorClass: "TypeError" });
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain("private_source");
  });

  it("records graph pinning failure without exposing the invalid generation", async () => {
    await kv.set(KV.graphControl, "generation", "private-invalid-generation");
    expect(await sdk.trigger("mem::snapshot-create", {})).toMatchObject({ success: false, errorCode: "SNAPSHOT_FAILED" });
    expect(logger.error).toHaveBeenCalledWith("Snapshot failed", { error: "SNAPSHOT_FAILED", phase: "pin_graph", errorClass: "Error" });
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain("private-invalid-generation");
  });

  it.each([
    { scope: KV.graphNodes, error: Error("graph_mutation_uncertain"), expected: "GRAPH_MUTATION_UNCERTAIN", phase: "read_graph_nodes" },
    { scope: KV.observations("ses_1"), error: Object.assign(Error("private malformed bytes"), { code: "state_namespace_utf8" }), expected: "STATE_NAMESPACE_UTF8", phase: "read_observations" },
  ])("preserves known reader classification $expected", async ({ scope, error, expected, phase }) => {
    const list = kv.list;
    kv.list = async current => { if (current === scope) throw error; return list(current); };
    expect(await sdk.trigger("mem::snapshot-create", {})).toMatchObject({ success: false, errorCode: expected });
    expect(logger.error).toHaveBeenCalledWith("Snapshot failed", { error: expected, phase, errorClass: "Error" });
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain("private malformed bytes");
  });

  it("snapshot-list returns snapshots from git log", async () => {
    const result = (await sdk.trigger("mem::snapshot-list", {})) as {
      snapshots: Array<{
        commitHash: string;
        createdAt: string;
        message: string;
      }>;
    };

    expect(result.snapshots).toBeDefined();
    expect(Array.isArray(result.snapshots)).toBe(true);
  });

  it("snapshot-list scopes Git history to state.json and preserves message pipes", async () => {
    gitMock.mockResolvedValueOnce({ stdout: "a".repeat(40) + "|2026-10-14T00:00:00Z|snapshot | fixture\n", stderr: "" });
    expect(await sdk.trigger("mem::snapshot-list", {})).toEqual({ snapshots: [{ commitHash: "a".repeat(40), createdAt: "2026-10-14T00:00:00Z", message: "snapshot | fixture" }] });
    expect(gitMock).toHaveBeenCalledWith("git", ["log", "--format=%H|%aI|%s", "--all", "-20", "--", "state.json"], { cwd: snapshotDir });
  });

  it("snapshot-list exposes directory read errors instead of an empty result", async () => {
    vi.mocked(lstat).mockRejectedValueOnce(Object.assign(Error("fixture denied"), { code: "EACCES" }));
    expect(await sdk.trigger("mem::snapshot-list", {})).toEqual({ success: false, error: "EACCES" });
  });

  it("snapshot-list exposes Git read errors instead of an empty result", async () => {
    gitMock.mockRejectedValueOnce(Object.assign(Error("fixture read failed"), { code: "EIO" }));
    expect(await sdk.trigger("mem::snapshot-list", {})).toEqual({ success: false, error: "EIO" });
  });

  it("snapshot-restore requires commitHash", async () => {
    const result = (await sdk.trigger("mem::snapshot-restore", {})) as {
      success: boolean;
      error: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toContain("commitHash");
  });

  it("snapshot-restore loads state from commit", async () => {
    const result = (await sdk.trigger("mem::snapshot-restore", {
      commitHash: "abc1234",
    })) as { success: boolean; commitHash: string };

    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.commitHash).toBe("abc1234");
  });

  it("snapshot-restore self-heals the project session index for restored sessions", async () => {
    const restoredSession: Session = {
      id: "ses_restored",
      project: "proj-restored",
      cwd: "/tmp/restored",
      startedAt: "2026-02-01T00:00:00Z",
      status: "completed",
      observationCount: 0,
    };
    snapshotContent.mockReturnValueOnce(
      JSON.stringify({
        version: "0.4.0",
        sessions: [restoredSession],
        memories: [],
      }),
    );

    expect(
      await getProjectSessionIndex(kv as never, "proj-restored"),
    ).toBeNull();

    const result = (await sdk.trigger("mem::snapshot-restore", {
      commitHash: "abc1234",
    })) as { success: boolean };

    expect(result.success, JSON.stringify(result)).toBe(true);
    const index = await getProjectSessionIndex(kv as never, "proj-restored");
    expect(index?.map((e) => e.id)).toEqual(["ses_restored"]);
  });

  it("waits for summary publication before replacing restored observation content", async () => {
    const old = { id: "obs_locked", sessionId: "ses_1", timestamp: "2026-02-01T00:00:00Z",
      type: "decision", title: "Original", narrative: "Old content", facts: [], concepts: [], files: [], importance: 5 };
    const replacement = { ...old, title: "Restored", narrative: "Changed content" };
    await kv.set(KV.observations("ses_1"), old.id, old);
    snapshotContent.mockReturnValueOnce(JSON.stringify({
      sessions: [], memories: [], observations: { ses_1: [replacement] },
    }));
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const publishing = withKeyedLock("obs:ses_1", async () => { entered(); await gate; });
    await ready;
    const restoring = sdk.trigger("mem::snapshot-restore", { commitHash: "abc1234" });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(await kv.get(KV.observations("ses_1"), old.id)).toEqual(old);
    } finally { release(); await publishing; }
    expect(await restoring).toMatchObject({ success: true });
    expect(await kv.get(KV.observations("ses_1"), old.id)).toEqual(replacement);
  });

  it("snapshot-create records an audit entry", async () => {
    await sdk.trigger("mem::snapshot-create", { message: "Audit test" });

    const audits = await kv.list(currentAuditScope());
    expect(audits.length).toBe(1);
  });
});

describe("snapshot-create reentrancy guard", () => {
  // An overlapping request is deferred while the admitted export finishes.
  it("skips an overlapping call and releases the guard on completion", async () => {
    let releaseFirst!: () => void;
    const firstListGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let listCalls = 0;
    const store = new Map<string, Map<string, unknown>>();
    const gatedKv = {
      get: async () => null,
      set: async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (!store.has(scope)) store.set(scope, new Map());
        store.get(scope)!.set(key, data);
        return data;
      },
      delete: async () => {},
      list: async <T>(scope: string): Promise<T[]> => {
        listCalls++;
        // Park the first snapshot inside its initial list() so a second
        // snapshot-create observes the in-flight guard.
        if (listCalls === 1) await firstListGate;
        return (Array.from(store.get(scope)?.values() ?? []) as T[]) ?? [];
      },
    };
    const localSdk = mockSdk();
    registerSnapshotFunction(localSdk as never, gatedKv as never, "/tmp/reentrant");

    // Start the first snapshot; it parks inside kv.list with the guard held.
    const p1 = localSdk.trigger("mem::snapshot-create", { message: "first" });
    await Promise.resolve();
    await Promise.resolve();

    // Recovery defers the second call while the admitted export is active.
    const r2 = (await localSdk.trigger("mem::snapshot-create", {
      message: "second",
    })) as { success: boolean; message?: string; snapshot?: unknown };
    expect(r2).toEqual({ success: false, deferred: true, reason: "snapshot_in_progress" });
    expect(r2.snapshot).toBeUndefined();

    // Release the first run; it completes normally.
    releaseFirst();
    const r1 = (await p1) as { success: boolean; snapshot?: unknown };
    expect(r1.success).toBe(true);
    expect(r1.snapshot).toBeDefined();

    // Guard is released: a fresh call runs the full body again.
    const r3 = (await localSdk.trigger("mem::snapshot-create", {
      message: "third",
    })) as { success: boolean; snapshot?: unknown };
    expect(r3.success).toBe(true);
    expect(r3.snapshot).toBeDefined();
  });
});

const bloatedIds = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix}_${String(i).padStart(3, "0")}`);

describe("snapshot-restore bounds graph provenance", () => {
  it("caps sourceObservationIds on restored graph nodes", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerSnapshotFunction(sdk as never, kv as never, "/tmp/agentmemory-snapshots");
    snapshotContent.mockReturnValueOnce(
      JSON.stringify({
        version: "0.4.0",
        sessions: [],
        memories: [],
        graphNodes: [
          {
            id: "gn_bloat",
            type: "file",
            name: "src/hot.ts",
            properties: {},
            sourceObservationIds: bloatedIds("obs", 250),
            createdAt: "2026-03-01T00:00:00Z",
          },
        ],
      }),
    );
    const result = (await sdk.trigger("mem::snapshot-restore", {
      commitHash: "abc1234",
    })) as { success: boolean };
    expect(result.success, JSON.stringify(result)).toBe(true);
    const n = await kv.get<{ name: string; sourceObservationIds: string[] }>("mem:graph:nodes", "gn_bloat");
    expect(n!.name).toBe("src/hot.ts");
    expect(n!.sourceObservationIds).toEqual(bloatedIds("obs", 250).slice(-32));
  });
  it("opts only snapshot observation lists into opened-generation consistency", async () => {
    const kv = mockKV(), sdk = mockSdk();
    await kv.set(KV.sessions,"ses_1",{id:"ses_1"});
    registerSnapshotFunction(sdk as never,kv as never,"/tmp/agentmemory-snapshots");
    const original = kv.list; const calls: Array<{scope: string; options: unknown}> = [];
    kv.list = async (scope: string, options?: unknown) => { calls.push({scope, options}); return original(scope); };
    expect((await sdk.trigger("mem::snapshot-create", {})).success).toBe(true);
    expect(calls.find(call => call.scope === KV.observations("ses_1"))?.options).toEqual({observationConsistency:"opened-generation"});
    expect(calls.filter(call => !call.scope.startsWith("mem:obs:")).every(call => call.options === undefined)).toBe(true);
  });
  it("creates a snapshot without stringifying the complete archive", async () => {
    const kv = mockKV(), sdk = mockSdk();
    await kv.set(KV.sessions,"synthetic-session",{id:"synthetic-session"});
    registerSnapshotFunction(sdk as never,kv as never,"/tmp/agentmemory-snapshots");
    const stringify = JSON.stringify.bind(JSON);
    const spy = vi.spyOn(JSON,"stringify").mockImplementation(((value: any,...rest: any[]) => {
      if(value && Object.hasOwn(value,"observations") && Object.hasOwn(value,"sessions")) throw new RangeError("synthetic whole archive string cap");
      return stringify(value,...rest as []);
    }) as typeof JSON.stringify);
    try {expect((await sdk.trigger("mem::snapshot-create",{})).success).toBe(true);} finally {spy.mockRestore();}
  });
  it("restores complete records without parsing one complete archive string", async () => {
    const kv = mockKV(), sdk = mockSdk();
    const sessions = Array.from({length:24},(_,n)=>({id:"synthetic-"+n,note:"x".repeat(2048)}));
    snapshotContent.mockReturnValue(JSON.stringify({version:"0.4.0",sessions,memories:[],graphNodes:[],graphEdges:[],observations:{},accessLogs:[]}));
    registerSnapshotFunction(sdk as never,kv as never,"/tmp/agentmemory-snapshots");
    const parse = JSON.parse.bind(JSON);
    const spy = vi.spyOn(JSON,"parse").mockImplementation(((text: string,...rest: any[]) => {
      if(text.length>16384) throw new RangeError("synthetic complete archive parse cap");
      return parse(text,...rest as []);
    }) as typeof JSON.parse);
    try {
      expect((await sdk.trigger("mem::snapshot-restore",{commitHash:"a".repeat(40)})).success).toBe(true);
      for(const row of sessions) expect(await kv.get(KV.sessions,row.id)).toEqual(row);
    } finally {spy.mockRestore();}
  });
});
