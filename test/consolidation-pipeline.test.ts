import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/config.js", () => ({
  getConsolidationDecayDays: () => 30,
  getEnvVar: () => undefined,
  isConsolidationEnabled: vi.fn(() => true),
}));

import { registerConsolidationPipelineFunction } from "../src/functions/consolidation-pipeline.js";
import { isConsolidationEnabled } from "../src/config.js";
import { currentAuditScope } from "./helpers/mocks.js";
import type { SessionSummary, Memory, SemanticMemory, ProceduralMemory } from "../src/types.js";

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

function makeSummary(i: number): SessionSummary {
  return {
    sessionId: `ses_${i}`,
    project: "test-project",
    createdAt: new Date(Date.now() - i * 86400000).toISOString(),
    title: `Session ${i} summary`,
    narrative: `TypeScript is the primary language. Worked on feature ${i}`,
    keyDecisions: [`Decision ${i}`],
    filesModified: [`src/file${i}.ts`],
    concepts: ["typescript", "testing"],
    observationCount: 5,
  };
}

function makePattern(i: number): Memory {
  return {
    id: `mem_${i}`,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    type: "pattern",
    title: `Pattern ${i}`,
    content: `Always do thing ${i}`,
    concepts: ["testing"],
    files: [],
    sessionIds: ["ses_1", "ses_2"],
    strength: 5,
    version: 1,
    isLatest: true,
  };
}

