import { beforeEach, expect, it, vi } from "vitest";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import { KV } from "../src/state/schema.js";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
beforeEach(() => vi.resetModules());

async function fixture() {
  const { registerObserveFunction } = await import("../src/functions/observe.js");
  const sdk = mockSdk({ looseTrigger: true });
  const kv = mockKV();
  const payload = {
    sessionId: "synthetic-replay", project: "synthetic", cwd: "/tmp/synthetic",
    hookType: "post_tool_use", timestamp: "2026-10-19T00:00:00.000Z",
    observationId: "obs_replay_durable", eventId: "synthetic-event",
    data: { tool_name: "Bash", tool_output: "synthetic-original" },
  };
  registerObserveFunction(sdk as never, kv as never, undefined, 1);
  const send = () => sdk.trigger("mem::observe", payload);
  return { kv, payload, send };
}

it.each(["post_tool_use", "prompt_submit"])("acknowledges stored %s at the session limit without loading the namespace", async hook => {
  const { kv, payload, send } = await fixture();
  const stored = { id: payload.observationId, sessionId: payload.sessionId, title: "synthetic original", narrative: "synthetic", facts: [], concepts: [], files: [], sourceRaw: { raw: "preserved" } };
  await kv.set(KV.observations(payload.sessionId), stored.id, stored);
  payload.hookType = hook;
  if (hook === "prompt_submit") Object.assign(payload.data, { prompt: "synthetic prompt" });
  const list = vi.spyOn(kv, "list").mockRejectedValue(new Error("full namespace unavailable"));
  const writes = vi.spyOn(kv, "set");
  expect(await send()).toEqual({ observationId: stored.id, deduplicated: true, existing: true });
  expect(list).not.toHaveBeenCalled();
  expect(writes.mock.calls.filter(([scope]) => scope === KV.observations(payload.sessionId))).toHaveLength(0);
  expect(await kv.get(KV.observations(payload.sessionId), stored.id)).toEqual(stored);
  const { getSearchIndex } = await import("../src/functions/search.js");
  expect(getSearchIndex().has(stored.id)).toBe(true);
  if (hook === "prompt_submit") expect(kv.store.get(KV.capturePrompts)?.size).toBe(1);
});

it("retains the full session-limit check for an absent durable observation", async () => {
  const { kv, payload, send } = await fixture();
  await kv.set(KV.observations(payload.sessionId), "obs_existing_other", { id: "obs_existing_other" });
  expect(await send()).toMatchObject({ success: false, error: "Session observation limit reached (1)" });
  expect(await kv.get(KV.observations(payload.sessionId), payload.observationId)).toBeNull();
});

it("does not treat a failed point lookup as absence or overwrite anything", async () => {
  const { kv, send } = await fixture();
  vi.spyOn(kv, "get").mockRejectedValue(new Error("point lookup unavailable"));
  const list = vi.spyOn(kv, "list");
  const writes = vi.spyOn(kv, "set");
  await expect(send()).rejects.toThrow("point lookup unavailable");
  expect(list).not.toHaveBeenCalled();
  expect(writes).not.toHaveBeenCalled();
});
