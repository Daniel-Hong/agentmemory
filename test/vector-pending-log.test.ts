import { describe, it, expect, afterEach, vi } from "vitest";
import { IndexPersistence } from "../src/state/index-persistence.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { createStateDurabilityFence } from "../src/ops/state-durability.mjs";
import {
  backfillVectorBacklog,
  getPendingVectorBackfillCount,
  getSearchIndex,
  rebuildKeywordIndex,
  setEmbeddingProvider,
  setIndexPersistence,
  setVectorIndex,
} from "../src/functions/search.js";
import type { CompressedObservation, EmbeddingProvider, Session } from "../src/types.js";

const PENDING_SCOPE = "mem:index:vec-pending";
const INDEX_SCOPE = "mem:index:bm25";

function mockKV(options: { shuffle?: boolean } = {}) {
  const store = new Map<string, Map<string, unknown>>();
  const ops: Array<{ op: "set" | "delete" | "list"; scope: string; key?: string }> = [];
  return {
    store,
    ops,
    get: async <T>(scope: string, key: string): Promise<T | null> => (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      ops.push({ op: "set", scope, key });
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, JSON.parse(JSON.stringify(data)));
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      ops.push({ op: "delete", scope, key });
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      ops.push({ op: "list", scope });
      const rows = Array.from(store.get(scope)?.values() ?? []);
      if (options.shuffle) rows.reverse();
      return rows as T[];
    },
  };
}

type MockKV = ReturnType<typeof mockKV>;

function v(seed: number): Float32Array {
  return new Float32Array([seed, seed + 0.5, seed + 1]);
}

function pendingRows(kv: MockKV): Map<string, Record<string, unknown>> {
  return (kv.store.get(PENDING_SCOPE) ?? new Map()) as Map<string, Record<string, unknown>>;
}

async function boot(kv: MockKV, dims = 3): Promise<{ vector: VectorIndex; persistence: IndexPersistence }> {
  const vector = new VectorIndex();
  const persistence = new IndexPersistence(kv as never, vector, { saveIntervalMs: 600_000, bucketSize: 4 });
  const loaded = await persistence.load();
  if (loaded.vector && loaded.vector.size > 0) vector.restoreFrom(loaded.vector);
  await persistence.replayPendingLog(dims);
  return { vector, persistence };
}