function makeSemanticMemory(overrides: Partial<SemanticMemory> = {}): SemanticMemory {
  const now = new Date().toISOString();
  return {
    id: "sem_1",
    fact: "TypeScript is the primary language",
    confidence: 0.9,
    sourceSessionIds: [],
    sourceMemoryIds: [],
    accessCount: 1,
    lastAccessedAt: now,
    strength: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeProceduralMemory(overrides: Partial<ProceduralMemory> = {}): ProceduralMemory {
  const now = new Date().toISOString();
  return {
    id: "proc_1",
    name: "Test Workflow",
    steps: ["step 1"],
    triggerCondition: "always",
    frequency: 1,
    sourceSessionIds: [],
    strength: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("Consolidation Pipeline", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
  });

  it("pipeline skips semantic when fewer than 5 summaries", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    for (let i = 0; i < 3; i++) {
      await kv.set("mem:summaries", `ses_${i}`, makeSummary(i));
    }

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
    })) as { success: boolean; results: Record<string, unknown> };

    expect(result.success).toBe(true);
    const semantic = result.results.semantic as { skipped: boolean; reason: string };
    expect(semantic.skipped).toBe(true);
    expect(semantic.reason).toContain("fewer than 5");
    expect(provider.summarize).not.toHaveBeenCalled();
  });

  it("pipeline skips procedural when fewer than 2 patterns", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    const mem: Memory = {
      ...makePattern(1),
      sessionIds: ["ses_1", "ses_2"],
    };
    await kv.set("mem:memories", "mem_1", mem);

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "procedural",
    })) as { success: boolean; results: Record<string, unknown> };

    expect(result.success).toBe(true);
    const procedural = result.results.procedural as { skipped: boolean; reason: string };
    expect(procedural.skipped).toBe(true);
    expect(procedural.reason).toContain("fewer than 2");
  });

  it("with enough summaries, creates semantic memories from provider response", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue(
        `<facts><fact confidence="0.9">TypeScript is the primary language</fact></facts>`,
      ),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    for (let i = 0; i < 6; i++) {
      await kv.set("mem:summaries", `ses_${i}`, makeSummary(i));
    }

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
    })) as { success: boolean; results: Record<string, unknown> };

    expect(result.success).toBe(true);
    const semantic = result.results.semantic as { newFacts: number };
    expect(semantic.newFacts).toBe(1);

    const stored = await kv.list<SemanticMemory>("mem:semantic");
    expect(stored.length).toBe(1);
    expect(stored[0].fact).toBe("TypeScript is the primary language");
    expect(stored[0].confidence).toBe(0.9);
  });

  it("accepts native facts JSON, grounds provenance and skips unchanged corpus", async () => {
    const provider = {name:"test",compress:vi.fn(),summarize:vi.fn().mockResolvedValue(JSON.stringify({facts:[{confidence:0.9,fact:"TypeScript is the primary language"},{confidence:0.8,fact:"Mars runs a golden database"}]}))};
    for(let i=0;i<6;i++)await kv.set("mem:summaries",`ses_${i}`,makeSummary(i));
    registerConsolidationPipelineFunction(sdk as never,kv as never,provider as never);
    const first:any=await sdk.trigger("mem::consolidate-pipeline",{tier:"semantic"});
    expect(first.success).toBe(true);expect(first.results.semantic.newFacts).toBe(1);
    const facts=await kv.list<SemanticMemory>("mem:semantic");expect(facts[0].sourceSessionIds).toHaveLength(6);
    await sdk.trigger("mem::consolidate-pipeline",{tier:"semantic"});expect(provider.summarize).toHaveBeenCalledTimes(1);
  });

  it("invalid semantic output reports partial failure without checkpoint or data write", async () => {
    const provider={name:"test",compress:vi.fn(),summarize:vi.fn().mockResolvedValue('{"facts":[{"confidence":4,"fact":"TypeScript is the primary language"}]}')};
    for(let i=0;i<5;i++)await kv.set("mem:summaries",`ses_${i}`,makeSummary(i));
    registerConsolidationPipelineFunction(sdk as never,kv as never,provider as never);
    const result:any=await sdk.trigger("mem::consolidate-pipeline",{tier:"semantic"});
    expect(result.success).toBe(false);expect(await kv.list("mem:semantic")).toEqual([]);
    expect(await kv.get("mem:config","consolidation:semanticFingerprint:v2")).toBeNull();
  });

  it("with enough patterns, creates procedural memories from provider response", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue(
        `<procedures><procedure name="Test Workflow" trigger="when writing tests"><step>Create test file</step><step>Write assertions</step></procedure></procedures>`,
      ),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    for (let i = 0; i < 3; i++) {
      await kv.set("mem:memories", `mem_${i}`, makePattern(i));
    }

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "procedural",
    })) as { success: boolean; results: Record<string, unknown> };

    expect(result.success).toBe(true);
    const procedural = result.results.procedural as { newProcedures: number };
    expect(procedural.newProcedures).toBe(1);

    const stored = await kv.list<ProceduralMemory>("mem:procedural");
    expect(stored.length).toBe(1);
    expect(stored[0].name).toBe("Test Workflow");
    expect(stored[0].steps.length).toBe(2);
    expect(stored[0].triggerCondition).toBe("when writing tests");
  });

  it("skips unchanged procedural input after restart even when pattern order changes", async () => {
    const provider = { name: "test", compress: vi.fn(), summarize: vi.fn(async () =>
      '<procedures><procedure name="Test Workflow" trigger="testing"><step>Write assertions</step></procedure></procedures>') };
    const originalList = kv.list;
    let reversed = false;
    kv.list = async <T>(scope: string) => {
      const rows = await originalList<T>(scope);
      return scope === "mem:memories" && reversed ? rows.reverse() : rows;
    };
    for (let i = 0; i < 2; i++) await kv.set("mem:memories", `mem_${i}`, makePattern(i));
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    await sdk.trigger("mem::consolidate-pipeline", { tier: "procedural" });
    const saved = structuredClone(await kv.list<ProceduralMemory>("mem:procedural"));
    reversed = true;
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    const unchanged: any = await sdk.trigger("mem::consolidate-pipeline", { tier: "procedural" });
    expect(unchanged.results.procedural).toMatchObject({ skipped: true, reason: "patterns unchanged" });
    expect(await kv.list("mem:procedural")).toEqual(saved);
    expect(provider.summarize).toHaveBeenCalledOnce();
    await kv.set("mem:memories", "mem_0", { ...makePattern(0), content: "Changed recurring workflow" });
    await sdk.trigger("mem::consolidate-pipeline", { tier: "procedural" });
    expect(provider.summarize).toHaveBeenCalledTimes(2);
    expect((await kv.list<ProceduralMemory>("mem:procedural"))[0].frequency).toBe(2);
  });

  it("retries malformed procedural output without writing procedures or a fingerprint", async () => {
    const provider = { name: "test", compress: vi.fn(), summarize: vi.fn()
      .mockResolvedValueOnce("invalid fixture")
      .mockResolvedValueOnce("<procedures></procedures>") };
    for (let i = 0; i < 2; i++) await kv.set("mem:memories", `mem_${i}`, makePattern(i));
    const original = makeProceduralMemory();
    await kv.set("mem:procedural", original.id, structuredClone(original));
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    const failed: any = await sdk.trigger("mem::consolidate-pipeline", { tier: "procedural" });
    expect(failed).toMatchObject({ success: false, results: { procedural: { error: "procedural_extraction_invalid_xml" } } });
    expect(await kv.list("mem:procedural")).toEqual([original]);
    expect(await kv.get("mem:config", "consolidation:proceduralFingerprint:v1")).toBeNull();
    expect(await sdk.trigger("mem::consolidate-pipeline", { tier: "procedural" })).toMatchObject({ success: true });
    expect(await kv.get("mem:config", "consolidation:proceduralFingerprint:v1")).not.toBeNull();
    const skipped: any = await sdk.trigger("mem::consolidate-pipeline", { tier: "procedural" });
    expect(skipped.results.procedural.skipped).toBe(true);
    expect(provider.summarize).toHaveBeenCalledTimes(2);
    expect(await kv.list("mem:procedural")).toEqual([original]);
  });

  it("consolidation records an audit entry", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    await sdk.trigger("mem::consolidate-pipeline", { tier: "semantic" });

    const audits = await kv.list(currentAuditScope());
    expect(audits.length).toBe(1);
  });

  it("pipeline returns early when consolidation is disabled", async () => {
    vi.mocked(isConsolidationEnabled).mockReturnValue(false);
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    const result = (await sdk.trigger("mem::consolidate-pipeline", {})) as {
      success: boolean;
      skipped?: boolean;
      reason?: string;
    };

    expect(result.success).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("CONSOLIDATION_ENABLED");
    expect(provider.summarize).not.toHaveBeenCalled();
    vi.mocked(isConsolidationEnabled).mockReturnValue(true);
  });

  it("pipeline proceeds with force=true even when consolidation is disabled", async () => {
    vi.mocked(isConsolidationEnabled).mockReturnValue(false);
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      force: true,
    })) as { success: boolean; results: Record<string, unknown> };

    expect(result.success).toBe(true);
    expect(result.results).toBeDefined();
    vi.mocked(isConsolidationEnabled).mockReturnValue(true);
  });
});

