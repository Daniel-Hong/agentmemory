import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("iii-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("iii-sdk")>();
  return {
    ...actual,
    TriggerAction: {
      ...actual.TriggerAction,
      Void: vi.fn(() => ({ type: "void" })),
    },
  };
});

import { operationalState } from "../src/ops/context.js";
import { logger } from "../src/logger.js";
import { createFeatureLifecycle } from "../src/ops/feature-lifecycle.mjs";
import { registerApiTriggers } from "../src/triggers/api.js";
import { registerEventTriggers } from "../src/triggers/events.js";
import { KV } from "../src/state/schema.js";
import type { Session } from "../src/types.js";

type ApiResponse = {
  status_code: number;
  body: Record<string, unknown>;
};

function makeHarness(sessionRows: Array<[string, unknown]> = []) {
  const store = new Map<string, Map<string, unknown>>([
    [KV.sessions, new Map(sessionRows)],
    [KV.summaries, new Map()],
  ]);
  const functions = new Map<string, Function>();
  const trigger = vi.fn(async () => undefined);
  const update = vi.fn(
    async (
      scope: string,
      key: string,
      ops: Array<{ type: "set" | "remove"; path: string; value?: unknown }>,
    ) => {
      const values = store.get(scope) ?? new Map<string, unknown>();
      store.set(scope, values);
      const existing = values.get(key);
      const next =
        existing && typeof existing === "object"
          ? { ...(existing as Record<string, unknown>) }
          : {};
      for (const op of ops) {
        if (op.type === "remove") delete next[op.path];
        else next[op.path] = op.value;
      }
      values.set(key, next);
      return next;
    },
  );
  const kv = {
    get: vi.fn(async (scope: string, key: string) => {
      if (typeof key !== "string" || key.length === 0) {
        throw new Error("state::get requires a non-empty key");
      }
      return store.get(scope)?.get(key) ?? null;
    }),
    set: vi.fn(),
    update,
    delete: vi.fn(),
    list: vi.fn(async (scope: string) =>
      Array.from(store.get(scope)?.values() ?? []),
    ),
  };
  const sdk = {
    registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    registerTrigger: vi.fn(),
    trigger,
  };

  registerApiTriggers(sdk as never, kv as never);
  registerEventTriggers(sdk as never, kv as never);

  return { functions, kv, store, trigger, update };
}

function session(id: string, status: Session["status"] = "active"): Session {
  return {
    id,
    project: "test-project",
    cwd: "/tmp/test-project",
    startedAt: "2026-08-26T00:00:00.000Z",
    status,
    observationCount: 1,
  };
}

