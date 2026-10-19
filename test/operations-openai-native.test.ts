import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIProvider } from "../src/providers/openai.js";
import { INCREMENTAL_SUMMARY_SYSTEM, INCREMENTAL_SUMMARY_FORMAT } from "../src/ops/long-session.mjs";
import { STRUCTURED_COMPRESSION_SYSTEM, STRUCTURED_COMPRESSION_FORMAT } from "../src/ops/structured-compression.mjs";
import { STRUCTURED_GRAPH_EXTRACTION_SYSTEM } from "../src/ops/background-enrichment.mjs";
import { SEMANTIC_MERGE_SYSTEM } from "../src/prompts/consolidation.js";
import { GRAPH_EXTRACTION_SYSTEM } from "../src/prompts/graph-extraction.js";
import { CONSERVATIVE_REFLECTION_SYSTEM } from "../src/ops/feature-lifecycle.mjs";
import { operationalState } from "../src/ops/context.js";

const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); operationalState.providerReadiness = null; });

describe("native Ollama compatibility", () => {
  it.each([
    [INCREMENTAL_SUMMARY_SYSTEM, INCREMENTAL_SUMMARY_FORMAT],
    [STRUCTURED_COMPRESSION_SYSTEM, STRUCTURED_COMPRESSION_FORMAT],
    [GRAPH_EXTRACTION_SYSTEM, undefined],
    [STRUCTURED_GRAPH_EXTRACTION_SYSTEM + "\nJSON schema:\n{}", undefined],
    [CONSERVATIVE_REFLECTION_SYSTEM, undefined],
    [SEMANTIC_MERGE_SYSTEM, undefined],
  ])("uses native chat and a grammar for %s", async (system, expectedFormat) => {
    vi.stubEnv("AGENTMEMORY_OLLAMA_NATIVE_CHAT", "true");
    const fetch = vi.fn(async () => response({ message: { content: "{}" }, done: true, done_reason: "stop" }));
    vi.stubGlobal("fetch", fetch);
    const provider = new OpenAIProvider("fake-key", "fixture-model", 1200, "http://fixture.invalid:11434/v1");
    expect(await provider.compress(system as string, '{"sources":[{"id":"s1","text":"src/a.ts"}]}')).toBe("{}");
    const [url, init] = fetch.mock.calls[0] as any[];
    expect(url).toBe("http://fixture.invalid:11434/api/chat");
    const body = JSON.parse(init.body);
    expect(body.format?.type).toBe("object");
    if (expectedFormat) expect(body.format).toEqual(expectedFormat);
    expect(body.options.num_predict).toBe(system === INCREMENTAL_SUMMARY_SYSTEM || system.startsWith("You are a memory consolidation engine.") ? 768 : 1200);
    expect(init.headers).not.toHaveProperty("Authorization");
  });

  it("defers unavailable providers without fetching, and preserves truncation diagnostics", async () => {
    vi.stubEnv("AGENTMEMORY_OLLAMA_NATIVE_CHAT", "true");
    const fetch = vi.fn(async () => response({ message: { content: "unfinished" }, done: true, done_reason: "length", eval_count: 768 }));
    vi.stubGlobal("fetch", fetch);
    const readiness = { ensureReady: vi.fn(async () => false), snapshot: () => ({ status: "unavailable" }), noteResponse: vi.fn() };
    operationalState.providerReadiness = readiness;
    const provider = new OpenAIProvider("fake-key", "fixture-model", 1200, "http://fixture.invalid:11434");
    await expect(provider.summarize(INCREMENTAL_SUMMARY_SYSTEM, "fixture")).rejects.toMatchObject({ providerUnavailable: true });
    expect(fetch).not.toHaveBeenCalled();
    readiness.ensureReady.mockResolvedValue(true);
    await expect(provider.summarize(INCREMENTAL_SUMMARY_SYSTEM, "fixture")).rejects.toMatchObject({ diagnostics: { category: "output_truncated", evalCount: 768 } });
    expect(readiness.noteResponse).toHaveBeenCalled();
  });

  it("keeps standalone memory consolidation XML without a facts grammar", async () => {
    vi.stubEnv("AGENTMEMORY_OLLAMA_NATIVE_CHAT", "true");
    const fetch = vi.fn(async () => response({ message: { content: "<memory><title>memory</title></memory>" }, done: true, done_reason: "stop" }));
    vi.stubGlobal("fetch", fetch);
    const provider = new OpenAIProvider("fake-key", "fixture-model", 1200, "http://fixture.invalid:11434");
    const system = "You are a memory consolidation engine. Consolidate observations. Output XML: <memory>...</memory>";
    expect(await provider.compress(system, "fixture")).toContain("<memory>");
    const body = JSON.parse((fetch.mock.calls[0] as any[])[1].body);
    expect(body).not.toHaveProperty("format");
    expect(body.options.num_predict).toBe(1200);
    expect(body.messages[0].content).toBe(system);
  });

  it("keeps the official OpenAI body when native mode is disabled", async () => {
    vi.stubEnv("AGENTMEMORY_OLLAMA_NATIVE_CHAT", "false");
    const fetch = vi.fn(async () => response({ choices: [{ message: { content: "done" } }] }));
    vi.stubGlobal("fetch", fetch);
    const provider = new OpenAIProvider("fake-key", "fixture-model", 1200, "https://fixture.invalid/v1");
    expect(await provider.compress("system", "user")).toBe("done");
    const [url, init] = fetch.mock.calls[0] as any[];
    expect(url).toBe("https://fixture.invalid/v1/chat/completions");
    expect(JSON.parse(init.body)).toMatchObject({ max_tokens: 1200, stream: false });
    expect(JSON.parse(init.body)).not.toHaveProperty("format");
    expect(init.headers.Authorization).toBe("Bearer fake-key");
  });
});
