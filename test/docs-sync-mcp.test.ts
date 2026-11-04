import { describe, expect, it } from "vitest";
import { syncMcpToolSurfaces } from "../scripts/docs-sync-mcp.js";

const surfaces = [
  '<picture><img src="assets/tags/stat-tools.svg" alt="54 MCP tools" height="38" /></picture>',
  '<picture><img src="../assets/tags/stat-tools.svg" alt="54 MCP tools" height="38" /></picture>',
  'The default (`AGENTMEMORY_TOOLS=all`) exposes all 54.',
  '<summary>Extended tools (54 total, the default surface)</summary>',
  '# Show 8 essential MCP tools instead of the default 54',
];

describe("docs sync for current MCP surfaces", () => {
  it.each(surfaces)("updates the explicit AgentMemory surface even after the prior count was forgotten: %s", (input) => {
    expect(syncMcpToolSurfaces(input, "55")).toBe(input.replace("54", "55"));
    expect(syncMcpToolSurfaces(input, "61")).toBe(input.replace("54", "61"));
  });

  it("preserves unrelated project counts, foundational tools and local fallback counts", () => {
    const unrelated = [
      'Another project exposes 54 MCP tools.',
      '<img src="competitor/stat-tools.svg" alt="54 MCP tools" />',
      'The other project exposes all 54.',
      '<summary>Extended tools (54 total)</summary>',
      '<summary>Base tools (14)</summary>',
      'The shim falls back to a 7-tool local set.',
      '# Show 54 examples instead of the default 54',
    ].join("\n");
    expect(syncMcpToolSurfaces(unrelated, "55")).toBe(unrelated);
  });

  it("is stable after synchronization and preserves CRLF", () => {
    const input = surfaces.join("\r\n");
    const synced = syncMcpToolSurfaces(input, "55");
    expect(syncMcpToolSurfaces(synced, "55")).toBe(synced);
    expect(synced.split("\r\n")).toHaveLength(surfaces.length);
  });
});