describe("session lifecycle API", () => {
  it("treats ending an unknown session as a no-op without creating a partial row", async () => {
    const harness = makeHarness();
    const handler = harness.functions.get("api::session::end")!;

    const response = (await handler({
      body: { sessionId: "agent:dmp-pm:direct:test" },
    })) as ApiResponse;

    expect(response).toEqual({
      status_code: 200,
      body: { success: true, ended: false, reason: "not_found" },
    });
    expect(harness.update).not.toHaveBeenCalled();
    expect(harness.store.get(KV.sessions)).toEqual(new Map());
    expect(harness.trigger).not.toHaveBeenCalledWith(
      expect.objectContaining({ function_id: "event::session::stopped" }),
    );
  });

  it("does not treat an existing partial row as a valid session", async () => {
    const sessionId = "agent:dmp-pm:direct:partial";
    const harness = makeHarness([
      [sessionId, { status: "completed", endedAt: "2026-08-26T00:00:00.000Z" }],
    ]);
    const handler = harness.functions.get("api::session::end")!;

    const response = (await handler({ body: { sessionId } })) as ApiResponse;

    expect(response.body).toEqual({
      success: true,
      ended: false,
      reason: "not_found",
    });
    expect(harness.update).not.toHaveBeenCalled();
  });

  it("treats ending an already-completed session as a no-op", async () => {
    const sessionId = "agent:dmp-pm:direct:completed";
    const harness = makeHarness([[sessionId, session(sessionId, "completed")]]);
    const handler = harness.functions.get("api::session::end")!;

    const response = (await handler({ body: { sessionId } })) as ApiResponse;

    expect(response).toEqual({
      status_code: 200,
      body: { success: true, ended: false, reason: "already_completed" },
    });
    expect(harness.update).not.toHaveBeenCalled();
    expect(harness.trigger).not.toHaveBeenCalled();
  });

  it("ends an existing session and publishes the stopped lifecycle once", async () => {
    const sessionId = "agent:dmp-pm:direct:existing";
    const harness = makeHarness([[sessionId, session(sessionId)]]);
    const handler = harness.functions.get("api::session::end")!;

    const response = (await handler({ body: { sessionId } })) as ApiResponse;

    expect(response.body).toEqual({ success: true, ended: true });
    expect(harness.store.get(KV.sessions)?.get(sessionId)).toMatchObject({
      id: sessionId,
      status: "completed",
      endedAt: expect.any(String),
    });
    expect(harness.trigger).toHaveBeenCalledTimes(1);
    expect(harness.trigger).toHaveBeenCalledWith(
      expect.objectContaining({
        function_id: "event::session::stopped",
        payload: { sessionId },
      }),
    );
  });

  it("skips malformed rows when listing sessions and never reads an undefined summary key", async () => {
    const valid = session("ses_valid", "completed");
    const harness = makeHarness([
      [valid.id, valid],
      ["agent:dmp-pm:direct:partial", { status: "completed", endedAt: "2026-08-26T00:00:00.000Z" }],
    ]);
    const handler = harness.functions.get("api::sessions")!;

    const response = (await handler({
      headers: {},
      query_params: { agentId: "*" },
    })) as ApiResponse;

    expect(response.status_code).toBe(200);
    expect(response.body.sessions).toEqual([valid]);
    expect(harness.kv.get).toHaveBeenCalledWith(KV.summaries, valid.id);
    expect(harness.kv.get).not.toHaveBeenCalledWith(KV.summaries, undefined);
  });
});

describe("api::session::end with final", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps the session open on a per-turn end and schedules the idle finalizer", async () => {
    const sessionId = "agent:dmp-pm:direct:turn";
    const harness = makeHarness([[sessionId, session(sessionId)]]);
    const handler = harness.functions.get("api::session::end")!;

    const response = (await handler({ body: { sessionId, final: false } })) as ApiResponse;

    expect(response.status_code).toBe(200);
    expect(response.body).toEqual({
      success: true,
      ended: false,
      reason: "deferred",
      finalizeAt: expect.any(String),
    });
    expect(harness.store.get(KV.sessions)?.get(sessionId)).toMatchObject({
      status: "active",
      updatedAt: expect.any(String),
    });
    expect(harness.kv.set).toHaveBeenCalledWith(KV.config, "finalize:due", {
      [sessionId]: expect.any(Number),
    });
    expect(harness.trigger).not.toHaveBeenCalled();
  });

  it("reopens an abandoned session on a per-turn end", async () => {
    const sessionId = "agent:dmp-pm:direct:abandoned";
    const row = { ...session(sessionId, "abandoned"), endedAt: "2026-08-26T01:00:00.000Z" };
    const harness = makeHarness([[sessionId, row]]);
    const handler = harness.functions.get("api::session::end")!;

    const response = (await handler({ body: { sessionId, final: false } })) as ApiResponse;

    expect(response.body).toMatchObject({ ended: false, reason: "deferred" });
    const stored = harness.store.get(KV.sessions)?.get(sessionId) as Record<string, unknown>;
    expect(stored.status).toBe("active");
    expect("endedAt" in stored).toBe(false);
  });

  it("reports an already completed session on a per-turn end without touching it", async () => {
    const sessionId = "agent:dmp-pm:direct:completed";
    const harness = makeHarness([[sessionId, session(sessionId, "completed")]]);
    const handler = harness.functions.get("api::session::end")!;

    const response = (await handler({ body: { sessionId, final: false } })) as ApiResponse;

    expect(response.body).toEqual({ success: true, ended: false, reason: "already_completed" });
    expect(harness.update).not.toHaveBeenCalled();
    expect(harness.kv.set).not.toHaveBeenCalled();
  });

  it("completes on every end when the idle window is zero", async () => {
    vi.stubEnv("AGENTMEMORY_FINALIZE_IDLE_MS", "0");
    const sessionId = "agent:dmp-pm:direct:immediate";
    const harness = makeHarness([[sessionId, session(sessionId)]]);
    const handler = harness.functions.get("api::session::end")!;

    const response = (await handler({ body: { sessionId, final: false } })) as ApiResponse;

    expect(response.body).toEqual({ success: true, ended: true });
    expect(harness.store.get(KV.sessions)?.get(sessionId)).toMatchObject({ status: "completed" });
    expect(harness.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ function_id: "event::session::stopped" }),
    );
  });

  it("completes at once on a final end", async () => {
    const sessionId = "agent:dmp-pm:direct:final";
    const harness = makeHarness([[sessionId, session(sessionId)]]);
    const handler = harness.functions.get("api::session::end")!;

    const response = (await handler({ body: { sessionId, final: true } })) as ApiResponse;

    expect(response.body).toEqual({ success: true, ended: true });
    expect(harness.store.get(KV.sessions)?.get(sessionId)).toMatchObject({ status: "completed" });
    expect(harness.trigger).toHaveBeenCalledTimes(1);
  });
});


