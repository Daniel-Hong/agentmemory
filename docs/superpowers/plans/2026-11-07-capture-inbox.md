# Capture Inbox Recovery Implementation Plan

> **For agentic workers:** Use subagent-driven development for the disjoint inbox, explicit source recovery and deployment tasks; primary agent reviews the integrated candidate.

**Goal:** Restore actual capture and indexing without oversized inbox SDK responses or loss of retained originals.

**Architecture:** Reuse the file namespace reader and acknowledged-write overlay, project metadata during streaming, and load only selected originals. Keep explicit source restore on the existing product protocol and apply .60 through certified normal shutdown.

**Tech Stack:** Existing TypeScript/Node, iii SDK/native engine, Python deployment tools, Vitest fork pool.

**Spec:** `docs/customizations/CAPTURE-INBOX-60.md`.

## Global Constraints

- No production data/config for development tests; synthetic data and private network/mount namespace only.
- No raw-source loss, false disk-completion claims, data rollback, or change to issued .59 artifacts.
- Temporary real HOME and default fork pool for tests. Preserve installed compatibility hooks in the server-only artifact.

## Review Focus

- A projected record cannot satisfy a source-digest proof without separately loading and validating that original.
- Mutating returned values must not modify acknowledged overlay state.
- Deletes, concurrent file replacement and SDK write uncertainty cannot yield stale success.
- Thousands of already acknowledged originals must not require an oversized response or prevent health/capture progress.
- A lost restore response and delayed competing response must not acknowledge another attempt or trigger blind resends.

## Task 1 — Inbox reads

- [x] Reproduce original native .59 overflow and write failing capture entry regression.
- [ ] Add exact inbox scope to existing local reader; support projected reads through StateKV with unchanged full-list and backend fallback behavior.
- [ ] Use a shared metadata/preview projection in capture admission, sweep, status, retry, list, review and retry jobs.
- [ ] Reuse original completion verifier only after selected source and metadata agree; test invalid proof and changing source.
- [ ] Run focused regressions, then integrated tests/build and packaged native scale acceptance.

Files: `src/ops/graph-file-list.*`, `src/state/kv.ts`, `src/functions/capture.ts`, `src/capture/{review,retry-jobs}.ts`, a shared capture projection helper, and focused capture/reader tests.

## Task 2 — Selected source recovery

- [ ] Reuse existing delivery for selected pending references.
- [ ] Implement explicit held-source claim and restore using `sdk-spool-v2.ts` and `sdk-delivery-v2.ts`; preserve source hashes, owner checks and acknowledgement semantics.
- [ ] Package a standalone operator-imported recovery entry; normal hooks do not invoke it.
- [ ] Test durable intent/response-loss/owner race handling with synthetic sources before operational use.

## Task 3 — Deployment and acceptance

- [ ] Update changelog, generate/check docs and skills, test and build, commit and freeze a separate .60 server-only candidate.
- [ ] Prepare normal .59→.60 deployment with exact previous receipt/code/engine bindings and physical retained-WAL coverage; use safe viewer snapshot preflight rather than .59 `/status`.
- [ ] Run actual generated guard/archive/read-back and normal transaction regressions, review and freeze the administrator enrollment command.
- [ ] After administrator activation, confirm exact .60 generation, resume through the official API, recover selected sources and verify actual SDK approval plus per-item physical indexing.
- [ ] Observe capture/embedding progress, SDK reconnects and service restarts; record implementation, deployment, limits and pending memory review separately.