describe("pending vector log", () => {
  afterEach(() => {
    vi.useRealTimers();
    getSearchIndex().clear();
    setVectorIndex(null);
    setEmbeddingProvider(null);
    setIndexPersistence(null);
  });

  it('keeps pending records and refuses vector recovery during storage-held startup', async () => {
    const kv=mockKV();const original={q:1,id:'obs_held',s:'ses_held',e:Buffer.from(v(1).buffer).toString('base64')};
    await kv.set(PENDING_SCOPE,'obs_held',original);const before=structuredClone(original);
    const vector=new VectorIndex();const persistence=new IndexPersistence(kv as never,vector,{requireRecoveryPlan:true,isStorageHeld:()=>true} as never);
    try{
      const loaded=await persistence.load();await persistence.prepareBackfill(loaded);await persistence.replayPendingLog(3);await persistence.save();
      expect(pendingRows(kv).get('obs_held')).toEqual(before);expect(vector.size).toBe(0);expect(persistence.isRecoveryPaused()).toBe(true);
      expect((persistence.status() as {pendingLogKnown?:boolean}).pendingLogKnown).toBe(false);
      expect(persistence.status().pendingLog).toBeUndefined();
      expect(persistence.status().pendingLogAcknowledged).toBeUndefined();
      expect(kv.ops.filter(x=>x.op==='delete'&&x.scope===PENDING_SCOPE)).toEqual([]);
    }finally{persistence.stop()}
  });

  it('retains every pending original and refuses replay when a pending row is malformed',async()=>{
    const kv=mockKV(),invalid={q:'malformed',c:1},valid={q:1,id:'obs_valid',s:'s',e:Buffer.from(v(1).buffer).toString('base64')};
    await kv.set(PENDING_SCOPE,'~clear',invalid);await kv.set(PENDING_SCOPE,'obs_valid',valid);
    const vector=new VectorIndex(),p=new IndexPersistence(kv as never,vector,{requireRecoveryPlan:true});
    try{await p.prepareBackfill(await p.load());await p.replayPendingLog(3);await p.save();expect(pendingRows(kv).get('~clear')).toEqual(invalid);expect(pendingRows(kv).get('obs_valid')).toEqual(valid);expect(vector.has('obs_valid')).toBe(false);expect(p.isRecoveryPaused()).toBe(true);expect(p.status().pendingLogKnown).toBe(false)}finally{p.stop()}
  });
  it('retains all pending originals when an embedding is undecodable',async()=>{
    const kv=mockKV(),invalid={q:1,id:'obs_bad',s:'s',e:'%%%'},valid={q:2,id:'obs_ok',s:'s',e:Buffer.from(v(1).buffer).toString('base64')};
    await kv.set(PENDING_SCOPE,'obs_bad',invalid);await kv.set(PENDING_SCOPE,'obs_ok',valid);
    const vector=new VectorIndex(),p=new IndexPersistence(kv as never,vector,{requireRecoveryPlan:true});
    try{await p.prepareBackfill(await p.load());await p.replayPendingLog(3);await p.save();expect(pendingRows(kv).get('obs_bad')).toEqual(invalid);expect(pendingRows(kv).get('obs_ok')).toEqual(valid);expect(vector.size).toBe(0);expect(p.isRecoveryPaused()).toBe(true);expect(p.status().pendingLogKnown).toBe(false)}finally{p.stop()}
  });

  it('retains healthy startup replay when no storage hold is present', async () => {
    const kv=mockKV();const original={q:1,id:'obs_healthy',s:'ses_healthy',e:Buffer.from(v(1).buffer).toString('base64')};
    await kv.set(PENDING_SCOPE,'obs_healthy',original);const vector=new VectorIndex();
    const persistence=new IndexPersistence(kv as never,vector,{requireRecoveryPlan:true,isStorageHeld:()=>false} as never);
    try{const loaded=await persistence.load();await persistence.prepareBackfill(loaded);const replay=await persistence.replayPendingLog(3);expect(replay.added).toBe(1);expect(vector.has('obs_healthy')).toBe(true);expect(persistence.isRecoveryPaused()).toBe(false)}finally{persistence.stop()}
  });

  it('does not apply replay read when a storage hold appears before the read returns', async () => {
    const kv=mockKV();const original={q:1,id:'obs_race',s:'ses_race',e:Buffer.from(v(1).buffer).toString('base64')};await kv.set(PENDING_SCOPE,'obs_race',original);
    let held=false,release!:()=>void,entered!:()=>void;const wait=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r),base=kv.list;
    kv.list=async <T>(scope:string)=>{if(scope===PENDING_SCOPE){entered();await wait}return base<T>(scope)};
    const vector=new VectorIndex(),persistence=new IndexPersistence(kv as never,vector,{requireRecoveryPlan:true,isStorageHeld:()=>held} as never);
    try{await persistence.prepareBackfill(await persistence.load());const replay=persistence.replayPendingLog(3);await started;held=true;release();await replay;await persistence.save();expect(vector.has('obs_race')).toBe(false);expect(pendingRows(kv).get('obs_race')).toEqual(original);expect(persistence.isRecoveryPaused()).toBe(true)}finally{persistence.stop()}
  });

  it('retains pending entries if a storage hold arrives during a checkpoint write', async () => {
    const kv=mockKV(),original={q:1,id:'obs_during_save',s:'s',e:Buffer.from(v(1).buffer).toString('base64')};await kv.set(PENDING_SCOPE,'obs_during_save',original);
    let held=false,release!:()=>void,entered!:()=>void;const wait=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r),base=kv.set;
    kv.set=async <T>(scope:string,key:string,data:T)=>{if(scope===INDEX_SCOPE&&key==='vectors:meta'){entered();await wait}return base(scope,key,data)};
    const vector=new VectorIndex(),p=new IndexPersistence(kv as never,vector,{requireRecoveryPlan:true,isStorageHeld:()=>held} as never);
    try{await p.prepareBackfill(await p.load());await p.replayPendingLog(3);const saving=p.save();await started;held=true;release();await saving;expect(pendingRows(kv).get('obs_during_save')).toEqual(original);expect(p.isRecoveryPaused()).toBe(true)}finally{p.stop()}
  });

  it('characterizes unresolved delete already sent when storage hold appears', async () => {
    const kv=mockKV(),original={q:1,id:'obs_inflight',s:'s',e:Buffer.from(v(1).buffer).toString('base64')};await kv.set(PENDING_SCOPE,'obs_inflight',original);
    let held=false,release!:()=>void,entered!:()=>void;const wait=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r),base=kv.delete;
    kv.delete=async(scope:string,key:string)=>{if(scope===PENDING_SCOPE&&key==='obs_inflight'){entered();await wait}await base(scope,key)};
    const vector=new VectorIndex(),p=new IndexPersistence(kv as never,vector,{requireRecoveryPlan:true,isStorageHeld:()=>held} as never);
    try{await p.prepareBackfill(await p.load());await p.replayPendingLog(3);const saving=p.save();await started;held=true;release();await saving;expect(pendingRows(kv).has('obs_inflight')).toBe(false)}finally{p.stop()}
  });

  it('characterizes a transient storage hold missed between asynchronous checks', async () => {
    const kv=mockKV(),original={q:1,id:'obs_aba',s:'s',e:Buffer.from(v(1).buffer).toString('base64')};await kv.set(PENDING_SCOPE,'obs_aba',original);
    let held=false,release!:()=>void,entered!:()=>void;const wait=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r),base=kv.list;
    kv.list=async<T>(scope:string)=>{if(scope===PENDING_SCOPE){entered();await wait}return base<T>(scope)};
    const vector=new VectorIndex(),p=new IndexPersistence(kv as never,vector,{requireRecoveryPlan:true,isStorageHeld:()=>held} as never);
    try{await p.prepareBackfill(await p.load());const replay=p.replayPendingLog(3);await started;held=true;held=false;release();await replay;expect(vector.has('obs_aba')).toBe(true)}finally{p.stop()}
  });
  it('rejects replay when the admitted hold generation changes during a read', async () => {
    const kv=mockKV(),original={q:1,id:'obs_epoch',s:'s',e:Buffer.from(v(1).buffer).toString('base64')};await kv.set(PENDING_SCOPE,'obs_epoch',original);
    let held=false,generation=0,release!:()=>void,entered!:()=>void;const wait=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r),base=kv.list;
    kv.list=async<T>(scope:string)=>{if(scope===PENDING_SCOPE){entered();await wait}return base<T>(scope)};
    const vector=new VectorIndex(),p=new IndexPersistence(kv as never,vector,{requireRecoveryPlan:true,isStorageHeld:()=>held,storageGeneration:()=>generation} as never);
    try{await p.prepareBackfill(await p.load());const replay=p.replayPendingLog(3);await started;held=true;generation++;held=false;release();await replay;expect(vector.has('obs_epoch')).toBe(false);expect(pendingRows(kv).get('obs_epoch')).toEqual(original);expect(p.isRecoveryPaused()).toBe(true)}finally{p.stop()}
  });

  it("writes a compact entry for every added vector and a tombstone for every removal", async () => {
    const kv = mockKV();
    const vector = new VectorIndex();
    const persistence = new IndexPersistence(kv as never, vector, { saveIntervalMs: 600_000 });

    vector.add("obs_a", "ses_1", v(1));
    vector.add("mem_b", "ses_2", v(2));
    vector.remove("obs_a");
    await persistence.flushPendingLog();

    const rows = pendingRows(kv);
    expect(rows.size).toBe(2);
    expect(rows.get("obs_a")).toMatchObject({ id: "obs_a", t: 1 });
    expect(rows.get("mem_b")).toMatchObject({ id: "mem_b", s: "ses_2", k: "memory" });
    expect(typeof rows.get("mem_b")!.e).toBe("string");
    expect(rows.get("obs_a")!.q as number).toBeGreaterThan(rows.get("mem_b")!.q as number);
    expect(persistence.status().pendingLog).toBe(2);
    expect(persistence.status().pendingLogAcknowledged).toBe(2);
  });

  it("acknowledges a pending row only after its write succeeds even beyond five seconds", async () => {
    vi.useFakeTimers();
    const kv = mockKV();
    const slow = {
      ...kv,
      set: async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (scope === PENDING_SCOPE) await new Promise((resolve) => setTimeout(resolve, 6_000));
        return kv.set(scope, key, data);
      },
    };
    const vector = new VectorIndex();
    const persistence = new IndexPersistence(slow as never, vector, { saveIntervalMs: 600_000 });
    vector.add("obs_slow", "ses_1", v(1));

    await vi.advanceTimersByTimeAsync(5_001);
    expect(persistence.status()).toMatchObject({ pendingLog: 1, pendingLogAcknowledged: 0 });
    expect(pendingRows(kv).size).toBe(0);

    await vi.advanceTimersByTimeAsync(999);
    await persistence.flushPendingLog();
    expect(persistence.status().pendingLogAcknowledged).toBe(1);
  });

  it("counts successful keys independently when writes finish out of order", async () => {
    vi.useFakeTimers();
    const kv = mockKV();
    const delayed = {
      ...kv,
      set: async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (scope === PENDING_SCOPE) await new Promise((resolve) => setTimeout(resolve, key === "obs_first" ? 6_000 : 1_000));
        return kv.set(scope, key, data);
      },
    };
    const vector = new VectorIndex();
    const persistence = new IndexPersistence(delayed as never, vector, { saveIntervalMs: 600_000 });
    vector.add("obs_first", "ses_1", v(1));
    vector.add("obs_second", "ses_1", v(2));

    await vi.advanceTimersByTimeAsync(1_000);
    expect([...pendingRows(kv).keys()]).toEqual(["obs_second"]);
    expect(persistence.status()).toMatchObject({ pendingLog: 2, pendingLogAcknowledged: 1 });

    await vi.advanceTimersByTimeAsync(5_000);
    await persistence.flushPendingLog();
    expect(persistence.status().pendingLogAcknowledged).toBe(2);
  });

  it("does not acknowledge a failed row when an unrelated success clears the error", async () => {
    const kv = mockKV();
    const failing = {
      ...kv,
      set: async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (scope === PENDING_SCOPE && key === "obs_failed") throw new Error("pending write refused");
        return kv.set(scope, key, data);
      },
    };
    const vector = new VectorIndex();
    const persistence = new IndexPersistence(failing as never, vector, { saveIntervalMs: 600_000 });
    vector.add("obs_failed", "ses_1", v(1));
    await persistence.flushPendingLog();
    expect(persistence.status().pendingLogError).toContain("pending write refused");

    vector.add("obs_ok", "ses_1", v(2));
    await persistence.flushPendingLog();
    expect(persistence.status()).toMatchObject({ pendingLog: 2, pendingLogAcknowledged: 1, pendingLogError: null });
    expect([...pendingRows(kv).keys()]).toEqual(["obs_ok"]);
  });

  it("requires the latest same-key write acknowledgment and invalidates an earlier success", async () => {
    vi.useFakeTimers();
    const kv = mockKV();
    const slow = {
      ...kv,
      set: async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (scope === PENDING_SCOPE) await new Promise((resolve) => setTimeout(resolve, 6_000));
        return kv.set(scope, key, data);
      },
    };
    const vector = new VectorIndex();
    const persistence = new IndexPersistence(slow as never, vector, { saveIntervalMs: 600_000 });
    vector.add("obs_latest", "ses_1", v(1));
    await vi.advanceTimersByTimeAsync(0);
    vector.add("obs_latest", "ses_1", v(2));

    await vi.advanceTimersByTimeAsync(6_000);
    expect(pendingRows(kv).size).toBe(1);
    expect(persistence.status()).toMatchObject({ pendingLog: 1, pendingLogAcknowledged: 0 });

    await vi.advanceTimersByTimeAsync(6_000);
    await persistence.flushPendingLog();
    expect(persistence.status().pendingLogAcknowledged).toBe(1);

    vector.remove("obs_latest");
    expect(persistence.status().pendingLogAcknowledged).toBe(0);
    await vi.advanceTimersByTimeAsync(6_000);
    await persistence.flushPendingLog();
    expect(persistence.status().pendingLogAcknowledged).toBe(1);
    expect(pendingRows(kv).get("obs_latest")).toMatchObject({ t: 1 });
  });

  it("does nothing when there is no vector index", async () => {
    const kv = mockKV();
    const persistence = new IndexPersistence(kv as never, null);
    const standalone = new VectorIndex();
    standalone.add("obs_a", "ses_1", v(1));
    await persistence.save();
    const replay = await persistence.replayPendingLog(3);

    expect(kv.store.get(PENDING_SCOPE)).toBeUndefined();
    expect(kv.ops.filter((o) => o.scope === PENDING_SCOPE)).toEqual([]);
    expect(replay.entries).toBe(0);
    expect(persistence.status().pendingLog).toBe(0);
    expect(persistence.status().pendingLogAcknowledged).toBe(0);
  });

  it("replays adds and removals after a force-kill without any embedding calls", async () => {
    const kv = mockKV();
    const first = await boot(kv);
    first.vector.add("obs_1", "ses_1", v(1));
    first.vector.add("obs_2", "ses_1", v(2));
    await first.persistence.save();
    expect(pendingRows(kv).size).toBe(0);

    first.vector.add("obs_3", "ses_1", v(3));
    first.vector.add("obs_4", "ses_1", v(4));
    first.vector.remove("obs_1");
    await first.persistence.flushPendingLog();
    first.persistence.stop();

    const embed = vi.fn();
    const second = await boot(kv);
    expect(embed).not.toHaveBeenCalled();
    expect([...second.vector.entries()].map(([id]) => id).sort()).toEqual(["obs_2", "obs_3", "obs_4"]);
    expect(Array.from(second.vector.get("obs_3")!.embedding)).toEqual(Array.from(v(3)));
    expect(second.persistence.status().pendingLog).toBe(3);
    expect(second.persistence.status().pendingLogAcknowledged).toBe(3);

    await second.persistence.save();
    expect(pendingRows(kv).size).toBe(0);
    expect(second.persistence.status().pendingLogAcknowledged).toBe(0);
    const third = await boot(kv);
    expect([...third.vector.entries()].map(([id]) => id).sort()).toEqual(["obs_2", "obs_3", "obs_4"]);
  });

  it("preserves the pending log when any vector dimension does not match", async () => {
    const kv = mockKV();
    const first = await boot(kv);
    first.vector.add("obs_ok", "ses_1", v(1));
    first.vector.add("obs_wide", "ses_1", new Float32Array([1, 2, 3, 4]));
    await first.persistence.flushPendingLog();

    const vector = new VectorIndex();
    const persistence = new IndexPersistence(kv as never, vector);
    await persistence.load();
    const replay = await persistence.replayPendingLog(3);
    expect(replay).toMatchObject({ added: 0 });
    expect(persistence.isRecoveryPaused()).toBe(true);
    expect(pendingRows(kv).size).toBe(2);
    expect(vector.has("obs_ok")).toBe(false);
    expect(vector.has("obs_wide")).toBe(false);
  });

  it("clears only the entries a snapshot covered", async () => {
    const kv = mockKV();
    let release: () => void = () => undefined;
    let gate: Promise<void> | null = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = {
      ...kv,
      set: async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (scope !== PENDING_SCOPE && gate) await gate;
        return kv.set(scope, key, data);
      },
    };
    const vector = new VectorIndex();
    const persistence = new IndexPersistence(slow as never, vector, { saveIntervalMs: 600_000 });
    vector.add("obs_before", "ses_1", v(1));
    await persistence.flushPendingLog();

    const saving = persistence.save();
    vector.add("obs_during", "ses_1", v(2));
    await persistence.flushPendingLog();
    gate = null;
    release();
    await saving;

    expect([...pendingRows(kv).keys()]).toEqual(["obs_during"]);
    expect(persistence.status().pendingLog).toBe(1);
    expect(persistence.status().pendingLogAcknowledged).toBe(1);
  });

  it("keeps every entry when the snapshot write fails", async () => {
    const kv = mockKV();
    const failing = {
      ...kv,
      set: async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (scope === INDEX_SCOPE) throw new Error("state write refused");
        return kv.set(scope, key, data);
      },
    };
    const vector = new VectorIndex();
    const persistence = new IndexPersistence(failing as never, vector, { saveIntervalMs: 600_000 });
    vector.add("obs_1", "ses_1", v(1));
    vector.add("obs_2", "ses_1", v(2));
    await persistence.save();

    expect(persistence.status().vector?.lastError).toContain("state write refused");
    expect(pendingRows(kv).size).toBe(2);
    expect(persistence.status().pendingLogAcknowledged).toBe(2);
    expect(kv.ops.filter((o) => o.op === "delete" && o.scope === PENDING_SCOPE)).toEqual([]);
  });

  it("orders replay by sequence, not by list order, including a full clear", async () => {
    const kv = mockKV({ shuffle: true });
    const first = await boot(kv);
    first.vector.add("obs_old", "ses_1", v(1));
    await first.persistence.save();
    first.vector.add("obs_gone", "ses_1", v(2));
    first.vector.clear();
    first.vector.add("obs_new", "ses_1", v(3));
    first.vector.add("obs_flip", "ses_1", v(4));
    first.vector.remove("obs_flip");
    first.vector.add("obs_flip", "ses_1", v(5));
    await first.persistence.flushPendingLog();

    const second = await boot(kv);
    expect([...second.vector.entries()].map(([id]) => id).sort()).toEqual(["obs_flip", "obs_new"]);
    expect(Array.from(second.vector.get("obs_flip")!.embedding)).toEqual(Array.from(v(5)));
    expect(second.persistence.status().pendingLogAcknowledged).toBe(pendingRows(kv).size);

    await second.persistence.save();
    expect(pendingRows(kv).size).toBe(0);
    expect(second.persistence.status().pendingLogAcknowledged).toBe(0);
    const third = await boot(kv);
    expect([...third.vector.entries()].map(([id]) => id).sort()).toEqual(["obs_flip", "obs_new"]);
  });

  it("saves early once the log grows past its bound", async () => {
    vi.useFakeTimers();
    const kv = mockKV();
    const vector = new VectorIndex();
    const persistence = new IndexPersistence(kv as never, vector, { saveIntervalMs: 600_000 });
    await vi.advanceTimersByTimeAsync(6_000);
    const metaSet = () => kv.ops.some((o) => o.op === "set" && o.key === "vectors:meta");
    for (let i = 0; i < 520; i++) vector.add(`obs_${i}`, "ses_1", v(i));
    expect(metaSet()).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(persistence.status().saving || metaSet()).toBe(true);
    await persistence.save();
    await persistence.flushPendingLog();

    expect(kv.ops.some((o) => o.op === "set" && o.key === "vectors:meta")).toBe(true);
    expect(pendingRows(kv).size).toBe(0);
  });
});