it("reports the actual blocked feature observation read without changing the session-end response", async () => {
  vi.useFakeTimers();
  const previous = operationalState.featureLifecycle;
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  const id = "synthetic-private-session";
  const harness = makeHarness([[id, session(id)]]);
  let release!: (rows: unknown[]) => void;
  const delayed = new Promise<unknown[]>(resolve => { release = resolve; });
  harness.kv.list.mockImplementation(async scope => scope === KV.observations(id) ? delayed : []);
  const lifecycle = createFeatureLifecycle({
    kv: harness.kv, KV, withKeyedLock: async (_key: string, fn: () => unknown) => fn(),
    provider: {}, schedule: false, isSlotsEnabled: () => true,
  } as never);
  operationalState.featureLifecycle = lifecycle;
  try {
    const pending = harness.functions.get("api::session::end")!({ body: { sessionId: id, hookEventName: "SessionEnd" } });
    await vi.advanceTimersByTimeAsync(4000);
    expect(warn).toHaveBeenCalledWith("Session end request diagnostic", expect.objectContaining({
      stage: "feature_observations_read", outcome: "pending",
    }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain(id);
    release([]);
    expect(await pending).toEqual({ status_code: 200, body: { success: true, ended: true, queued: true } });
    expect(harness.update).toHaveBeenCalledTimes(1);
  } finally {
    release([]);
    operationalState.featureLifecycle = previous;
    warn.mockRestore();
    vi.useRealTimers();
  }
});

it.each([
  [{final:true},true],
  [{final:false},false],
  [{hookEventName:'SessionEnd'},true],
  [{final:false,hookEventName:'SessionEnd'},false],
  [{},false],
])('honors explicit final flags and legacy names with feature lifecycle (%j)',async(fields,ended)=>{
  const previous=operationalState.featureLifecycle;const id='synthetic-final-contract';const harness=makeHarness([[id,session(id)]]);const enqueue=vi.fn(async()=>{});operationalState.featureLifecycle={enqueue} as never;
  try{const result=await harness.functions.get('api::session::end')!({body:{sessionId:id,...fields}});expect(result).toEqual({status_code:200,body:{success:true,ended,queued:true}});expect(harness.store.get(KV.sessions)?.get(id)).toMatchObject({status:ended?'completed':'active'});expect(enqueue).toHaveBeenCalledOnce();}finally{operationalState.featureLifecycle=previous;}
});
