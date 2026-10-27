# agentmemory — Agent Instructions

## Personal fork maintenance

- Work on `personal`; keep `main` as upstream tracking history. Follow the approved customization port order in `docs/customizations/PORT-01.md`; do not redesign it without documenting the conflict and minimum alternative.
- Do not deploy, restart services, resume paused background work, or use production data/configuration for development tests. Source data, summary cursors, retry/history, lessons and metrics must survive changes. Never roll back current data to an old backup to undo code.
- Record each custom change, reason, actual validation, deployment state and upstream replacement criteria in CHANGELOG.md and the customization notes. Long-term memory requires separate manual review; do not overwrite, auto-merge or silently supersede existing memories. Pending memory recording is not saved memory.
- Keep dependencies and upstream behavior where possible. Replace custom code with upstream only after the same acceptance tests prove equivalent behavior and data compatibility. Do not commit secrets, operational content, backups or generated caches.

## Architecture

agentmemory is a persistent memory system for AI coding agents, built on iii-engine's three primitives (Worker/Function/Trigger). Everything goes through `registerFunction`/`registerTrigger`/`sdk.trigger()` — never bypass iii-engine with standalone SQLite or in-process alternatives.

- **Engine**: iii-sdk 0.22.1 with @iii-dev/helpers 0.22.1 (WebSocket to iii-engine 0.22.1 on port 49134; the client type is `IIIClient`, HTTP requests are `HttpRequest` from `@iii-dev/helpers/http`)
- **State**: File-based SQLite via iii-engine's StateModule (`./data/state_store.db`)
- **Build**: TypeScript → ESM via tsdown, output to `dist/`
- **Test**: vitest (`npm test` excludes integration tests)

## Consistency Rules

**Before every commit, run `npm run docs:sync` and commit what it changes.** It computes MCP tool counts (all, core, local fallback), REST endpoints, skills, hooks, tests, iii functions, source files, lines of code and KV scopes from the source, and rewrites them in README.md, the translated READMEs, AGENTS.md, INSTALL_FOR_AGENTS.md, plugin manifests, integration READMEs, the stat badges and the `src/index.ts` banner. The last synced values live in `scripts/docs-sync.state.json`; commit that file with the rest. `npm run docs:check` exits non-zero when anything is out of date. When the sync prints `check <fact> <old> left in <file>`, open that line: either fix it by hand or add its noun to the fact in `scripts/docs-sync.ts` so the next sync catches it. Never hand-edit these numbers or versions in the docs; change the source and sync.

**When adding or removing MCP tools, update:**
1. `src/mcp/tools-registry.ts` — tool definition + `getAllTools()` array
2. `src/mcp/server.ts` — handler case in the `mcp::tools::call` switch
3. `src/triggers/api.ts` — REST endpoint registration
4. `src/index.ts` — function registration
5. `test/mcp-standalone.test.ts` — tool count assertion

**When adding REST endpoints, update:**
1. `src/triggers/api.ts` — endpoint registration

