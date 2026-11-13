# Official v0.9.33 — selective integration review

## Reproducible source pins

- Official v0.9.32 base: `0da38f1d5067a479a6e5c4653de342ba43ca22b2`.
- Personal original head: `658f3fdc3350a64670b28b50789defca0eef462a` (`0.9.32-daniel.55`).
- Official v0.9.33 tag: `28ffc538b81b265e2f649354ed9f88b0c12ae414` (2026-11-09).
- Staged review branch: `integration/v0.9.33-review`; upstream mirror branch: `sync/upstream-v0.9.33`.

Exactly **25** upstream v0.9.33 implementation/test files are imported as upstream Git blobs, but only after verifying that each file in the current `personal` tree is byte-for-byte the same blob as the upstream v0.9.32 base. This deliberately does **not** merge the entire v0.9.33 tree or replace any personalized code. The locally changed `test/cli-doctor-fixes.test.ts` is intentionally not overwritten; any missing upstream regression from that file requires a manual minimal port.

## Staged upstream source candidates — no parity certification yet

| Change | Imported source and relevant upstream regression | Remaining check |
| --- | --- | --- |
| #1350 / #1277 | Circuit-breaker success reset and content-filter errors not counted as provider outage | Ensure real HTTP 5xx still trip breaker. |
| #1696 | Hybrid search larger fusion pool, saved-memory diversification, refill after stale hits | Personal CJK/project isolation, large-store retrieval and old-memory ordering. |
| #1250 | CLIP text tower to produce comparable image/text embeddings | Same 512-dimension projections, no automatic re-embedding. |
| #1588 | Placeholder provider keys recognized consistently by config and doctor | Preserve explicit OpenAI selection and local plain-http exception. |
| #1703 | Claude `CLAUDE_CONFIG_DIR` path selection | Actual launch environment and native hook/MCP profile equivalence. |
| #1691 | MCP long-call timeout in source REST proxy/plugin bridge | Personal generated `.mjs` and CLI shim parity, no live timeout changes. |
| #1695 / #1701 | Redact before truncation and recognize compound secret names in core filter | Native/global bundled scripts and private capture path not yet updated/verified. |
| #1692 | Give core SessionEnd hook time to finish | Generated client bundles, source-first delivery and native retained originals. |

## Deferred / non-replaceable without a separate parity gate

Official iii/SDK 0.25.1, state scope paging, 64 MiB transport changes, engine auto-install and registry worker changes are **not** incorporated. The personal modified iii 0.22.1, SDK 0.25.0, exact KV save-loop patch, SDK write/flush certification, source-generation and writer identity rules stay unchanged. Official features with overlapping names are not proof of equivalent crash durability. The engine upgrade requires isolated real-engine + existing-format migration/rollback-read tests before any change to engine pin.

Retain personal sourceRaw and incremental summary/cursor, capture inbox/original/retry/quarantine/uncertainty, native six-event hooks and private source retention, embedding publication evidence, background durable holds, health/Viewer, update trust and feedback store unchanged. Official #1698 orphan facet heal, #1601 eviction cleanup, #1687 partial-vector repair, #1545/#1544 consolidation/reflection, #1527 session filters, #1693/#1220 hook pre-tool context, remaining generated hook security and large-store fixes remain **unported or partly covered**. No custom code is retired. `docs/customizations/catalog.json` retains `unverified` decisions.

## Mandatory review before promotion to personal or a deployment candidate

1. From this exact source tree, run `npm run build`, `npm run skills:gen`, `npm run docs:sync`, `npm run skills:check`, `npm run docs:check` and a diff check. Commit all generated artifacts only after inspecting them.
2. Use isolated temporary HOME and Vitest default fork pool for `npm test`; run eval typecheck, compare known baseline diagnostics. Tests copied from upstream have **not been executed** while staging this source; passing test names do not constitute proof.
3. Verify bundled native/global Claude/Codex scripts reflect the reviewed source changes; preserve actual client hooks, original-first image/spool, project scope, strict secret redaction and 500/190-second timeout semantics where applicable. Never infer deployed behavior from an unchanged generated bundle.
4. Require release gate, isolated SDK/real-engine/storage cold-start/read-back/incomplete-write tests and existing data-format compatibility for any engine or persistence changes. No production store, settings, service, hook trust or backlog should be touched during this code review.
5. Remove a custom feature only in an independent follow-up after its complete parity and no-data-loss regression matrix passes. Preserve recorded history, old-format readers and uncertainty markers; no automatic old-memory replacement.

Status: **prepared for source review only; build, tests, docs regeneration, generated-hook parity, live operating verification and deploy are not claimed.**
