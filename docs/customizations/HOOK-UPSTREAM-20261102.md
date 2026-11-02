# Hook preparation, 2026-11-02

The personal native capture source and generated shared helper already support
`captureCompletion: sdk-v1`, source retention before sending, and completion
identity validation (introduced in `4fd556696ad7d6d62575946ffa232450a24e54ad`).
The installed marketplace 0.9.31 helper differs. The installed global compat
directory has an older version label, but its 13 files match the personal .51
artifact. A directory name alone does not establish stale code.

`connect codex` now compares recognizable AgentMemory global registrations with
the bundled native manifest before its existing already-wired return. It reports
only overlapping event names. This is a static comparison: it does not establish
that plugin hooks are enabled, trusted, supported by the current host, or actually
dispatched. Unknown/custom command layouts can remain undetected; inspect the
host's `/hooks` view before activation. No command arguments, credentials,
payloads, or source bodies are printed by the diagnostic.

The global installer remains explicit through `--with-hooks`; it warns about
possible plugin overlap instead of recommending global hooks on every Desktop
installation. Its existing MCP early return and installation behavior remain.
It does not disable a plugin, approve trust, change event IDs, or merge queues.
Existing pending, held and accepted originals retain their identities. Native
and compat payload shapes differ, so this change does not impose common event
IDs or claim that independent sources deduplicate each other.

Build native and compat artifacts from the same reviewed source. Actual Ubuntu
or Windows installation, exact command selection, trust review, and natural
dispatch verification remain separate activation work. Cloud orchestration's
unsupported local command hooks are not repaired by rebuilding local files.

Focused verification uses temporary homes and synthetic fixtures. Operating
settings, plugin caches, credentials, services and capture data are untouched.

The post-merge documentation review found four new upstream MCP count contexts
that survived the earlier number synchronization after the state had already
advanced to 55. `scripts/docs-sync-mcp.ts` now updates only the AgentMemory tools
badge, the explicit all-tools default sentence, the extended-tools summary and
the essential-tools comment, and only in README/translations. Other project
counts, base tools and fallback tools remain unchanged. The generator updated
the README and twelve translations; no generated count was changed by hand.

Website metadata now uses the same source-derived REST count as docs-sync's
complete trigger-directory AST collector, rather than counting just three
upstream trigger files and omitting personal endpoints. `npm run gen-meta`
regenerated metadata as 0.9.31-daniel.51, 55 tools, 159 REST endpoints, 12 hooks
and 5800+ test cases. Unavailable live popularity requests retained their prior
values. No website dependencies were installed and no website build was run.

Verification: five stale MCP fixture cases failed before the helper fix, then
all seven helper cases passed, including unrelated counts and CRLF/idempotence.
The extra trigger fixture first failed 6 versus 7, then metadata and helper
fixtures passed together (9/9); missing/invalid REST facts are rejected.
`npm run docs:check` passed after regeneration. Runtime source and operating
hooks/settings/services were unchanged by this documentation follow-up.

The separate `global-companion` package flavor retains MCP/skills and only the
unchanged PreToolUse entry. It excludes the five overlapping native events,
without changing the normal local/review/skills packages or default marketplace
selection. Global compatibility has nine event registrations but thirteen files
including helpers/metadata; the counts measure different things. Packaging does
not install/trust/enable this flavor. Exact host activation remains separate.
