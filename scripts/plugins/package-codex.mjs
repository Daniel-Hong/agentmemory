import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const plugin = join(root, "plugin");
// Tests package into a private directory so they never clobber dist/plugins mid-run.
const output = process.env.AGENTMEMORY_PLUGIN_OUT_DIR ? resolve(process.env.AGENTMEMORY_PLUGIN_OUT_DIR) : join(root, "dist/plugins");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const sourceManifest = JSON.parse(readFileSync(join(plugin, ".codex-plugin/plugin.json"), "utf8"));
if (sourceManifest.version !== pkg.version) throw new Error("Plugin and runtime versions must match before packaging.");
if (!existsSync(join(plugin, "scripts/plugin-bridge.mjs"))) throw new Error("Run npm run build first.");

const FLAVORS = {
  local: { mcp: true, hooks: true },
  "local-sdk-v2": { mcp: true, hooks: "sdk-v2" },
  "global-companion": { mcp: true, hooks: "pre-tool" },
  review: { mcp: true, hooks: false },
  skills: { mcp: false, hooks: false },
};

const SKILLS_README = `# Agent Memory skills for Codex

This package carries the 17 Agent Memory skills and no MCP server or lifecycle hooks, so it passes the public directory's skills-only upload path.

The skills call the \`memory_*\` tools of a running Agent Memory daemon. Install and wire it once:

\`\`\`bash
npm install -g @agentmemory/agentmemory
agentmemory
agentmemory connect codex
\`\`\`

\`connect codex\` registers the local MCP server in \`~/.codex/config.toml\`. Add \`--with-hooks\` for automatic capture (trust the hooks in Codex before expecting events). Basic keyword recall needs no model key; embeddings and model-based features are configured in \`~/.agentmemory/.env\`.

Source and documentation: https://github.com/rohitg00/agentmemory
`;

