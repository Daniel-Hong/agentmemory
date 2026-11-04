import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as prompts from "@clack/prompts";
import { inspectCodexHookOverlap, type HookManifest } from "../src/cli/connect/codex-hooks.js";

const pluginRoot = resolve(__dirname, "../plugin");
const native = JSON.parse(readFileSync(join(pluginRoot, "hooks/hooks.codex.json"), "utf8")) as HookManifest;
const compatEvents = {
  SessionStart: "session-start", UserPromptSubmit: "prompt-submit", PostToolUse: "post-tool-use",
  PostToolUseFailure: "post-tool-failure", PreCompact: "pre-compact", Stop: "stop",
  SessionEnd: "session-end", SubagentStart: "subagent-start", SubagentStop: "subagent-stop",
};
function compatHooks(root = "/home/example/.local/share/agentmemory-personal/releases/old/plugin"): HookManifest {
  return { hooks: Object.fromEntries(Object.entries(compatEvents).map(([event, script]) => [event, [{
    hooks: [{ type: "command", command: `node "${root}/scripts/codex-compat/${script}.mjs" --private-example` }],
  }]])) };
}

describe("Codex static hook overlap", () => {
  it("reports the five configured compat/native overlaps without changing either source", () => {
    const global = compatHooks();
    const before = JSON.stringify({ global, native });
    expect(inspectCodexHookOverlap(global, native, pluginRoot)).toEqual([
      "PostToolUse", "PreCompact", "SessionStart", "Stop", "UserPromptSubmit",
    ]);
    expect(JSON.stringify({ global, native })).toBe(before);
  });

  it("recognizes Windows AgentMemory paths and bundled paths without exposing command arguments", () => {
    const windows = compatHooks("C:\\Users\\example\\agentmemory-personal\\release\\plugin");
    expect(inspectCodexHookOverlap(windows, native, pluginRoot)).toContain("Stop");
    const bundled = compatHooks(pluginRoot);
    expect(inspectCodexHookOverlap(bundled, native, pluginRoot)).toContain("Stop");
    expect(JSON.stringify(inspectCodexHookOverlap(windows, native, pluginRoot))).not.toContain("private-example");
  });

  it("ignores unrelated hooks, non-command handlers and malformed global entries", () => {
    const global = { hooks: {
      Stop: [{ hooks: [{ type: "command", command: "node /other/scripts/stop.mjs" }, { type: "prompt", command: `${pluginRoot}/scripts/stop.mjs` }] }],
      SessionStart: [null, { hooks: null }, { hooks: [null] }],
      PostToolUse: "invalid",
    } };
    expect(inspectCodexHookOverlap(global, native, pluginRoot)).toEqual([]);
    expect(inspectCodexHookOverlap(null, native, pluginRoot)).toEqual([]);
  });
});

describe("Codex connect overlap guidance", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "am-codex-overlap-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.resetModules();
    mkdirSync(join(home, ".codex"));
    vi.spyOn(prompts.log, "info").mockImplementation(() => {});
    vi.spyOn(prompts.log, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
    rmSync(home, { recursive: true, force: true });
  });

  it.each([false, true])("reports overlap before the already-wired return (dryRun=%s), leaving files unchanged", async (dryRun) => {
    const config = '[mcp_servers.agentmemory]\ncommand = "example"\n';
    const hooks = JSON.stringify(compatHooks());
    writeFileSync(join(home, ".codex/config.toml"), config);
    writeFileSync(join(home, ".codex/hooks.json"), hooks);
    const { adapter } = await import("../src/cli/connect/codex.js");
    expect(await adapter.install({ dryRun, force: false, withHooks: true })).toMatchObject({ kind: "already-wired" });
    const output = vi.mocked(prompts.log.warn).mock.calls.flat().join("\n");
    expect(output).toContain("PostToolUse, PreCompact, SessionStart, Stop, UserPromptSubmit");
    expect(output).toContain("enabled and trusted");
    expect(output).toContain("/hooks");
    expect(output).not.toContain("private-example");
    expect(output).not.toContain("example/.local");
    expect(readFileSync(join(home, ".codex/config.toml"), "utf8")).toBe(config);
    expect(readFileSync(join(home, ".codex/hooks.json"), "utf8")).toBe(hooks);
  });

  it("warns before a dry-run global install that plugin hooks may also run", async () => {
    const { adapter } = await import("../src/cli/connect/codex.js");
    await adapter.install({ dryRun: true, force: false, withHooks: true });
    expect(vi.mocked(prompts.log.warn).mock.calls.flat().join("\n")).toContain("choose one AgentMemory hook source");
    expect(adapter.protocolNote).not.toContain("also pass --with-hooks");
  });
});
