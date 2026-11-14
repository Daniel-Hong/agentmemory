import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { summaryFingerprint } from "../src/functions/summary-state.js";
import { createObservationReader } from "../src/ops/observation-pages.mjs";
import { createStateDurabilityFence } from "../src/ops/state-durability.mjs";
import { KV } from "../src/state/schema.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

const roots: string[] = [];
const query = { includeSummary: "false", includeSummaryCoverage: "true", agentId: "*" };
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "am-summary-coverage-"));
  roots.push(root);
  const kv = mockKV();
  const id = "covered-legacy";
  const scope = KV.observations(id);
  const session = { id, project: "synthetic", cwd: "/fixture", startedAt: "2026-01-01T00:00:00.000Z",
    status: "completed" as const, observationCount: 1 };
  const row = { id: "obs_fixture", sessionId: id, timestamp: session.startedAt,
    title: "Canonical title", narrative: "Canonical narrative", sourceRaw: { raw: "PRIVATE_FIXTURE_SOURCE" } };
  const summary = { sessionId: id, project: session.project, createdAt: session.startedAt,
    title: "PRIVATE_FIXTURE_SUMMARY", observationCount: 1, coveredFingerprint: summaryFingerprint(session, [row as never]) };
  await kv.set(KV.sessions, id, session);
  await kv.set(KV.summaries, id, summary);
  await kv.set(scope, row.id, row);
  await writeFile(join(root, encodeURIComponent(scope) + ".bin"), JSON.stringify({ [row.id]: row }));
  const durability = createStateDurabilityFence({ storePath: root, completion: "sdk" });
  const reader = createObservationReader({ storePath: root, kv: { ...kv, durability } as never });
  const work = vi.spyOn(reader, "work");
  const get = vi.spyOn(kv, "get");
  const set = vi.spyOn(kv, "set");
  const update = vi.spyOn(kv, "update");
  const del = vi.spyOn(kv, "delete");
  const sdk = mockSdk({ looseTrigger: true });
  registerApiTriggers(sdk as never, Object.assign(kv, { observationReader: reader, durability }) as never, "fixture-secret");
  const call = (query_params = query) => sdk.fns.get("api::sessions")!({ headers: { authorization: "Bearer fixture-secret" }, query_params }) as Promise<any>;
  return { call, kv, work, get, set, update, del, session, summary, row, scope, reader, durability };
}

it("returns a read-only count from full canonical rows only when metadata coverage was requested", async () => {
  const f = await fixture();
  expect((await f.call({ ...query, includeSummaryCoverage: "false" })).body.sessions).toEqual([f.session]);
  expect(f.work).not.toHaveBeenCalled();
  expect(f.get).not.toHaveBeenCalled();
  const result = await f.call();
  expect(result.body.sessions).toEqual([{ ...f.session, summaryCoveredCount: 1 }]);
  expect(f.work).toHaveBeenCalledWith(f.scope, { kind: "summary", signal: expect.any(AbortSignal) });
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_FIXTURE|summaryProgress/);
  expect(f.set).not.toHaveBeenCalled();
  expect(f.update).not.toHaveBeenCalled();
  expect(f.del).not.toHaveBeenCalled();
});

it("leaves coverage unknown when the legacy fingerprint is stale or explicit progress already exists", async () => {
  const f = await fixture();
  await f.kv.set(KV.summaries, f.session.id, { ...f.summary, coveredFingerprint: "0".repeat(64) });
  expect((await f.call()).body.sessions[0]).not.toHaveProperty("summaryCoveredCount");
  await f.kv.set(KV.summaries, f.session.id, f.summary);
  const summaryProgress = { status: "retrying", pendingCount: 1, processedCount: 0 };
  await f.kv.set(KV.sessions, f.session.id, { ...f.session, summaryProgress });
  f.work.mockClear();
  expect((await f.call()).body.sessions[0]).toEqual({ ...f.session, summaryProgress });
  expect(f.work).not.toHaveBeenCalled();
});

it("strips a persisted coverage claim and requires fresh proof for each response", async () => {
  const f = await fixture();
  await f.kv.set(KV.sessions, f.session.id, { ...f.session, summaryCoveredCount: 1 });
  await f.kv.set(KV.summaries, f.session.id, { ...f.summary, coveredFingerprint: "stale" });
  expect((await f.call()).body.sessions[0]).toEqual(f.session);
  expect((await f.call({ ...query, includeSummaryCoverage: "false" })).body.sessions[0]).toEqual(f.session);
  expect((await f.call({ ...query, includeSummary: "true" })).body.sessions[0]).not.toHaveProperty("summaryCoveredCount");
  await f.kv.set(KV.summaries, f.session.id, f.summary);
  expect((await f.call()).body.sessions[0]).toEqual({ ...f.session, summaryCoveredCount: 1 });
});

it.each(["observation", "summary"])("withholds matching coverage when a %s mutation races the proof", async (kind) => {
  const f = await fixture();
  const work = f.reader.work.bind(f.reader);
  f.work.mockImplementationOnce(async (scope, options) => {
    const view = await work(scope, options);
    const load = view.load.bind(view);
    return { ...view, load: async row => {
      const value = await load(row);
      if (kind === "observation") {
        f.reader.record(scope, "another-observation", { ...f.row, id: "another-observation" });
      } else {
        await f.durability.mutate(KV.summaries, f.session.id, async () => {});
      }
      return value;
    } };
  });
  expect((await f.call()).body.sessions[0]).not.toHaveProperty("summaryCoveredCount");
});

it("bounds observation work and returns metadata if a read stalls", async () => {
  const f = await fixture();
  await f.kv.set(KV.sessions, f.session.id, { ...f.session, observationCount: 200 });
  expect((await f.call()).body.sessions[0]).not.toHaveProperty("summaryCoveredCount");
  expect(f.work).not.toHaveBeenCalled();
  await f.kv.set(KV.sessions, f.session.id, f.session);
  vi.useFakeTimers();
  let finish!: (value: null) => void;
  f.get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const response = f.call();
  await vi.advanceTimersByTimeAsync(2000);
  expect((await response).body.sessions).toEqual([f.session]);
  const reads = f.get.mock.calls.length;
  expect((await f.call()).body.sessions).toEqual([f.session]);
  expect(f.get.mock.calls).toHaveLength(reads);
  finish(null);
});
