import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/functions/search.js", () => ({
  getSearchIndex: () => ({ add: vi.fn(), has: () => false }),
  getVectorIndex: () => null,
  scheduleIndexSave: vi.fn(),
  prepareObservationEmbedding: async () => async () => {},
}));

import { registerObserveFunction } from "../src/functions/observe.js";
import { KV } from "../src/state/schema.js";
import { onLiveEvent, type LiveEvent } from "../src/viewer/live-events.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    update: async (
      scope: string,
      key: string,
      updates: Array<{ path: string; value: unknown }>,
    ) => {
      const m = store.get(scope);
      if (!m) return;
      const v = (m.get(key) as Record<string, unknown>) ?? {};
      for (const u of updates) v[u.path] = u.value;
      m.set(key, v);
    },
    delete: async (scope: string, key: string) => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const m = store.get(scope);
      return m ? (Array.from(m.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const fns = new Map<string, (payload: unknown) => Promise<unknown>>();
  const trigger = vi.fn(
    async (input: { function_id: string; payload: unknown }) => {
      const fn = fns.get(input.function_id);
      return fn ? fn(input.payload) : null;
    },
  );
  return {
    registerFunction: (
      idOrOpts: string | { id: string },
      fn: (payload: unknown) => Promise<unknown>,
    ) => {
      fns.set(typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id, fn);
    },
    registerTrigger: () => {},
    trigger,
  };
}

function observePayload(sessionId: string, i: number) {
  return {
    sessionId,
    project: "agentmemory",
    cwd: "/tmp/agentmemory",
    hookType: "post_tool_use",
    timestamp: new Date().toISOString(),
    data: {
      tool_name: "Bash",
      tool_input: { command: `echo probe-${i}` },
      tool_output: `probe-${i} output`,
    },
  };
}

describe("observe publishes SSE without engine stream history", () => {
  it("delivers metadata only for raw captures and strips retained sources from summaries", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);
    const events: LiveEvent[] = [];
    const unsubscribe = onLiveEvent(event => events.push(event));
    const sessionId = "ses_sse_privacy";
    try {
      const payload = observePayload(sessionId, 0);
      payload.data.tool_output = "private raw fixture output";
      const result = await sdk.trigger({ function_id: "mem::observe", payload }) as { observationId: string };
      expect(result.observationId).toBeTruthy();
      const raw = events.find(event => event.type === "raw_observation")!;
      expect(raw.data.observation).toEqual({ id: result.observationId, sessionId,
        timestamp: payload.timestamp, hookType: payload.hookType });
      const compressed = events.find(event => event.type === "compressed_observation")!;
      expect(compressed.data.observation).not.toHaveProperty("source");
      expect(compressed.data.observation).not.toHaveProperty("sourceRaw");
      expect(compressed.data.observation).not.toHaveProperty("syntheticCompression");
      const retained = await kv.get<Record<string, unknown>>(KV.observations(sessionId), result.observationId);
      expect(retained).not.toBeNull();
      expect(retained!.source || retained!.sourceRaw).toBeTruthy();
      expect(sdk.trigger.mock.calls.some(([call]) => call.function_id.startsWith("stream::"))).toBe(false);
    } finally { unsubscribe(); }
  });

  it("retains an accepted observation when a display observer throws", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);
    const unsubscribe = onLiveEvent(() => { throw new Error("fixture subscriber failed"); });
    try {
      const sessionId = "ses_sse_nonfatal";
      const result = await sdk.trigger({ function_id: "mem::observe", payload: observePayload(sessionId, 1) }) as { observationId: string };
      expect(result.observationId).toBeTruthy();
      expect(await kv.get(KV.observations(sessionId), result.observationId)).not.toBeNull();
    } finally { unsubscribe(); }
  });
});