describe("durable vector backlog", () => {
  afterEach(() => {
    getSearchIndex().clear();
    setVectorIndex(null);
    setEmbeddingProvider(null);
    setIndexPersistence(null);
  });

  function seed(kv: MockKV, count: number, timestamp: string): void {
    const sessionId = "ses_0";
    kv.store.set("mem:sessions", new Map([[sessionId, { id: sessionId, project: "p", cwd: "/tmp", startedAt: timestamp, status: "completed", observationCount: count } as Session]]));
    const scope = new Map<string, unknown>();
    for (let i = 0; i < count; i++) {
      const id = `obs_${String(i).padStart(3, "0")}`;
      scope.set(id, {
        id,
        sessionId,
        timestamp,
        type: "file_edit",
        title: `change ${i}`,
        facts: [],
        narrative: `narrative for change ${i}`,
        concepts: [],
        files: [],
        importance: 5,
      } satisfies CompressedObservation);
    }
    kv.store.set(`mem:obs:${sessionId}`, scope);
  }

  function provider(failAfterCalls: number | null, calls: { n: number }): EmbeddingProvider {
    return {
      name: "stub",
      dimensions: 3,
      embed: async () => new Float32Array([0.1, 0.2, 0.3]),
      embedBatch: async (texts: string[]) => {
        calls.n++;
        if (failAfterCalls !== null && calls.n > failAfterCalls) throw new Error("provider down");
        return texts.map(() => new Float32Array([0.1, 0.2, 0.3]));
      },
    } as EmbeddingProvider;
  }

  it("keeps the backfill marker until the backlog is done and resumes after a restart", async () => {
    process.env.REBUILD_EMBED_BATCH_SIZE = "5";
    try {
      const kv = mockKV();
      seed(kv, 12, "2026-09-02T00:00:00.000Z");

      const first = await boot(kv);
      setVectorIndex(first.vector);
      setIndexPersistence(first.persistence);
      const calls = { n: 0 };
      setEmbeddingProvider(provider(1, calls));
      await first.persistence.markBackfillSince("2026-09-01T00:00:00.000Z");
      const rebuilt = await rebuildKeywordIndex(kv as never, "2026-09-01T00:00:00.000Z");
      expect(rebuilt.vectorJobs).toHaveLength(12);

      const run = await backfillVectorBacklog(rebuilt.vectorJobs, { batchSize: 5, pauseMs: 0 });
      expect(run).toMatchObject({ added: 5, complete: false, remaining: 7 });
      expect(getPendingVectorBackfillCount()).toBe(7);
      expect(await first.persistence.readBackfillMarker()).toBe("2026-09-01T00:00:00.000Z");
      await first.persistence.flushPendingLog();
      first.persistence.stop();

      await first.persistence.markBackfillSince("2026-09-03T00:00:00.000Z");
      expect(await first.persistence.readBackfillMarker()).toBe("2026-09-01T00:00:00.000Z");

      getSearchIndex().clear();
      const second = await boot(kv);
      expect(second.vector.size).toBe(5);
      setVectorIndex(second.vector);
      setIndexPersistence(second.persistence);
      const resumedCalls = { n: 0 };
      setEmbeddingProvider(provider(null, resumedCalls));
      const since = await second.persistence.readBackfillMarker();
      const resumed = await rebuildKeywordIndex(kv as never, since);
      expect(resumed.vectorJobs).toHaveLength(7);

      const done = await backfillVectorBacklog(resumed.vectorJobs, { batchSize: 5, pauseMs: 0 });
      expect(done).toMatchObject({ added: 7, complete: true, remaining: 0 });
      expect(second.vector.size).toBe(12);
      expect(resumedCalls.n).toBe(2);
      await second.persistence.clearBackfillMarker();
      expect(await second.persistence.readBackfillMarker()).toBeUndefined();
    } finally {
      delete process.env.REBUILD_EMBED_BATCH_SIZE;
    }
  });

  it("does not cap incremental recovery at AGENTMEMORY_VECTOR_BACKFILL_MAX", async () => {
    process.env.AGENTMEMORY_VECTOR_BACKFILL_MAX = "4";
    try {
      const kv = mockKV();
      seed(kv, 10, "2026-09-02T00:00:00.000Z");
      setVectorIndex(new VectorIndex());
      setEmbeddingProvider(provider(null, { n: 0 }));
      const rebuilt = await rebuildKeywordIndex(kv as never, "2026-09-01T00:00:00.000Z");
      expect(rebuilt.vectorJobs).toHaveLength(10);
      const run = await backfillVectorBacklog(rebuilt.vectorJobs, { pauseMs: 0 });
      expect(run).toMatchObject({ added: 10, complete: true });
    } finally {
      delete process.env.AGENTMEMORY_VECTOR_BACKFILL_MAX;
    }
  });
});

