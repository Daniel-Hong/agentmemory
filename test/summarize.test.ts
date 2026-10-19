import { afterEach, describe, expect, it, vi } from "vitest";
import { produceSummaryXml, registerSummarizeFunction } from "../src/functions/summarize.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation, MemoryProvider } from "../src/types.js";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../src/functions/audit.js", () => ({ safeAudit: vi.fn(async () => {}) }));
const xml = (title = "summary") => `<summary><title>${title}</title><narrative>Observed coding work.</narrative><decisions></decisions><files></files><concepts></concepts></summary>`;
const rows = (count: number): CompressedObservation[] => Array.from({ length: count }, (_, i) => ({
  id: `o${i}`, sessionId: "s", timestamp: "2026-10-14T00:00:00Z", type: "file_edit", title: `edit ${i}`,
  narrative: `Edited source file ${i}.`, facts: [], concepts: [], files: [`src/file${i}.ts`], importance: 5,
}));
const provider = (summarize = vi.fn(async () => xml())): MemoryProvider => ({ name: "fixture", compress: vi.fn(), summarize });
afterEach(() => vi.unstubAllEnvs());

describe("official XML summary helper compatibility", () => {
  it.each(["0", "-1", "not-a-number"])("uses the default chunk size when the override is invalid (%s)", async (value) => {
    vi.stubEnv("SUMMARIZE_CHUNK_SIZE", value);
    const p = provider();
    const result = await produceSummaryXml(p, rows(401), "s", "fixture");
    expect(result).toMatchObject({ mode: "chunked", chunks: 2, skipped: 0 });
    expect(p.summarize).toHaveBeenCalledTimes(3);
  });

  it("rejects a legacy session when every chunk throws after retry", async () => {
    vi.stubEnv("SUMMARIZE_CHUNK_SIZE", "2");
    const p = provider(vi.fn(async () => { throw Error("fixture unavailable"); }));
    await expect(produceSummaryXml(p, rows(6), "s", "fixture")).rejects.toThrow("too_many_chunks_skipped: 3/3");
    expect(p.summarize).toHaveBeenCalledTimes(6);
  });

  it("keeps original observation ranges when a middle XML chunk is unusable", async () => {
    vi.stubEnv("SUMMARIZE_CHUNK_SIZE", "2");
    vi.stubEnv("SUMMARIZE_CHUNK_CONCURRENCY", "1");
    const summarize = vi.fn(async () => xml()).mockResolvedValueOnce(xml("first"))
      .mockResolvedValueOnce("invalid").mockResolvedValueOnce("invalid");
    const result = await produceSummaryXml(provider(summarize), rows(6), "s", "fixture");
    expect(result).toMatchObject({ mode: "chunked", skipped: 1 });
    const reduce = summarize.mock.calls.at(-1)![1];
    expect(reduce).toContain("obs 1-2");
    expect(reduce).toContain("obs 5-6");
    expect(reduce).not.toContain("obs 3-4");
  });

  it("uses one call for a small legacy session", async () => {
    const p = provider();
    const result = await produceSummaryXml(p, rows(4), "s", "fixture");
    expect(result).toMatchObject({ mode: "single", chunks: 1, response: xml() });
    expect(p.summarize).toHaveBeenCalledOnce();
  });

  it("map-reduces a legacy session with configurable chunk size", async () => {
    vi.stubEnv("SUMMARIZE_CHUNK_SIZE", "2");
    const p = provider();
    const result = await produceSummaryXml(p, rows(7), "s", "fixture");
    expect(result).toMatchObject({ mode: "chunked", chunks: 4, skipped: 0 });
    expect(p.summarize).toHaveBeenCalledTimes(5);
  });

  it("retries an invalid XML chunk without skipping valid evidence", async () => {
    vi.stubEnv("SUMMARIZE_CHUNK_SIZE", "2");
    vi.stubEnv("SUMMARIZE_CHUNK_CONCURRENCY", "1");
    const summarize = vi.fn(async () => xml()).mockResolvedValueOnce("invalid");
    const result = await produceSummaryXml(provider(summarize), rows(6), "s", "fixture");
    expect(result).toMatchObject({ mode: "chunked", skipped: 0 });
    expect(summarize).toHaveBeenCalledTimes(5);
  });

  it("keeps a successful majority when one chunk fails twice", async () => {
    vi.stubEnv("SUMMARIZE_CHUNK_SIZE", "2");
    vi.stubEnv("SUMMARIZE_CHUNK_CONCURRENCY", "1");
    const summarize = vi.fn(async () => xml()).mockRejectedValueOnce(Error("fixture-failure")).mockRejectedValueOnce(Error("fixture-failure"));
    const result = await produceSummaryXml(provider(summarize), rows(8), "s", "fixture");
    expect(result).toMatchObject({ mode: "chunked", chunks: 4, skipped: 1 });
    expect(summarize).toHaveBeenCalledTimes(6);
  });

  it("rejects a legacy summary with too many skipped chunks", async () => {
    vi.stubEnv("SUMMARIZE_CHUNK_SIZE", "2");
    await expect(produceSummaryXml(provider(vi.fn(async () => "invalid")), rows(8), "s", "fixture")).rejects.toThrow("too_many_chunks_skipped");
  });

  it("bounds the number of concurrent chunk calls", async () => {
    vi.stubEnv("SUMMARIZE_CHUNK_SIZE", "2");
    vi.stubEnv("SUMMARIZE_CHUNK_CONCURRENCY", "2");
    let active = 0, peak = 0;
    const summarize = vi.fn(async () => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--;
      return xml();
    });
    await produceSummaryXml(provider(summarize), rows(12), "s", "fixture");
    expect(peak).toBe(2);
  });
});

describe("incremental summary registration", () => {
  it("rejects invalid session IDs before reading or calling a provider", async () => {
    const handlers = new Map<string, (data: unknown) => Promise<any>>();
    const kv = { get: vi.fn() };
    const p = provider();
    const worker = registerSummarizeFunction({ registerFunction: (id: string, fn: any) => handlers.set(id, fn) } as never, kv as never, p, undefined, { schedule: false });
    try {
      expect(await handlers.get("mem::summarize")!(undefined)).toMatchObject({ success: false, error: "sessionId is required" });
      expect(kv.get).not.toHaveBeenCalled();
      expect(p.summarize).not.toHaveBeenCalled();
    } finally { await worker.stop(); }
  });

  it("skips a wrapped noop provider without recording a failed inference", async () => {
    const handlers = new Map<string, (data: unknown) => Promise<any>>();
    const kv = {
      get: vi.fn(async (scope: string) => scope === KV.sessions ? { id: "s", status: "completed", project: "fixture" } : null),
      list: vi.fn(async () => rows(1)), update: vi.fn(),
    };
    const p = { ...provider(), name: "resilient(noop)" };
    const metrics = { record: vi.fn() };
    const worker = registerSummarizeFunction({ registerFunction: (id: string, fn: any) => handlers.set(id, fn) } as never, kv as never, p, metrics as never, { schedule: false });
    try {
      expect(await handlers.get("mem::summarize")!({ sessionId: "s", force: true })).toMatchObject({ success: false, error: "no_provider", retained: true });
      expect(p.summarize).not.toHaveBeenCalled();
      expect(metrics.record).not.toHaveBeenCalled();
    } finally { await worker.stop(); }
  });
});