**When bumping version, change only `package.json`.** `npm run docs:sync` carries the new version into `src/version.ts`, the `src/types.ts` ExportData union, the `supportedVersions` set in `src/functions/export-import.ts`, every plugin and package manifest that shared the old version, the deploy templates, the AGENTS.md stats heading, and CHANGELOG.md (the Unreleased section becomes the new version with today's date, plus its compare link).

**When adding new KV scopes:**
1. `src/state/schema.ts` — add to the KV object
2. `src/types.ts` — add the corresponding interface

**When adding new audit operations:**
1. `src/types.ts` — add to AuditEntry.operation union type

## Code Patterns

### Function Registration
```typescript
sdk.registerFunction(
  "mem::your-function",
  async (data: { ... }) => {
    // validate inputs
    // do work via kv.get/kv.set/kv.list
    // record audit via recordAudit()
    return { success: true, ... };
  },
);
```

### REST Endpoint Registration
```typescript
import type { HttpRequest } from "@iii-dev/helpers/http";

sdk.registerFunction("api::your-endpoint", async (req: HttpRequest) => {
  const denied = checkAuth(req, secret);
  if (denied) return denied;
  const body = req.body as Record<string, unknown>;
  // validate + whitelist fields (never pass raw body to sdk.trigger)
  const result = await sdk.trigger({
    function_id: "mem::your-function",
    payload: { ... },
  });
  return { status_code: 200, body: result };
});
sdk.registerTrigger({
  type: "http",
  function_id: "api::your-endpoint",
  config: { api_path: "/agentmemory/your-path", http_method: "POST" },
});
```

### MCP Tool Handler
```typescript
case "memory_your_tool": {
  // validate args with typeof checks
  // parse CSV args: args.field.split(",").map(t => t.trim()).filter(Boolean)
  const result = await sdk.trigger({
    function_id: "mem::your-function",
    payload: { ... },
  });
  return { status_code: 200, body: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } };
}
```

### Hook Scripts
Hook scripts in `src/hooks/` are standalone Node.js scripts (no iii-sdk import). They read JSON from stdin, make HTTP calls to the REST API, and exit. There are two patterns depending on whether Claude Code consumes the script's stdout:

- **Context-injecting hooks** (`pre-tool-use`, `pre-compact`, `session-start`) write recalled context to stdout for Claude Code to inject. These MUST use `try/catch` with `await fetch(..., { signal: AbortSignal.timeout(N) })` — the script has to wait for the response before exiting, and the timeout is the only bound on hang time.
- **Telemetry-only hooks** (`notification`, `post-tool-failure`, `post-tool-use`, `prompt-submit`, `stop`, `session-end`, `subagent-start`, `subagent-stop`, `task-completed`) write nothing to stdout. These MUST use fire-and-forget `fetch(..., { signal: AbortSignal.timeout(N) }).catch(() => {})` paired with `setTimeout(() => process.exit(0), 500).unref()`. The unawaited fetch dispatches the request; the unref'd `setTimeout` force-exits the process after the request has been flushed to the local daemon's socket buffer (~500ms is enough for single-request hooks; use 1500ms for multi-request hooks like `stop` and `session-end` so all fetches have time to start, especially when `AGENTMEMORY_URL` points to a remote daemon). Without the `setTimeout` Node keeps the event loop alive waiting for any in-flight fetch to settle, which means the hook still blocks Claude Code's next-prompt boundary for up to the AbortSignal duration — exactly the bug fire-and-forget is meant to fix.

## Coding Standards

- TypeScript, ESM only (`"type": "module"`)
- No code comments explaining WHAT — use clear naming instead
- Use `fingerprintId()` for content-addressable dedup, `generateId()` for unique IDs
- Parallel operations where possible (`Promise.all` for independent kv writes/reads)
- Input validation at system boundaries (MCP handlers, REST endpoints)
- REST endpoints must whitelist fields — never pass raw request body to `sdk.trigger()`
- Use `recordAudit()` for state-changing operations
- Timestamps: capture once with `new Date().toISOString()` and reuse

## Testing

- Before every commit run, in order: `npm run build`, `npm run skills:gen`, `npm run docs:sync`, `npm run skills:check`, `npm test` (3,700+ tests). Commit anything the generators changed. CI runs the same build, skills check and tests.
- Before any npm publish: `npm run release:gate` must pass. It installs the packed tarballs into a clean home and runs capture, recovery, restart, export/import, MCP and status checks against the installed CLI (see CONTRIBUTING.md, Release process)
- Mock pattern: `vi.mock("iii-sdk")` with mock `sdk.trigger`, `kv.get/set/list`
- Test files go in `test/` with `.test.ts` extension
- Follow existing patterns in `test/crystallize.test.ts` for function tests

## Current Stats (v0.9.30-daniel.27)

- 54 MCP tools (8 visible by default, `AGENTMEMORY_TOOLS=all` for all)
- 142 REST endpoints
- 6 MCP resources, 3 MCP prompts
- 12 hooks, 17 skills
- 325+ iii functions
- 3,700+ tests

## Personal fork verification isolation

Run the test suite with its default fork pool. Do not use `--pool=threads`: on this host native `os.homedir()` does not follow Vitest's thread-local HOME stubs, allowing adapter tests to touch real home settings. Give the test launcher a real temporary HOME as a second guard; keep per-test HOME isolation. PORT-03 records the no-write reproduction and recovery.

## Personal client capture maintenance

PORT-04 implementation/limits: `docs/customizations/PORT-04.md`. Participating client README and AI update prompt: `integrations/codex-compat/README.md` and `AI-CLIENT-UPDATE.md`. `npm run build:codex-compat` follows the official build and never installs hooks. Operational server/client activation is excluded from preparation. Preserve latest legacy outbox and receipt-managed spool during code rollback. Native Ollama plus fallback is currently explicitly unsupported; do not bypass the guard or force new JSON schemas onto XML consumers. PORT-05 async embedding/publication is implemented and isolated-tested; see `docs/customizations/PORT-05.md`. PORT-06..08 add bounded operations/Viewer, file-backed pause/pressure, scoped feature recovery and opt-in feedback. See docs/customizations/DEPLOYMENT-RUNBOOK.md. Feedback requires AGENTMEMORY_FEEDBACK_DIR and never writes durable memories automatically. Latest validation and frozen candidate receipt are in the workspace deployment-preparation dossier. Operational server/client configuration has not been changed.