mkdirSync(output, { recursive: true });
const artifacts = [];
for (const [flavor, { mcp, hooks }] of Object.entries(FLAVORS)) {
  const name = `agentmemory-codex-${flavor}`;
  const destination = join(output, name);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(join(destination, ".codex-plugin"), { recursive: true });
  const manifest = structuredClone(sourceManifest);
  if (hooks === "pre-tool") {
    manifest.description = manifest.description.replace(/ Optional capture through .*$/, " PreToolUse context enrichment only; capture uses separately configured global hooks.");
    manifest.interface.longDescription = manifest.interface.longDescription.replace("Automatic capture requires trusted, supported hooks.", "This package retains only PreToolUse enrichment; automatic capture uses separately configured global hooks. Review exact hook definitions before trusting them.");
  }
  if (!hooks) {
    delete manifest.hooks;
    manifest.description = manifest.description.replace(/ Optional capture through .*$/, "");
  }
  if (mcp) {
    manifest.mcpServers = "./.mcp.json";
    if (!hooks) {
      manifest.interface.longDescription = manifest.interface.longDescription.replace("Automatic capture requires trusted, supported hooks.", "This review package contains no lifecycle hooks; capture must be configured separately.");
    }
    mkdirSync(join(destination, "scripts"));
    cpSync(join(plugin, ".mcp.codex.json"), join(destination, ".mcp.json"));
    cpSync(join(plugin, "scripts/plugin-bridge.mjs"), join(destination, "scripts/plugin-bridge.mjs"));
    cpSync(join(root, "docs/plugins/codex-local.md"), join(destination, "README.md"));
    if (hooks === "sdk-v2") writeFileSync(join(destination, "README.md"), `# Agent Memory native SDK capture v2 (prepared policy)\n\nThis is the full six-hook local package. Global hooks are not installed or changed. SessionStart, PreToolUse and PreCompact preserve their context/session behavior. Only UserPromptSubmit, PostToolUse and Stop receive the explicit --agentmemory-sdk-capture-v2 flag; Stop retains its nonfinal session end. The selected MCP contract is unchanged.\n\nUbuntu/Linux requires the already installed /usr/bin/flock; no fallback or new privileged helper is installed. The approved default storage is HOME/.local/share/agentmemory/capture-spool-sdk-v2. A development-only isolated-directory override is available as AGENTMEMORY_SDK_CAPTURE_V2_DIR and must be reviewed before host activation.\n\nThe privacy-scrubbed canonical envelope limit is 8 MiB, chunk limit 256 KiB, originals budget 256 MiB and reference queue budget 5 MiB. Directory/file allocation and partial/conflict data count conservatively; these are not a filesystem hard quota. There is no automatic deletion or expiry of originals. Old spools and unknown history are not read, moved, replayed or deleted. Full quota or preservation failure returns an explicit failure; this cannot promise acceptance of unlimited future input.\n\nComplete source publication and hash readback precede its reference and every POST to the same endpoint; C v2 POSTs refuse redirects. Only a matching SDK completion ACK is recorded; it is not a disk-flush receipt. Known-not-sent or explicit admission rejection may retry via the reference. Uncertain sending is held, never silently marked complete. Ordinary later prompt/tool invocations may opportunistically drain at most one eligible reference with a monotonic POST-admission/network-wait budget capped at 250ms and the remaining invocation budget. Source readback and JSON serialization consume that budget; an expired budget starts no POST and keeps a known-not-sent reference for backoff. Required synchronous state fsync and the final consistent report may finish after the deadline, so this is not a hard wall-clock guarantee for disk I/O. There is no perpetual scheduler or host retry guarantee. Stop does not perform this extra drain.\n\nLarge/image normal observe retransmission can use the verified original. The existing guarded restore API refuses images and payloads over256 KiB; this package does not bypass that restore guard. Other manual restore requires separate review.\n\nPackaging does not install, enable or trust this policy. Review exact six hook definitions, the new storage policy and the actual endpoint/environment before activation.\n`);
    if (hooks === "pre-tool") writeFileSync(join(destination, "README.md"), `# Agent Memory companion for existing global hooks\n\nThis package preserves MCP, skills and the existing PreToolUse matcher and command. It excludes SessionStart, UserPromptSubmit, PostToolUse, PreCompact and Stop to avoid a second registration alongside separately configured global hooks.\n\nThe existing personal global compatibility artifact has 9 event registrations and 13 files including shared helpers and metadata. Those are different units. This package does not install or trust global hooks, change their event IDs or retained outbox, or verify which host dispatched an event. Select this package only after reviewing the host's active hooks. Existing PreToolUse enrichment data and destination rules remain unchanged.\n`);
  } else {
    delete manifest.mcpServers;
    manifest.description = manifest.description.replace("through 55 MCP tools and 17 skills.", "through 17 skills that use the MCP tools of your own Agent Memory daemon.");
    manifest.interface.longDescription = manifest.interface.longDescription.replace("Automatic capture requires trusted, supported hooks.", "This package contains the skills only. Install the Agent Memory daemon and wire its MCP server with `agentmemory connect codex` so the skills can call the memory tools.");
    writeFileSync(join(destination, "README.md"), SKILLS_README);
  }
  writeFileSync(join(destination, ".codex-plugin/plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
  for (const directory of ["skills", "assets"]) {
    cpSync(join(plugin, directory), join(destination, directory), { recursive: true });
  }
  const agentsSkill = join(destination, "skills/agentmemory-agents/SKILL.md");
  writeFileSync(agentsSkill, readFileSync(agentsSkill, "utf8").replace("Detect the calling agent. If unknown, ask which host to configure before changing files.", "This package runs in Codex; default to `codex` unless the user explicitly requests another host."));
  cpSync(join(root, "LICENSE"), join(destination, "LICENSE"));
  if (hooks) {
    mkdirSync(join(destination, "hooks"));
    const fullHooks = JSON.parse(readFileSync(join(plugin, "hooks/hooks.codex.json"), "utf8"));
    if (!Array.isArray(fullHooks.hooks?.PreToolUse)) throw new Error("PreToolUse manifest required before packaging.");
    const selectedHooks = hooks === "pre-tool" ? { hooks: { PreToolUse: fullHooks.hooks.PreToolUse } } : structuredClone(fullHooks);
    if (hooks === "sdk-v2") {
      for (const event of ["UserPromptSubmit", "PostToolUse", "Stop"]) {
        if (!Array.isArray(selectedHooks.hooks[event])) throw new Error("SDK v2 capture hook missing");
        for (const entry of selectedHooks.hooks[event]) for (const hook of entry.hooks) {
          if (hook.type !== "command" || typeof hook.command !== "string") throw new Error("SDK v2 command hook required");
          hook.command += " --agentmemory-sdk-capture-v2";
        }
      }
    }
    const hookManifest = JSON.stringify(selectedHooks, null, 2) + "\n";
    writeFileSync(join(destination, "hooks/hooks.codex.json"), hookManifest);
    if (hooks === true || hooks === "sdk-v2") cpSync(join(plugin, "scripts/_capture.mjs"), join(destination, "scripts/_capture.mjs"));
    for (const script of new Set([...hookManifest.matchAll(/scripts\/([\w-]+\.mjs)/g)].map((m) => m[1]))) {
      cpSync(join(plugin, "scripts", script), join(destination, "scripts", script));
    }
  }
  const archive = join(output, `${name}-${pkg.version}.zip`);
  rmSync(archive, { force: true });
  // Include dotfiles at the archive root; do not include other hosts' manifests.
  execFileSync("zip", ["-q", "-r", archive, ...readdirSync(destination).sort()], { cwd: destination });
  artifacts.push({ name, archive: archive.slice(output.length + 1), sha256: createHash("sha256").update(readFileSync(archive)).digest("hex") });
}
let revision = "unknown";
try { revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); } catch {}
writeFileSync(join(output, "build-info.json"), JSON.stringify({ version: pkg.version, baseRevision: revision, artifacts }, null, 2) + "\n");
mkdirSync(join(output, ".agents/plugins"), { recursive: true });
writeFileSync(join(output, ".agents/plugins/marketplace.json"), JSON.stringify({
  name: "agentmemory-local-preview",
  interface: { displayName: "Agent Memory Local Preview" },
  plugins: [{ name: "agentmemory", source: { source: "local", path: "./agentmemory-codex-local" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Developer Tools" }],
}, null, 2) + "\n");
console.log(`Built ${artifacts.map((a) => a.archive).join(", ")} in ${output}`);
console.log("The review archive excludes hooks but still uses local stdio MCP, which the public directory accepts only with OpenAI local-MCP support. The skills archive has no MCP server or hooks and fits the skills-only upload path.");