describe("SDK-only release after a storage hold", () => {
  function fixture() {
    const kv = Object.assign(mockKV(), {
      durability: createStateDurabilityFence({ storePath: "/unused-synthetic-sdk-store", completion: "sdk" }),
    });
    let held = true;
    const vector = new VectorIndex();
    const persistence = new IndexPersistence(kv as never, vector, {
      requireRecoveryPlan: true, isStorageHeld: () => held, saveIntervalMs: 600_000,
    });
    return { kv, vector, persistence, release: () => { held = false; } };
  }

  it("retains three original pending records before any checkpoint writes or replay", async () => {
    const { kv, vector, persistence, release } = fixture();
    for (const [q, id] of ["first", "second", "third"].entries()) {
      await kv.set(PENDING_SCOPE, id, { q: q + 1, id, s: "test", e: Buffer.from(v(q).buffer).toString("base64") });
    }
    const original = new Map(pendingRows(kv));
    try {
      await persistence.load();
      release();
      kv.ops.length = 0;
      const resumed = await persistence.resumeStorageRecovery(3);
      await persistence.save();
      expect(pendingRows(kv)).toEqual(original);
      expect(resumed).toBe(false);
      expect(persistence.status().vector?.lastError).toContain("durable reconciliation");
      expect(vector.size).toBe(0);
      expect(kv.ops.filter(op => op.op !== "list")).toEqual([]);
      expect(persistence.isRecoveryPaused()).toBe(true);
    } finally { persistence.stop(); }
  });

  it.each(["failed read", "invalid response", "new row after first read"])("keeps the SDK release held for %s", async mode => {
    const { kv, vector, persistence, release } = fixture();
    const list = kv.list;
    let reads = 0;
    kv.list = async scope => {
      if (scope === PENDING_SCOPE) {
        reads++;
        if (mode === "failed read") throw new Error("synthetic timeout");
        if (mode === "invalid response") return null as never;
        if (reads === 2) return [{ q: 1, id: "later", t: 1 }] as never;
      }
      return list(scope);
    };
    try {
      await persistence.load();
      release();
      expect(await persistence.resumeStorageRecovery(3)).toBe(false);
      expect(persistence.isRecoveryPaused()).toBe(true);
      expect(vector.size).toBe(0);
      expect(kv.ops.some(op => op.op === "delete")).toBe(false);
      expect(kv.ops.some(op => op.op === "set")).toBe(false);
    } finally { persistence.stop(); }
  });

  it("allows SDK release when the pending namespace is empty", async () => {
    const { persistence, release } = fixture();
    try {
      await persistence.load();
      release();
      expect(await persistence.resumeStorageRecovery(3)).toBe(true);
      expect(persistence.isRecoveryPaused()).toBe(false);
    } finally { persistence.stop(); }
  });
});

