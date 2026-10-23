import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import { KV } from "../src/state/schema.js";
import { captureEventScope } from "../src/capture/event-record.js";
import { captureKey, registerCaptureFunctions, type InboxRecord } from "../src/functions/capture.js";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../src/config.js", async (original) => ({
  ...await original<object>(),
  getEnvVar: (key: string) => process.env[key],
}));
vi.mock("../src/capture/outbox-metadata.js", () => ({
  createOutboxMetadata: () => async () => ({ records: 0, complete: true, available: true, inspectedAt: new Date().toISOString() }),
}));

const payload = { hookType: "post_tool_use", sessionId: "progress-session", project: "fixture", cwd: "/tmp/fixture", timestamp: "2026-10-20T00:00:00.000Z", data: { synthetic: true } };
function record(status: InboxRecord["status"], suffix = status): InboxRecord {
  const eventId = `evh_progress_${suffix}`;
  return { key: captureKey(payload.project, payload.sessionId, eventId), eventId, eventSource: "client", sessionId: payload.sessionId, project: payload.project, hookType: payload.hookType, observationId: `obs_${suffix}`, status, attempts: 1, acceptedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), payload: payload as InboxRecord["payload"], ...(status === "dead" ? { deadAt: new Date().toISOString(), lastError: "synthetic rejection" } : {}) };
}
function boot(kv = mockKV()) {
  const sdk = mockSdk();
  const controller = registerCaptureFunctions(sdk as never, kv as never, { durableAfterMs: 0 });
  return { kv, sdk, controller };
}
const age = () => vi.setSystemTime(Date.now() + 300_001);

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-10-20T00:00:00Z"), toFake: ["Date"] });
  vi.stubEnv("AGENTMEMORY_CAPTURE_MAX_ATTEMPTS", "2");
  vi.stubEnv("AGENTMEMORY_CAPTURE_RETRY_INTERVAL_MS", "1000");
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("capture active progress", () => {
  it.each(["status", "sweep"] as const)("excludes retained dead letters at startup through %s", async (initialize) => {
    const { kv, controller } = boot();
    const dead = record("dead");
    await kv.set(KV.captureInbox, dead.key, dead);
    expect(controller.progress().pending).toBeNull();
    await controller[initialize]();
    age();
    await controller.sweep();
    expect(controller.progress()).toMatchObject({ pending: 0, stalled: false, completedCount: 0 });
    expect((await controller.status()).inbox).toMatchObject({ pending: 0, retrying: 0, dead: 1, lastError: "synthetic rejection" });
    expect(await kv.get(KV.captureInbox, dead.key)).toEqual(dead);
  });

  it.each(["pending", "retrying"] as const)("detects stalled %s work initialized by a sweep", async (state) => {
    const { kv, sdk, controller } = boot();
    const rec = record(state);
    rec.attempts = 0;
    rec.nextAttemptAt = new Date(Date.now() + 900_000).toISOString();
    await kv.set(KV.captureInbox, rec.key, rec);
    sdk.fns.set("mem::observe", async () => { throw Error("synthetic timeout"); });
    await controller.sweep();
    age();
    expect(controller.progress()).toMatchObject({ pending: 1, stalled: true });
  });

  it("clears active progress as a retry dies while preserving dead records and counters", async () => {
    const { kv, sdk, controller } = boot();
    sdk.fns.set("mem::observe", async () => { throw Error("synthetic timeout"); });
    await sdk.trigger("mem::capture", { payload, eventId: "evh_progress_failure" });
    expect(controller.progress().pending).toBe(1);
    age();
    expect(controller.progress().stalled).toBe(true);
    await controller.sweep();
    expect(controller.progress()).toMatchObject({ pending: 0, stalled: false, completedCount: 0 });
    expect((await controller.status()).sinceStart).toMatchObject({ accepted: 1, retried: 1, deadLettered: 1, completed: 0 });
    expect(await kv.list(KV.captureInbox)).toHaveLength(1);
    const restarted = boot(kv).controller;
    await restarted.sweep();
    age();
    expect(restarted.progress()).toMatchObject({ pending: 0, stalled: false });
  });

  it("starts a fresh stall interval for new work beside old dead letters", async () => {
    const { kv, sdk, controller } = boot();
    const dead = record("dead");
    await kv.set(KV.captureInbox, dead.key, dead);
    await controller.status();
    age();
    sdk.fns.set("mem::observe", async () => { throw Error("synthetic timeout"); });
    await sdk.trigger("mem::capture", { payload, eventId: "evh_progress_new" });
    expect(controller.progress()).toMatchObject({ pending: 1, stalled: false });
    age();
    expect(controller.progress().stalled).toBe(true);
    expect(await kv.get(KV.captureInbox, dead.key)).toEqual(dead);
  });

  it("counts manual dead-letter retry as active before status polling and clears it on recovery", async () => {
    const { kv, sdk, controller } = boot();
    const dead = record("dead");
    await kv.set(KV.captureInbox, dead.key, dead);
    sdk.fns.set("mem::observe", async () => { throw Error("synthetic timeout"); });
    await sdk.trigger("mem::capture-retry", { eventId: dead.eventId });
    expect(controller.progress()).toMatchObject({ pending: 1, stalled: false });
    age();
    expect(controller.progress().stalled).toBe(true);
    sdk.fns.set("mem::observe", async () => {
      await kv.set(KV.observations(dead.sessionId), dead.observationId, { id: dead.observationId });
      return { observationId: dead.observationId };
    });
    await controller.sweep();
    expect(controller.progress()).toMatchObject({ pending: 0, stalled: false, completedCount: 1 });
  });

  it("removes deleted pending work without counting retained dead letters as active", async () => {
    const { kv, controller } = boot();
    const dead = record("dead"), pending = record("pending");
    await kv.set(KV.captureInbox, dead.key, dead);
    await kv.set(KV.captureInbox, pending.key, pending);
    await kv.set(captureEventScope(pending.key), pending.key, { state: "deleted" });
    await controller.status();
    age();
    await controller.sweep();
    expect(controller.progress()).toMatchObject({ pending: 0, stalled: false, completedCount: 0 });
    expect(await kv.list(KV.captureInbox)).toEqual([dead]);
  });
});

it('reports automatic recovery disabled by default without altering historical capture counts',async()=>{
 const {controller}=boot();const state=await controller.status();expect(state.automaticRecovery).toMatchObject({enabled:false,resolved:0,verifying:0,blocked:0});expect(state.sinceStart).toMatchObject({accepted:0,recovered:0,deadLettered:0});controller.stop();
});
