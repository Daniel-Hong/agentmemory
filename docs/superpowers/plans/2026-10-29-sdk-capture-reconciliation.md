# Selected SDK capture reconciliation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. This task uses the existing isolated worktree and direct execution, then independent review.

**Goal:** Reconcile an explicitly selected old failed capture only after current canonical/source/index equality, preserving originals and historical failures without replay or false disk proof.

**Architecture:** Add a synchronous bounded index-membership reader and a record-key-exclusive SDK reconciliation operation. Store a resumable SDK resolution in existing review history and retain the original in the existing SDK-completed inbox. No global recovery mode, broad retry, new engine, or operating mutation in development.

**Tech Stack:** Existing TypeScript/ESM, StateKV, keyed recovery gate, Vitest fork pool, installed SDK0.25/native engine0.22.1 for small isolated final integration only.

**Spec:** `../../../../active-summary-projections-release/integrity-audit-preparation/SDK-RECONCILIATION-DESIGN.md`; trusted delegated request 2026-10-29 after the351-record audit.

## Global Constraints

- Product baseline d1e3f442; running .40 remains unchanged. No operating status changes, replay, deletion, budget/circuit reset, registration, deployment, restart or auto-recovery enable.
- All successful resolution responses say completion=sdk, verified=false and synced=false. No legacy disk receipt is fabricated.
- Reconcile only an explicit key/requestId; preserve original payload, failure/request arrays, counters, auto-recovery checkpoints and source restore budgets.
- Current source/identity/fingerprint and BM25/vector session ownership must match under the existing record-exclusive gate, not just a prior offline audit.
- Identity changes, source conflict, writer uncertainty, record mutation, missing index or partial write never become false completion. No model call/observe on the already-complete path.

## Review Focus

1. Partial SDK acknowledgement before/after each resolution write must remain resumable, not erase the historical failure.
2. Concurrent compression/index replacement or a pause during reconciliation must invalidate stale evidence before completion.
3. Old strict clients and old unresolved sources must retain protection; SDK-resolved original restore must validate its exact resolution.
4. A live index membership query proves current Map membership/session only, not source equality, disk storage or a future generation.
5. Historical auto-recovery checkpoints retain attempts/circuit data and are distinguished from current SDK-resolved captures without writing VERIFIED_DURABLE.

## Task1: Bounded current index membership

Files: `src/capture/index-membership.ts`, `test/capture-index-membership.test.ts`, `src/triggers/api.ts`.

Interface: `createCaptureIndexMembership({keyword,vector})` returns a synchronous query accepting1..32 unique observation IDs. Returns ID, boolean membership and hashed session references, process epoch and observation timestamp. It performs no KV/source/provider reads.

- [x] RED: exact membership/session metadata, absent IDs, invalid/duplicate/oversized requests, no raw session/vector output.
- [x] Implement using existing keyword.sessionOf and vector.get, one synchronous read boundary.
- [x] GREEN: focused tests and authenticated readonly endpoint integration.

## Task2: Selected resumable SDK reconciliation

Files: `src/capture/sdk-reconciliation.ts`, `src/capture/sdk-source-restore.ts`, `src/functions/capture.ts`, `src/types.ts`, `src/triggers/api.ts`; focused tests under `test/capture-sdk-reconciliation*.test.ts` and existing capture SDK tests.

Interface: creator receives StateKV and synchronous `indexReady(observation)` plus current admission/clock; operation accepts `{key,requestId,sourceDigest}`. Existing capture controller tracks its work/drain. Only an authenticated explicitly confirmed per-key POST can invoke it.

- [x] RED: exact existing observation/source/marker/index match produces SDK completion with no observe call or original deletion, old failure/request/budget values unchanged.
- [x] RED: wrong source/key/session/event, index missing, deleted receipt, paused/uncertain writer, concurrent change all reject before completion.
- [x] Store a versioned pending SDK resolution intent in review; retain inbox original as SDK-completed; finalize review resolution only after SDK acknowledgement. Preserve all pre-existing failure/counter/request data.
- [x] RED/GREEN: fail before/after each acknowledged write, recreate helper/restart and continue same request without duplicate work; different active request is rejected; committed repeat is verification-only.
- [x] Permit existing limited SDK original restore only for an exact committed SDK-resolution link; unresolved legacy stays blocked.
- [x] Review automatic-recovery presentation. Broad historical-only suppression rejected; preserve existing checkpoint warnings, attempts/reasons/circuit.
- [x] GREEN: focused real gate/StateKV tests and capture/receipt/restore regressions. No policy loosening or assertion removal.

## Task3: SDK integration and final verification

- [x] Independent review of implementation/partial-state compatibility.
- [x] Small synthetic-only isolated SDK0.25/native0.22.1 test: existing capture, explicit reconciliation, normal shutdown/restart, same request, sources/history/budgets preserved. All child HOME/config/storage/ports isolated and logs retained before execution; no actual model.
- [x] Final complete-suite acceptance: build/skills/docs pass. Full run5541pass/13skip/1preflight failure; after host headroom met the unchanged12GiB guard, the previously unstarted boundary fixture passed separately. Combined same-code5542pass/13skip, no remaining failed test; no repeated full run or guard relaxation.
- [x] Report exact operating transition/rollback requirements; do not apply or change operating quarantine. Source and audit originals survive code rollback.

## Self-review

The selected351 audit is current-file evidence, not authority to skip runtime checks. The older4 write failures are invocation counts without a request ledger, and legacy1 is session/end with completed primary state but pending normal enrichment. Neither becomes resolved from this new operation. Actual UI snapshot latency is a separate unresolved read path and is not hidden by this work.

## Final development evidence

Focused141 tests pass; independent review P2 cases reproduced and fixed, no remaining review blocker. Small real SDK0.25/native0.22.1 test passed in24.021s, peakRSS179314688B. All test processes/ports/temp data cleaned, evidence outside cleanup retained. No commit, candidate registration or deployment performed. Final split verification completed as above; operating acceptance remains separate.
