import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSummarizeFunction } from "../src/functions/summarize.js";
import { KV } from "../src/state/schema.js";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../src/functions/audit.js", () => ({ safeAudit: vi.fn(async () => {}) }));
const timestamp = "2026-10-14T00:00:00Z";
const summaryResponse = JSON.stringify({ title: "Captured work", narrative: "Observed coding work was retained.", keyDecisions: [], filesModified: [], concepts: [] });
function fixture(summarize: (system: string, user: string) => Promise<string>) {
  const scopes = new Map<string, Map<string, any>>(), handlers = new Map<string, (data: any) => Promise<any>>();
  const clone = <T>(value: T): T => structuredClone(value);
  const kv = {
    get: async (scope: string, id: string) => clone(scopes.get(scope)?.get(id) ?? null),
    list: async (scope: string) => clone([...(scopes.get(scope)?.values() ?? [])]),
    set: async (scope: string, id: string, value: unknown) => {
      if (!scopes.has(scope)) scopes.set(scope, new Map());
      scopes.get(scope)!.set(id, clone(value));
    },
    update: async (scope: string, id: string, updates: any[]) => {
      const row = scopes.get(scope)!.get(id);
      for (const update of updates) row[update.path] = clone(update.value);
    },
  };
  const sdk = {
    registerFunction: (id: string, handler: any) => handlers.set(id, handler),
    trigger: ({ function_id, payload }: any) => handlers.get(function_id)!(payload),
  };
  const provider = { name: "synthetic", compress: vi.fn(), summarize: vi.fn(summarize) };
  const start = (options: { schedule?: boolean } = { schedule: false }) => registerSummarizeFunction(sdk as never, kv as never, provider, undefined, options);
  const run = (options: { force?: boolean } = {}) => sdk.trigger({ function_id: "mem::summarize", payload: { sessionId: "s", ...options } });
  return { kv, provider, start, run };
}
function observation(id: string, output: string) {
  return { id, sessionId: "s", timestamp, type: "file_read", title: `Read ${id}`, files: [],
    sourceRaw: { id, sessionId: "s", timestamp, hookType: "post_tool_use", toolOutput: output, raw: {} } };
}
async function seed(f: ReturnType<typeof fixture>, pending: ReturnType<typeof observation>[]) {
  const originalSegment = { title: "Earlier work", narrative: "Previously committed evidence.", createdAt: timestamp, sourceObservationIds: ["done"] };
  const retainedHistory = [{ at: timestamp, lastError: "older-output-failure", diagnostics: { category: "output_invalid" } }];
  await f.kv.set(KV.sessions, "s", { id: "s", project: "fixture", status: "completed", startedAt: timestamp,
    observationCount: pending.length + 1, summaryProgress: { status: "queued", attempts: 0,
      blockedObservations: { done: { status: "resolved", attempts: 8, history: retainedHistory } } } });
  await f.kv.set(KV.observations("s"), "done", observation("done", "Earlier evidence"));
  for (const row of pending) await f.kv.set(KV.observations("s"), row.id, row);
  await f.kv.set(KV.summaries, "s", { sessionId: "s", project: "fixture", createdAt: timestamp, title: "Earlier work", narrative: "Previously committed evidence.",
    processedObservationIds: ["done"], observationCount: 1, sourceOffsets: {}, sourceProjectionSnapshots: {}, segments: [originalSegment], revision: "long-session-v1" });
  return { originalSegment, retainedHistory, originalRows: await f.kv.list(KV.observations("s")) };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("registered incremental summary recovery", () => {
  it("keeps observations arriving during inference pending for the next checkpoint", async () => {
    let entered!: () => void, release!: (value: string) => void, calls = 0;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<string>(resolve => { release = resolve; });
    const f = fixture(async () => {
      if (++calls === 1) { entered(); return gate; }
      return summaryResponse;
    });
    await seed(f, [observation("new", "first evidence")]);
    const worker = f.start();
    try {
      const first = f.run();
      await started;
      await f.kv.set(KV.observations("s"), "late", observation("late", "arrived during inference"));
      await f.kv.update(KV.sessions, "s", [{ path: "observationCount", value: 3 }]);
      release(summaryResponse);
      expect(await first).toMatchObject({ success: true, pendingCount: 1, processedCount: 2 });
      expect((await f.kv.get(KV.summaries, "s")).processedObservationIds).toEqual(["done", "new"]);
      expect((await f.kv.get(KV.sessions, "s")).observationCount).toBe(3);
      expect(await f.run()).toMatchObject({ success: true, pendingCount: 0, processedCount: 3 });
      expect(JSON.parse(f.provider.summarize.mock.calls[1][1]).observations.map((row: any) => row.id)).toEqual(["late"]);
      expect((await f.kv.get(KV.summaries, "s")).processedObservationIds).toEqual(["done", "new", "late"]);
      expect(await f.run()).toMatchObject({ skipped: true, reason: "no_new_observations" });
      expect(f.provider.summarize).toHaveBeenCalledTimes(2);
    } finally { release(summaryResponse); await worker.stop(); }
  });

  it("stops new admission and timers while draining an in-flight checkpoint", async () => {
    vi.useFakeTimers();
    let entered!: () => void, release!: (value: string) => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<string>(resolve => { release = resolve; });
    const f = fixture(async () => { entered(); return gate; });
    await seed(f, [observation("new", "new evidence")]);
    const worker = f.start({ schedule: true });
    try {
      const work = f.run();
      await started;
      let stopped = false;
      const stopping = worker.stop().then(() => { stopped = true; });
      await Promise.resolve();
      expect(stopped).toBe(false);
      expect(await f.run()).toMatchObject({ deferred: true, retained: true, reason: "shutting_down" });
      release(summaryResponse);
      await Promise.all([work, stopping]);
      expect((await f.kv.get(KV.summaries, "s")).processedObservationIds).toEqual(["done", "new"]);
      await vi.advanceTimersByTimeAsync(60000);
      expect(f.provider.summarize).toHaveBeenCalledOnce();
      expect(worker.snapshot()).toEqual({ stopped: true, running: 0 });
    } finally { release(summaryResponse); await worker.stop(); }
  });

  it("does not call the provider again after all observation IDs are committed", async () => {
    const f = fixture(async () => summaryResponse);
    await seed(f, [observation("new", "new evidence")]);
    const worker = f.start();
    try {
      expect(await f.run()).toMatchObject({ success: true, pendingCount: 0 });
      const checkpoint = await f.kv.get(KV.summaries, "s");
      expect(await f.run()).toMatchObject({ success: true, skipped: true, reason: "no_new_observations" });
      expect(f.provider.summarize).toHaveBeenCalledOnce();
      expect(await f.kv.get(KV.summaries, "s")).toEqual(checkpoint);
    } finally { await worker.stop(); }
  });

  it("coalesces concurrent requests for the same session into one inference", async () => {
    let release!: (value: string) => void;
    const gate = new Promise<string>(resolve => { release = resolve; });
    const f = fixture(async () => gate);
    await seed(f, [observation("new", "new evidence")]);
    const worker = f.start();
    try {
      const first = f.run();
      expect(await f.run()).toMatchObject({ queued: true, reason: "already_running" });
      release(summaryResponse);
      expect(await first).toMatchObject({ success: true, pendingCount: 0 });
      expect(f.provider.summarize).toHaveBeenCalledOnce();
    } finally { release(summaryResponse); await worker.stop(); }
  });

  it.each(["output", "metadata"])("preserves an existing record's quarantine history and metadata when a forced retry blocks it again (%s)", async (failure) => {
    vi.stubEnv("SUMMARIZE_INPUT_CHARS", "800");
    const f = fixture(async () => "invalid-json");
    const row = observation("poison", "poison evidence");
    if (failure === "metadata") row.title = "oversized metadata ".repeat(100);
    await seed(f, [row]);
    const history = [{ at: timestamp, lastError: "earlier failure" }];
    await f.kv.update(KV.sessions, "s", [{ path: "summaryProgress", value: {
      status: "blocked", attempts: 7, inputChars: 800,
      blockedObservations: { poison: { status: "blocked", attempts: 7, history, firstDetectedAt: timestamp } },
    } }]);
    const worker = f.start();
    try {
      expect(await f.run({ force: true })).toMatchObject({ success: false, retained: true });
      const blocked = (await f.kv.get(KV.sessions, "s")).summaryProgress.blockedObservations.poison;
      expect(blocked).toMatchObject({ status: "blocked", attempts: 8, history, firstDetectedAt: timestamp });
    } finally { await worker.stop(); }
  });

  it("keeps the last committed checkpoint when a summary write fails", async () => {
    const f = fixture(async () => summaryResponse);
    const kept = await seed(f, [observation("new", "new evidence")]);
    const checkpoint = await f.kv.get(KV.summaries, "s");
    const set = f.kv.set;
    f.kv.set = async (scope, id, value) => {
      if (scope === KV.summaries) throw Error("synthetic write failure");
      return set(scope, id, value);
    };
    const worker = f.start();
    try {
      expect(await f.run()).toMatchObject({ success: false, retained: true });
      expect(await f.kv.get(KV.summaries, "s")).toEqual(checkpoint);
      expect(await f.kv.list(KV.observations("s"))).toEqual(kept.originalRows);
      f.kv.set = set;
      expect(await f.run({ force: true })).toMatchObject({ success: true, pendingCount: 0 });
      expect(JSON.parse(f.provider.summarize.mock.calls.at(-1)![1]).observations[0].sourceRange.start).toBe(0);
    } finally { f.kv.set = set; await worker.stop(); }
  });

  it("waits for an unavailable provider without consuming source or calling inference", async () => {
    const f = fixture(async () => summaryResponse);
    const kept = await seed(f, [observation("new", "new evidence")]);
    Object.assign(f.provider, { readiness: { ensureReady: async () => false, snapshot: () => ({ status: "waiting" }) } });
    const worker = f.start();
    try {
      expect(await f.run()).toMatchObject({ deferred: true, retained: true, reason: "provider_unavailable" });
      expect(f.provider.summarize).not.toHaveBeenCalled();
      expect((await f.kv.get(KV.summaries, "s")).processedObservationIds).toEqual(["done"]);
      expect(await f.kv.list(KV.observations("s"))).toEqual(kept.originalRows);
      expect((await f.kv.get(KV.sessions, "s")).summaryProgress.status).toBe("waiting_provider");
    } finally { await worker.stop(); }
  });

  it("covers escaped Unicode source without gaps or lone surrogate endings", async () => {
    vi.stubEnv("SUMMARIZE_INPUT_CHARS", "800");
    const f = fixture(async () => summaryResponse);
    const output = '한글😀"\\\n'.repeat(120);
    await seed(f, [observation("unicode", output)]);
    const worker = f.start();
    const parts: string[] = [];
    try {
      for (let i = 0; i < 40; i++) {
        const result = await f.run();
        const wire = f.provider.summarize.mock.calls.at(-1)![1];
        expect(wire.length).toBeLessThanOrEqual(800);
        const part = JSON.parse(wire).observations[0].content;
        expect(part).not.toMatch(/[\uD800-\uDBFF]$/u);
        parts.push(part);
        if (result.pendingCount === 0) break;
      }
      expect(parts.join("")).toBe(JSON.stringify({ hookType: "post_tool_use", output }));
      expect((await f.kv.get(KV.summaries, "s")).processedObservationIds).toEqual(["done", "unicode"]);
    } finally { await worker.stop(); }
  });

  it("pins a legacy projection across restart even if its summary fields change", async () => {
    vi.stubEnv("SUMMARIZE_INPUT_CHARS", "800");
    const f = fixture(async () => summaryResponse);
    const legacy = { ...observation("legacy", "unused"), sourceRaw: undefined, narrative: "original legacy evidence ".repeat(120), facts: [], files: [] };
    await seed(f, [legacy as never]);
    let worker = f.start();
    try {
      expect(await f.run()).toMatchObject({ success: true, pendingCount: 1 });
      const checkpoint = await f.kv.get(KV.summaries, "s");
      await worker.stop();
      await f.kv.set(KV.observations("s"), "legacy", { ...legacy, narrative: "changed projection" });
      worker = f.start();
      expect(await f.run()).toMatchObject({ success: true });
      const range = JSON.parse(f.provider.summarize.mock.calls.at(-1)![1]).observations[0];
      expect(range.sourceRange.start).toBe(checkpoint.sourceOffsets.legacy);
      expect(range.content).not.toContain("changed projection");
      expect((await f.kv.get(KV.summaries, "s")).sourceProjectionSnapshots.legacy).toEqual(checkpoint.sourceProjectionSnapshots.legacy);
    } finally { await worker.stop(); }
  });

  it("restarts from the committed raw offset, backs off a failed attempt, then completes without gaps", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(timestamp));
    vi.stubEnv("SUMMARIZE_INPUT_CHARS", "800"); vi.stubEnv("SUMMARIZE_BATCH_OBS", "1");
    let invalid = false;
    const f = fixture(async () => invalid ? "invalid-json" : summaryResponse);
    const kept = await seed(f, [observation("large", "source evidence ".repeat(200))]);
    let worker = f.start();
    try {
      expect(await f.run()).toMatchObject({ success: true, progressed: true, pendingCount: 1 });
      const checkpoint = await f.kv.get(KV.summaries, "s");
      expect(checkpoint.sourceOffsets.large).toBeGreaterThan(0);
      expect(checkpoint.processedObservationIds).toEqual(["done"]);
      await worker?.stop?.(); worker = f.start();
      invalid = true;
      expect(await f.run()).toMatchObject({ success: false, retained: true });
      expect(await f.kv.get(KV.summaries, "s")).toEqual(checkpoint);
      const request = JSON.parse(f.provider.summarize.mock.calls.at(-1)![1]);
      expect(request.observations[0].sourceRange.start).toBe(checkpoint.sourceOffsets.large);
      const failed = (await f.kv.get(KV.sessions, "s")).summaryProgress;
      expect(failed).toMatchObject({ status: "retrying", attempts: 1 });
      const calls = f.provider.summarize.mock.calls.length;
      expect(await f.run()).toMatchObject({ skipped: true, reason: "retry_backoff" });
      expect(f.provider.summarize).toHaveBeenCalledTimes(calls);
      await worker?.stop?.(); worker = f.start();
      vi.setSystemTime(failed.retryAt + 1); invalid = false;
      for (let i = 0; i < 30; i++) {
        const result = await f.run();
        expect(result.success).toBe(true);
        if (result.pendingCount === 0) break;
      }
      const complete = await f.kv.get(KV.summaries, "s");
      expect(complete.processedObservationIds).toEqual(["done", "large"]);
      expect(complete.sourceOffsets).toEqual({});
      expect(complete.segments[0]).toEqual(kept.originalSegment);
      const ranges = complete.segments.slice(1).flatMap((segment: any) => segment.sourceRanges);
      expect(ranges[0].start).toBe(0);
      for (let i = 1; i < ranges.length; i++) expect(ranges[i].start).toBe(ranges[i - 1].end);
      expect(ranges.at(-1).end).toBe(ranges.at(-1).total);
      expect((await f.kv.get(KV.sessions, "s")).summaryProgress).toMatchObject({ status: "current", pendingCount: 0, attempts: 0 });
      expect((await f.kv.get(KV.sessions, "s")).summaryProgress.blockedObservations.done.history).toEqual(kept.retainedHistory);
      expect(await f.kv.list(KV.observations("s"))).toEqual(kept.originalRows);
    } finally { await worker?.stop?.(); }
  });

  it("quarantines one record after eight bad attempts and resumes other evidence after restart", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(timestamp));
    vi.stubEnv("SUMMARIZE_INPUT_CHARS", "800"); vi.stubEnv("SUMMARIZE_BATCH_OBS", "1");
    const f = fixture(async (_system, user) => JSON.parse(user).observations.some((row: any) => row.id === "a-poison") ? "invalid-json" : summaryResponse);
    const kept = await seed(f, [observation("a-poison", "bad model response fixture"), observation("b-good", "healthy evidence fixture")]);
    const checkpoint = await f.kv.get(KV.summaries, "s");
    let worker = f.start();
    try {
      for (let attempt = 1; attempt <= 8; attempt++) {
        const result = await f.run();
        expect(result).toMatchObject({ success: false, retained: true });
        expect(await f.kv.get(KV.summaries, "s")).toEqual(checkpoint);
        vi.setSystemTime(Date.now() + 2_000_000);
      }
      const blocked = (await f.kv.get(KV.sessions, "s")).summaryProgress;
      expect(blocked.blockedObservations["a-poison"]).toMatchObject({ status: "blocked", attempts: 8, diagnostics: { category: "output_invalid" } });
      expect(blocked).toMatchObject({ status: "queued", pendingCount: 2, retryAt: 0 });
      expect(blocked.blockedObservations.done.history).toEqual(kept.retainedHistory);
      await worker?.stop?.(); worker = f.start();
      expect(await worker.pump()).toMatchObject({ progressed: true });
      const committed = await f.kv.get(KV.summaries, "s");
      expect(committed.processedObservationIds).toEqual(["done", "b-good"]);
      expect(committed.segments[0]).toEqual(kept.originalSegment);
      expect(committed.segments[1].sourceObservationIds).toEqual(["b-good"]);
      const calls = f.provider.summarize.mock.calls.length;
      expect(await f.run()).toMatchObject({ success: false, skipped: true, reason: "content_requires_attention" });
      expect(f.provider.summarize).toHaveBeenCalledTimes(calls);
      expect(await f.kv.list(KV.observations("s"))).toEqual(kept.originalRows);
      expect((await f.kv.get(KV.sessions, "s")).summaryProgress.blockedObservations.done.history).toEqual(kept.retainedHistory);
    } finally { await worker?.stop?.(); }
  });
});