describe('explicit storage recovery release',()=>{
 it('retries held startup recovery in the same process only after release',async()=>{
  const kv=mockKV(),row={q:1,id:'obs_resume',s:'s',e:Buffer.from(v(1).buffer).toString('base64')};await kv.set(PENDING_SCOPE,'obs_resume',row);
  let held=true,generation=0;const vector=new VectorIndex();const p=new IndexPersistence(kv as never,vector,{requireRecoveryPlan:true,isStorageHeld:()=>held,storageGeneration:()=>generation} as never);
  try{await p.load();expect(await (p as any).resumeStorageRecovery(3)).toBe(false);expect(pendingRows(kv).get('obs_resume')).toEqual(row);held=false;generation++;expect(await (p as any).resumeStorageRecovery(3)).toBe(true);expect(vector.has('obs_resume')).toBe(true);expect(p.isRecoveryPaused()).toBe(false)}finally{p.stop()}
 });
 it('rejects vector mutation before changing memory while storage is held',async()=>{
  const kv=mockKV(),vector=new VectorIndex();let held=true;const p=new IndexPersistence(kv as never,vector,{requireRecoveryPlan:true,isStorageHeld:()=>held} as never);
  try{expect(()=>vector.add('new','s',v(1))).toThrow(/VECTOR_RECOVERY_PAUSED/);expect(vector.has('new')).toBe(false);expect(pendingRows(kv).size).toBe(0)}finally{p.stop()}
 });
 it('keeps recovery paused and originals intact when release reload fails',async()=>{
  const kv=mockKV(),row={q:1,id:'obs_fail',s:'s',e:Buffer.from(v(1).buffer).toString('base64')};await kv.set(PENDING_SCOPE,'obs_fail',row);let held=true;const vector=new VectorIndex();const p=new IndexPersistence(kv as never,vector,{requireRecoveryPlan:true,isStorageHeld:()=>held} as never);
  try{await p.load();held=false;kv.get=async()=>{throw Error('synthetic read failure')};expect(await (p as any).resumeStorageRecovery(3)).toBe(false);expect(p.isRecoveryPaused()).toBe(true);expect(pendingRows(kv).get('obs_fail')).toEqual(row);expect(vector.size).toBe(0)}finally{p.stop()}
 });
});

