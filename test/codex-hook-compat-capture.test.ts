import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;
const url = "http://127.0.0.1:45679";
const payload = { hookType: "post_tool_use", sessionId: "synthetic", project: "compat", cwd: "/tmp/compat", timestamp: "2026-10-15T00:00:00Z", eventId: "compat-event-0001", data: { tool_output: "x".repeat(4501) } };
const mark = { bootId: "compatboot000001", durableAfterMs: 60_000 };
const receipt = { status: "accepted", state: "completed", observationId: "synthetic-observation", ...mark };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "am-compat-capture-"));
  vi.resetModules();
  vi.stubEnv("AGENTMEMORY_URL", url);
  vi.stubEnv("AGENTMEMORY_SECRET", "synthetic-secret");
  vi.stubEnv("AGENTMEMORY_CAPTURE_SPOOL_DIR", dir);
  vi.stubEnv("AGENTMEMORY_CAPTURE_DRAIN_CHILD", "1");
  vi.stubEnv("AGENTMEMORY_CAPTURE_SPOOL", "true");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(receipt), { status: 201 })));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); });

describe("custom legacy outbox handoff to official capture", () => {
  it("confirms handoff only after a valid receipt has been retained", async () => {
    const { handoffObservation } = await import("../src/hooks/_capture.js");
    expect(await handoffObservation(payload, 100, { url, headers: { authorization: "Bearer synthetic-secret" }, dir })).toBe("delivered");
    const sent = readdirSync(dir).find(name => name.includes(".sent-"))!;
    expect(JSON.parse(readFileSync(join(dir, sent), "utf8"))).toMatchObject({ eventId: payload.eventId, body: payload, bootId: mark.bootId });
  });
  it.each([{}, { ...receipt, bootId: "../invalid" }, { ...receipt, durableAfterMs: -1 }, { ...receipt, observationId: undefined }, { ...receipt, error: "pending" }])("keeps legacy ownership for a missing/malformed/unacknowledged receipt %j", async (body) => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(body), { status: 201 }));
    const { handoffObservation } = await import("../src/hooks/_capture.js");
    expect(await handoffObservation(payload, 100, { url, headers: {}, dir })).toBe("pending");
    expect(readdirSync(dir)).toEqual([]);
  });
  it("keeps ownership when the successful server receipt cannot be retained", async () => {
    vi.stubEnv("AGENTMEMORY_CAPTURE_SPOOL", "false");
    const { handoffObservation } = await import("../src/hooks/_capture.js");
    expect(await handoffObservation(payload, 100, { url, headers: {}, dir })).toBe("pending");
  });
  it("keeps ownership for invalid JSON in a successful HTTP response", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("not-json", { status: 201 }));
    const { handoffObservation } = await import("../src/hooks/_capture.js");
    expect(await handoffObservation(payload, 100, { url, headers: {}, dir })).toBe("pending");
  });
  it.each([201, 503])("does not remove oversized legacy images during handoff at HTTP %i", async (status) => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(receipt), { status }));
    const { handoffObservation } = await import("../src/hooks/_capture.js");
    const large = { ...payload, data: { image: "A".repeat(300_000) } };
    expect(await handoffObservation(large, 100, { url, headers: {}, dir })).toBe(status === 201 ? "pending" : "dropped");
    expect(readdirSync(dir).some(name => name.endsWith(".jsonl"))).toBe(false);
  });
  it("hands off an unreachable event to the fsynced managed spool", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("synthetic-offline"));
    const { handoffObservation } = await import("../src/hooks/_capture.js");
    expect(await handoffObservation(payload, 100, { url, headers: {}, dir })).toBe("spooled");
    const line = readFileSync(join(dir, "local-45679.jsonl"), "utf8");
    expect(JSON.parse(line)).toMatchObject({ eventId: payload.eventId, body: payload });
  });
  it("keeps ownership if the managed spool is disabled during an outage", async () => {
    vi.stubEnv("AGENTMEMORY_CAPTURE_SPOOL", "false");
    vi.mocked(fetch).mockRejectedValue(new Error("synthetic-offline"));
    const { handoffObservation } = await import("../src/hooks/_capture.js");
    expect(await handoffObservation(payload, 100, { url, headers: {}, dir })).toBe("dropped");
  });
  it("keeps a drain record pending when sent retention is full", async () => {
    vi.stubEnv("AGENTMEMORY_CAPTURE_SPOOL_MAX_BYTES", "65536");
    const { appendSpool } = await import("../src/capture/spool.js");
    expect(appendSpool(url, payload.eventId, payload, "synthetic", { dir }).spooled).toBe(true);
    writeFileSync(join(dir, "local-45679.sent-compatboot000001-9999999999999.jsonl"), "x".repeat(65536));
    const { runDrainChild } = await import("../src/hooks/_capture.js");
    await runDrainChild();
    expect(JSON.parse(readFileSync(join(dir, "local-45679.jsonl"), "utf8"))).toMatchObject({ eventId: payload.eventId, attempts: 1 });
  });
  it("keeps a managed compatibility record pending when its later HTTP acknowledgement has no receipt", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("synthetic-offline"));
    const { handoffObservation, runDrainChild } = await import("../src/hooks/_capture.js");
    expect(await handoffObservation(payload, 100, { url, headers: {}, dir })).toBe("spooled");
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ observationId: "synthetic-observation" }), { status: 201 }));
    await runDrainChild();
    expect(JSON.parse(readFileSync(join(dir, "local-45679.jsonl"), "utf8"))).toMatchObject({ eventId: payload.eventId, attempts: 1 });
  });
  it("official direct capture does not falsely claim delivery when both retained and pending spool are unavailable", async () => {
    vi.stubEnv("AGENTMEMORY_CAPTURE_SPOOL", "false");
    const { captureObservation } = await import("../src/hooks/_capture.js");
    expect(await captureObservation(payload, 100)).toBe("dropped");
  });
  it("does not evict compatibility sent ownership merely to make room for another pending event", async () => {
    vi.stubEnv("AGENTMEMORY_CAPTURE_SPOOL_MAX_BYTES", "65536");
    const { appendSpool, retainSent, spoolSummary } = await import("../src/capture/spool.js");
    const large = { ...payload, data: { tool_output: "x".repeat(12_000) } };
    for (let i = 0; i < 5; i++) expect(retainSent(url, `compat-retain-${i}`, large, mark, { dir, requireReceipt: true })).toBe(true);
    expect(appendSpool(url, "compat-new-event", large, "synthetic", { dir, requireReceipt: true }).spooled).toBe(false);
    expect(spoolSummary(url, { dir }).retained).toBe(5);
  });
  it("does not expire compatibility pending ownership while its original event awaits a durable receipt", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("synthetic-offline"));
    const { handoffObservation, runDrainChild } = await import("../src/hooks/_capture.js");
    expect(await handoffObservation(payload, 100, { url, headers: {}, dir })).toBe("spooled");
    const path = join(dir, "local-45679.jsonl"); const record = JSON.parse(readFileSync(path, "utf8"));
    record.spooledAt = new Date(Date.now() - 8 * 24 * 3600_000).toISOString(); writeFileSync(path, JSON.stringify(record) + "\n");
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(receipt), { status: 201 }));
    await runDrainChild();
    const sent = readdirSync(dir).find(name => name.includes(".sent-"))!;
    expect(JSON.parse(readFileSync(join(dir, sent), "utf8"))).toMatchObject({ eventId: payload.eventId, requireReceipt: true });
  });
});