describe("Consolidation Pipeline decay tier", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not write rows whose decay is not yet due", async () => {
    const provider = { name: "test", compress: vi.fn(), summarize: vi.fn() };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    await kv.set(
      "mem:semantic",
      "sem_1",
      makeSemanticMemory({ id: "sem_1", lastAccessedAt: new Date().toISOString(), strength: 1 }),
    );
    await kv.set(
      "mem:procedural",
      "proc_1",
      makeProceduralMemory({ id: "proc_1", updatedAt: new Date().toISOString(), strength: 1 }),
    );

    const setSpy = vi.spyOn(kv, "set");

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "decay",
    })) as { success: boolean; results: Record<string, unknown> };

    expect(result.success).toBe(true);
    const memoryWriteCalls = setSpy.mock.calls.filter(
      (c) => c[0] === "mem:semantic" || c[0] === "mem:procedural",
    );
    expect(memoryWriteCalls.length).toBe(0);
    expect(result.results.decay).toEqual({
      semantic: { scanned: 1, written: 0 },
      procedural: { scanned: 1, written: 0 },
    });

    const storedSemantic = await kv.list<SemanticMemory>("mem:semantic");
    const storedProcedural = await kv.list<ProceduralMemory>("mem:procedural");
    expect(storedSemantic[0].strength).toBe(1);
    expect(storedProcedural[0].strength).toBe(1);
  });

  it("writes only rows whose decayed strength actually changed", async () => {
    const provider = { name: "test", compress: vi.fn(), summarize: vi.fn() };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    const staleAccess = new Date(Date.now() - 45 * 86400000).toISOString();
    const freshAccess = new Date().toISOString();

    await kv.set(
      "mem:semantic",
      "sem_stale",
      makeSemanticMemory({ id: "sem_stale", lastAccessedAt: staleAccess, strength: 1 }),
    );
    await kv.set(
      "mem:semantic",
      "sem_fresh",
      makeSemanticMemory({ id: "sem_fresh", lastAccessedAt: freshAccess, strength: 1 }),
    );

    const setSpy = vi.spyOn(kv, "set");

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "decay",
    })) as { success: boolean; results: Record<string, unknown> };

    expect(result.success).toBe(true);
    const decay = result.results.decay as {
      semantic: { scanned: number; written: number };
      procedural: { scanned: number; written: number };
    };
    expect(decay.semantic).toEqual({ scanned: 2, written: 1 });
    expect(decay.procedural).toEqual({ scanned: 0, written: 0 });

    const semanticSetCalls = setSpy.mock.calls.filter((c) => c[0] === "mem:semantic");
    expect(semanticSetCalls.length).toBe(1);
    expect(semanticSetCalls[0][1]).toBe("sem_stale");

    const stored = await kv.list<SemanticMemory>("mem:semantic");
    const stale = stored.find((s) => s.id === "sem_stale");
    const fresh = stored.find((s) => s.id === "sem_fresh");
    expect(stale?.strength).toBeCloseTo(0.9, 10);
    expect(fresh?.strength).toBe(1);
  });

  it("decays at most once per period, anchored to the previous decay", async () => {
    const provider = { name: "test", compress: vi.fn(), summarize: vi.fn() };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    const createdAt = new Date().toISOString();
    await kv.set(
      "mem:semantic",
      "sem_1",
      makeSemanticMemory({ id: "sem_1", lastAccessedAt: createdAt, strength: 1 }),
    );

    const setSpy = vi.spyOn(kv, "set");
    const semanticWrites = () =>
      setSpy.mock.calls.filter((c) => c[0] === "mem:semantic" && c[1] === "sem_1");

    await sdk.trigger("mem::consolidate-pipeline", { tier: "decay" });
    let stored = await kv.list<SemanticMemory>("mem:semantic");
    expect(stored[0].strength).toBe(1);
    expect(stored[0].lastDecayedAt).toBeUndefined();
    expect(semanticWrites().length).toBe(0);

    const day45 = new Date(new Date(createdAt).getTime() + 45 * 86400000);
    vi.setSystemTime(day45);
    await sdk.trigger("mem::consolidate-pipeline", { tier: "decay" });
    stored = await kv.list<SemanticMemory>("mem:semantic");
    expect(stored[0].strength).toBeCloseTo(0.9, 10);
    expect(stored[0].lastDecayedAt).toBe(day45.toISOString());
    expect(semanticWrites().length).toBe(1);

    const day50 = new Date(new Date(createdAt).getTime() + 50 * 86400000);
    vi.setSystemTime(day50);
    await sdk.trigger("mem::consolidate-pipeline", { tier: "decay" });
    stored = await kv.list<SemanticMemory>("mem:semantic");
    expect(stored[0].strength).toBeCloseTo(0.9, 10);
    expect(stored[0].lastDecayedAt).toBe(day45.toISOString());
    expect(semanticWrites().length).toBe(1);

    const day95 = new Date(new Date(createdAt).getTime() + 95 * 86400000);
    vi.setSystemTime(day95);
    await sdk.trigger("mem::consolidate-pipeline", { tier: "decay" });
    stored = await kv.list<SemanticMemory>("mem:semantic");
    expect(stored[0].strength).toBeCloseTo(0.81, 10);
    expect(stored[0].lastDecayedAt).toBe(day95.toISOString());
    expect(semanticWrites().length).toBe(2);
  });
});