it('rejects foreground vector changes while a released storage checkpoint is loading',async()=>{const kv=mockKV();let held=true,release!:()=>void,entered!:()=>void;const wait=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r),get=kv.get;const vector=new VectorIndex(),p=new IndexPersistence(kv as never,vector,{requireRecoveryPlan:true,isStorageHeld:()=>held} as never);try{await p.load();held=false;kv.get=async<T>(scope:string,key:string)=>{if(scope===INDEX_SCOPE&&key==='vectors:meta'){entered();await wait}return get<T>(scope,key)};const resume=(p as any).resumeStorageRecovery(3);await started;expect(()=>vector.add('during','s',v(1))).toThrow(/VECTOR_RECOVERY_PAUSED/);expect(vector.has('during')).toBe(false);release();expect(await resume).toBe(true)}finally{p.stop()}});
it('does not claim successful vector recovery when pending-log read fails',async()=>{const kv=mockKV();let held=true;const list=kv.list;const vector=new VectorIndex(),p=new IndexPersistence(kv as never,vector,{requireRecoveryPlan:true,isStorageHeld:()=>held} as never);try{await p.load();held=false;kv.list=async<T>(scope:string)=>{if(scope===PENDING_SCOPE)throw Error('synthetic pending read failure');return list<T>(scope)};expect(await (p as any).resumeStorageRecovery(3)).toBe(false);expect(p.isRecoveryPaused()).toBe(true)}finally{p.stop()}});
it('allows an explicit retry after a transient pending-log read failure',async()=>{const kv=mockKV(),row={q:1,id:'retry','s':'s',e:Buffer.from(v(1).buffer).toString('base64')};await kv.set(PENDING_SCOPE,'retry',row);let held=true;const list=kv.list;const vector=new VectorIndex(),p=new IndexPersistence(kv as never,vector,{requireRecoveryPlan:true,isStorageHeld:()=>held} as never);try{await p.load();held=false;kv.list=async<T>(scope:string)=>{if(scope===PENDING_SCOPE)throw Error('temporary');return list<T>(scope)};expect(await (p as any).resumeStorageRecovery(3)).toBe(false);kv.list=list;expect(await (p as any).resumeStorageRecovery(3)).toBe(true);expect(vector.has('retry')).toBe(true);expect(p.status().pendingLogError).toBeNull()}finally{p.stop()}});
