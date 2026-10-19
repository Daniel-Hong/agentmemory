import { afterEach, describe, expect, it, vi } from "vitest";
import { createOllamaReadiness } from "../src/ops/provider-readiness.mjs";
import { createBackgroundControl, installBackgroundControl } from "../src/ops/background-control.mjs";

afterEach(() => { vi.useRealTimers(); installBackgroundControl(null); });
const metadata = (url: string) => ({ ok: true, json: async () => url.endsWith("/tags") ? { models: [{ name: "fixture:latest" }] } : { version: "fixture" } });

describe("pause-independent readiness metadata", () => {
  it("refreshes after backoff while paused, caches readiness, and stops its metadata timer", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const control = createBackgroundControl();
    await control.init({ get: async () => ({ paused: true }) });
    installBackgroundControl(control);
    let unavailable = true;
    const fetchFn = vi.fn(async (url: string) => {
      if (unavailable) throw Object.assign(Error("private error"), { code: "ECONNREFUSED" });
      return metadata(url);
    });
    const readiness = createOllamaReadiness({ baseUrl: "http://fixture.invalid/v1", models: ["fixture"], fetchFn });
    readiness.start(); readiness.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(readiness.snapshot()).toMatchObject({ status: "waiting", checks: 1, errorCode: "ECONNREFUSED" });
    unavailable = false;
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetchFn).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(readiness.snapshot()).toMatchObject({ status: "ready", checks: 2, errorCode: null });
    expect(control.isPaused()).toBe(true);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(5);
    expect(fetchFn.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/api/version", "/api/version", "/api/tags", "/api/version", "/api/tags",
    ]);
    await readiness.stop(); await readiness.drain();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchFn).toHaveBeenCalledTimes(5);
  });

  it("deduplicates automatic and foreground checks and drains the admitted probe", async () => {
    let release!: (value: unknown) => void;
    const version = new Promise(resolve => { release = resolve; });
    const fetchFn = vi.fn(async (url: string) => url.endsWith("/version") ? version : metadata(url));
    const readiness = createOllamaReadiness({ baseUrl: "http://fixture.invalid", fetchFn });
    readiness.start();
    const foreground = readiness.ensureReady();
    let drained = false;
    const draining = readiness.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(drained).toBe(false);
    const stopping = readiness.stop();
    release(metadata("http://fixture.invalid/api/version"));
    await foreground; await draining; await stopping;
    expect(readiness.snapshot().status).toBe("ready");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await readiness.ensureReady();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("backs off repeated failures to the configured ceiling without exposing provider text", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const fetchFn = vi.fn(async () => { throw Object.assign(Error("PRIVATE_PROVIDER_TEXT"), { code: "ETIMEDOUT" }); });
    const readiness = createOllamaReadiness({ baseUrl: "http://fixture.invalid", fetchFn, maxDelayMs: 60_000 });
    readiness.start(); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(readiness.snapshot()).toMatchObject({ checks: 3, consecutiveFailures: 3, nextCheckAt: 151_000 });
    expect(JSON.stringify(readiness.snapshot())).not.toContain("PRIVATE_PROVIDER_TEXT");
    await readiness.stop();
  });

  it("bounds a stalled metadata request and drains without any inference request", async () => {
    const fetchFn = vi.fn(async (_url: string, options: any) => new Promise((_, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }));
    const readiness = createOllamaReadiness({ baseUrl: "http://fixture.invalid", fetchFn, probeTimeoutMs: 10 });
    readiness.start(); await readiness.drain(); await readiness.stop();
    expect(readiness.snapshot()).toMatchObject({ status: "waiting", checks: 1, errorCode: "OLLAMA_TIMEOUT" });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0][0]).toBe("http://fixture.invalid/api/version");
  });
});
