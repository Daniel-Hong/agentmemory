import { afterAll, beforeAll, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(__dirname, "..");
let output: string;
let archive: string;
function fromZip(path: string) {
  return execFileSync("unzip", ["-p", archive, path], { encoding: "utf8" });
}
beforeAll(() => {
  output = mkdtempSync(join(tmpdir(), "am-global-companion-"));
  execFileSync(process.execPath, ["scripts/plugins/package-codex.mjs"], {
    cwd: root, env: { ...process.env, AGENTMEMORY_PLUGIN_OUT_DIR: output }, stdio: "pipe",
  });
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  archive = join(output, `agentmemory-codex-global-companion-${version}.zip`);
});
afterAll(() => { if (output) rmSync(output, { recursive: true, force: true }); });

it("retains the exact pre-tool matcher and command, excluding all five duplicate events", () => {
  expect(JSON.parse(fromZip("hooks/hooks.codex.json"))).toEqual({ hooks: {
    PreToolUse: [{ matcher: "Edit|Write|Read|Glob|Grep", hooks: [{
      type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/pre-tool-use.mjs"',
    }] }],
  } });
  const original = JSON.parse(readFileSync(join(root, "plugin/hooks/hooks.codex.json"), "utf8"));
  expect(Object.keys(original.hooks).sort()).toEqual([
    "PostToolUse", "PreCompact", "PreToolUse", "SessionStart", "Stop", "UserPromptSubmit",
  ]);
});

it("keeps MCP and skills while shipping only the existing enrichment and bridge scripts", () => {
  const listing = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" }).split("\n");
  expect(listing.filter(p => /^scripts\/.+\.mjs$/.test(p)).sort()).toEqual([
    "scripts/plugin-bridge.mjs", "scripts/pre-tool-use.mjs",
  ]);
  expect(listing).toContain("skills/agentmemory-config/SKILL.md");
  expect(JSON.parse(fromZip(".codex-plugin/plugin.json"))).toMatchObject({
    mcpServers: "./.mcp.json", skills: "./skills/", hooks: "./hooks/hooks.codex.json",
  });
  expect(fromZip(".mcp.json")).toBe(readFileSync(join(root, "plugin/.mcp.codex.json"), "utf8"));
  expect(fromZip("scripts/pre-tool-use.mjs")).toBe(readFileSync(join(root, "plugin/scripts/pre-tool-use.mjs"), "utf8"));
});

it("describes separately configured global capture without claiming this package installs it", () => {
  const manifest = JSON.parse(fromZip(".codex-plugin/plugin.json"));
  expect(manifest.description).toContain("PreToolUse");
  expect(manifest.description).not.toContain("capture through 6");
  expect(manifest.interface.longDescription).toContain("separately configured global hooks");
  const readme = fromZip("README.md");
  expect(readme).toContain("9 event registrations");
  expect(readme).toContain("13 files");
  expect(readme).toContain("does not install or trust");
});
